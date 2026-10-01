import { randomUUID } from "node:crypto";
import type { Database, Client } from "../../../../../packages/db/src/index.js";
import type {
  RoomSnapshot,
  RoomCommand,
  RoomReady,
  MediaIdentity,
  CommandAck,
  PlaybackStatusReport,
} from "../../../../../packages/contracts/src/index.js";
import {
  emptyRoom,
  expectedPosition,
  reduceRoom,
  RoomError,
  type Event,
} from "../../../../../packages/room-core/src/index.js";
import type { Identity } from "../auth/service.js";
import type { LibraryService } from "../library/service.js";
import { hash, token } from "../../infrastructure/secrets.js";
import { assert, AppError } from "../../infrastructure/errors.js";
import { Limiter } from "../../infrastructure/limits.js";
export class RoomService {
  readonly instanceId = randomUUID();
  private epoch = Date.now() - performance.now();
  readonly limits = new Limiter();
  broadcast: (s: RoomSnapshot) => void = () => {};
  revokeLease: (userId: string) => void = () => {};
  private lockClient?: Client;
  private readySince = new Map<string, number>();
  private lastCheckpointAt = 0;
  constructor(
    public db: Database,
    public library: LibraryService,
  ) {}
  now = () => this.epoch + performance.now();
  async initialize() {
    this.lockClient = await this.db.pool.connect();
    const result = await this.lockClient.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(173004) AS locked",
    );
    assert(result.rows[0].locked, "ROOM_INSTANCE_EXISTS", 503);
    await this.db.transaction(async (c) => {
      const s = await this.load(c);
      if (s.sessionId) {
        const n = reduceRoom(
          s,
          { type: "restart", serverInstanceId: this.instanceId },
          this.context(s),
        );
        await this.save(n, s, c);
      }
      await c.query("UPDATE playback_leases SET revoked_at=now()");
    });
  }
  async close() {
    if (this.lockClient) {
      await this.lockClient.query("SELECT pg_advisory_unlock(173004)");
      this.lockClient.release();
      this.lockClient = undefined;
    }
  }
  private context(s: RoomSnapshot, actorUserId?: string) {
    return {
      now: this.now(),
      barrierId: randomUUID(),
      actorUserId,
      activeUserIds: s.expectedUserIds,
      hostPresent: s.participants.some(
        (p) => p.userId === s.hostUserId && p.status !== "away",
      ),
    };
  }
  async load(c?: Client, lock = false) {
    const [r] = await this.db.query<{
      id: string;
      active_session_id: string | null;
      revision: string;
    }>(
      "SELECT * FROM rooms WHERE singleton_key=$1" +
        (lock ? " FOR UPDATE" : ""),
      ["home"],
      c,
    );
    assert(r, "ROOM_NOT_INITIALIZED", 503);
    let s: RoomSnapshot;
    if (r.active_session_id) {
      const [v] = await this.db.query<{ state_json: RoomSnapshot }>(
        "SELECT state_json FROM viewing_sessions WHERE id=$1",
        [r.active_session_id],
        c,
      );
      assert(v, "INTERNAL_ERROR", 500);
      s = v.state_json;
    } else s = emptyRoom(r.id, this.instanceId, Number(r.revision));
    const participants = await this.db.query<{
      id: string;
      display_name: string;
      status: string | null;
    }>(
      "SELECT u.id,u.display_name,CASE WHEN l.expires_at>now() AND l.revoked_at IS NULL AND l.session_id IS NOT DISTINCT FROM $1::uuid THEN l.status ELSE NULL END AS status FROM users u LEFT JOIN playback_leases l ON l.user_id=u.id WHERE u.disabled_at IS NULL ORDER BY u.slot",
      [s.sessionId],
      c,
    );
    s = structuredClone(s);
    s.serverInstanceId = this.instanceId;
    s.participants = participants.map((p) => ({
      userId: p.id,
      displayName: p.display_name,
      status: (p.status ??
        "away") as RoomSnapshot["participants"][number]["status"],
      expectedForPlayback:
        s.expectedUserIds.includes(p.id) &&
        !s.temporarilyExcludedUserIds.includes(p.id),
      isHost: p.id === s.hostUserId,
    }));
    return s;
  }
  async snapshot() {
    return this.load();
  }
  async save(next: RoomSnapshot, previous: RoomSnapshot, c: Client) {
    if (next.barrier && next.barrier.barrierId !== previous.barrier?.barrierId)
      await c.query(
        "UPDATE playback_leases SET status='present',last_report_json='{}' WHERE room_id=$1 AND revoked_at IS NULL AND expires_at>now()",
        [next.roomId],
      );
    if (previous.media && previous.sessionId) {
      const currentContent =
        next.sessionId === previous.sessionId &&
        next.media?.mediaId === previous.media.mediaId &&
        next.media.contentGeneration === previous.media.contentGeneration;
      const progress = currentContent ? next : previous;
      const position = expectedPosition(progress, this.now());
      await c.query(
        "INSERT INTO shared_progress(media_id,content_generation,position_seconds,viewing_session_id,completed_at) VALUES($1,$2,$3,$4,CASE WHEN $5 THEN now() ELSE NULL END) ON CONFLICT(media_id,content_generation) DO UPDATE SET position_seconds=excluded.position_seconds,completed_at=coalesce(shared_progress.completed_at,excluded.completed_at),viewing_session_id=excluded.viewing_session_id,updated_at=now()",
        [
          previous.media.mediaId,
          previous.media.contentGeneration,
          position,
          previous.sessionId,
          progress.phase === "ended",
        ],
      );
    }
    if (next.sessionId)
      await c.query(
        "UPDATE viewing_sessions SET state_json=$1,host_user_id=$2,host_epoch=$3,last_checkpoint_position=$4 WHERE id=$5",
        [
          next,
          next.hostUserId,
          next.hostEpoch,
          next.anchorPositionSeconds,
          next.sessionId,
        ],
      );
    else if (previous.sessionId) {
      await c.query("UPDATE viewing_sessions SET ended_at=now() WHERE id=$1", [
        previous.sessionId,
      ]);
      await c.query(
        "UPDATE playback_leases SET revoked_at=now() WHERE session_id=$1",
        [previous.sessionId],
      );
    }
    await c.query(
      "UPDATE rooms SET revision=$1,active_session_id=$2 WHERE id=$3",
      [next.revision, next.sessionId, next.roomId],
    );
  }
  async start(i: Identity, mediaId: string, personalPosition?: number) {
    const result = await this.db.transaction(async (c) => {
      const old = await this.load(c, true);
      if (old.sessionId) return old;
      const m = await this.library.published(mediaId, c);
      assert(m.duration_seconds > 0, "MEDIA_UNAVAILABLE", 409);
      const [shared] = await this.db.query<{ position_seconds: number }>(
        "SELECT position_seconds FROM shared_progress WHERE media_id=$1 AND content_generation=$2",
        [m.id, m.content_generation],
        c,
      );
      const media: MediaIdentity = {
        mediaId: m.id,
        sourceId: m.primary_source_id!,
        contentGeneration: m.content_generation,
        title: m.title,
        durationSeconds: m.duration_seconds,
      };
      const position = Math.min(
        personalPosition ?? shared?.position_seconds ?? 0,
        m.duration_seconds,
      );
      const next = {
        ...old,
        sessionId: randomUUID(),
        hostUserId: i.user.id,
        hostEpoch: old.hostEpoch + 1,
        revision: old.revision + 1,
        media,
        phase:
          position >= m.duration_seconds
            ? ("ended" as const)
            : ("paused" as const),
        expectedUserIds: old.participants.map((p) => p.userId),
        anchorPositionSeconds: position,
        anchorServerTimeMs: this.now(),
      };
      await c.query(
        "INSERT INTO viewing_sessions(id,room_id,state_json,host_user_id,host_epoch,last_checkpoint_position) VALUES($1,$2,$3,$4,$5,$6)",
        [
          next.sessionId,
          next.roomId,
          next,
          next.hostUserId,
          next.hostEpoch,
          next.anchorPositionSeconds,
        ],
      );
      await this.save(next, old, c);
      return next;
    });
    await this.db.afterCommit(() => this.broadcast(result));
    return result;
  }
  async lease(
    i: Identity,
    clientInstanceId: string,
    takeover = false,
    existing?: string,
  ) {
    const result = await this.db.transaction(async (c) => {
      const s = await this.load(c, true);
      await c.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [i.user.id]);
      const [old] = await this.db.query<{
        client_instance_id: string;
        lease_hash: string;
        auth_session_id: string;
        expires_at: Date;
        revoked_at: Date | null;
      }>("SELECT * FROM playback_leases WHERE user_id=$1", [i.user.id], c);
      const valid =
        old &&
        !old.revoked_at &&
        new Date(old.expires_at).getTime() > Date.now();
      assert(
        !valid ||
          (old.client_instance_id === clientInstanceId &&
            existing &&
            old.lease_hash === hash(existing)) ||
          takeover,
        "DEVICE_ACTIVE",
        409,
      );
      const raw = valid && !takeover ? existing! : token();
      if (takeover)
        await this.db.afterCommit(() => this.revokeLease(i.user.id));
      await c.query(
        "INSERT INTO playback_leases(user_id,room_id,session_id,auth_session_id,lease_hash,client_instance_id,expires_at,status) VALUES($1,$2,$3,$4,$5,$6,now()+interval '15 seconds','present') ON CONFLICT(user_id) DO UPDATE SET room_id=excluded.room_id,session_id=excluded.session_id,auth_session_id=excluded.auth_session_id,lease_hash=excluded.lease_hash,client_instance_id=excluded.client_instance_id,expires_at=excluded.expires_at,revoked_at=NULL,status='present',last_report_json='{}'",
        [
          i.user.id,
          s.roomId,
          s.sessionId,
          i.session.id,
          hash(raw),
          clientInstanceId,
        ],
      );
      const n = reduceRoom(
        s,
        { type: "join", userId: i.user.id },
        this.context(s),
      );
      if (n.revision !== s.revision) await this.save(n, s, c);
      return { ownLeaseId: raw, ownLeaseExpiresAtServerMs: this.now() + 15000 };
    });
    const snapshot = await this.snapshot();
    await this.db.afterCommit(() => this.broadcast(snapshot));
    return { ...result, snapshot };
  }
  async validateLease(i: Identity, raw: string, s: RoomSnapshot, c?: Client) {
    const [l] = await this.db.query<{ user_id: string }>(
      "SELECT user_id FROM playback_leases WHERE user_id=$1 AND lease_hash=$2 AND auth_session_id=$3 AND session_id IS NOT DISTINCT FROM $4::uuid AND room_id=$5 AND revoked_at IS NULL AND expires_at>now()",
      [i.user.id, hash(raw), i.session.id, s.sessionId, s.roomId],
      c,
    );
    assert(l, "LEASE_REVOKED", 403);
  }
  async heartbeat(i: Identity, raw: string) {
    const s = await this.snapshot();
    await this.validateLease(i, raw, s);
    await this.db.query(
      "UPDATE playback_leases SET expires_at=now()+interval '15 seconds' WHERE user_id=$1 AND lease_hash=$2",
      [i.user.id, hash(raw)],
    );
    return { snapshot: s, expiresAtServerMs: this.now() + 15000 };
  }
  async command(i: Identity, b: RoomCommand): Promise<CommandAck> {
    this.limits.check(`command:${b.leaseId}`, 10, 1000);
    const result = await this.db.transaction(async (c) => {
      const s = await this.load(c, true);
      await this.validateLease(i, b.leaseId, s, c);
      const payload = hash(JSON.stringify(b));
      const [receipt] = await this.db.query<{
        payload_hash: string;
        result_json: CommandAck;
      }>(
        "SELECT payload_hash,result_json FROM command_receipts WHERE actor_user_id=$1 AND command_id=$2",
        [i.user.id, b.commandId],
        c,
      );
      if (receipt) {
        assert(receipt.payload_hash === payload, "IDEMPOTENCY_CONFLICT", 409);
        return { ...receipt.result_json, snapshot: s };
      }
      assert(
        b.roomId === s.roomId && b.sessionId === s.sessionId,
        "STALE_SESSION",
        409,
      );
      assert(
        b.contentGeneration === s.media?.contentGeneration,
        "STALE_CONTENT",
        409,
      );
      assert(b.expectedHostEpoch === s.hostEpoch, "STALE_HOST_EPOCH", 409);
      assert(b.expectedRevision === s.revision, "STALE_REVISION", 409);
      let media: MediaIdentity | undefined;
      if (b.action.type === "CHANGE_MEDIA") {
        const m = await this.library.published(b.action.mediaId, c);
        media = {
          mediaId: m.id,
          sourceId: m.primary_source_id!,
          contentGeneration: m.content_generation,
          title: m.title,
          durationSeconds: m.duration_seconds,
        };
      } else if (b.action.type === "PLAY" && s.media) {
        const current = await this.library.published(s.media.mediaId, c);
        assert(
          current.content_generation === s.media.contentGeneration &&
            current.primary_source_id === s.media.sourceId,
          "STALE_CONTENT",
          409,
        );
      }
      const n = reduceRoom(
        s,
        { type: "command", action: b.action },
        { ...this.context(s, i.user.id), media },
      );
      await this.save(n, s, c);
      const ack: CommandAck = {
        commandId: b.commandId,
        accepted: true,
        code: "OK",
        revision: n.revision,
        snapshot: n,
      };
      await c.query(
        "INSERT INTO command_receipts(actor_user_id,command_id,payload_hash,session_id,accepted_revision,result_json) VALUES($1,$2,$3,$4,$5,$6)",
        [i.user.id, b.commandId, payload, b.sessionId, n.revision, ack],
      );
      return ack;
    });
    if (result.snapshot) {
      const snapshot = result.snapshot;
      await this.db.afterCommit(() => this.broadcast(snapshot));
    }
    return result;
  }
  async ready(i: Identity, b: RoomReady) {
    let notify = false;
    const result = await this.db.transaction(async (c) => {
      const s = await this.load(c, true);
      await this.validateLease(i, b.leaseId, s, c);
      assert(
        s.sessionId === b.sessionId &&
          s.media?.contentGeneration === b.contentGeneration,
        "STALE_CONTENT",
        409,
      );
      if (!s.barrier || s.barrier.barrierId !== b.barrierId) return s;
      if (Math.abs(s.media.durationSeconds - b.durationSeconds) > 1) {
        notify = true;
        const n = reduceRoom(s, { type: "unavailable" }, this.context(s));
        n.blockReason = "SOURCE_UNSUPPORTED";
        await this.save(n, s, c);
        return n;
      }
      const target = s.barrier.targetPositionSeconds;
      assert(
        Math.abs(b.actualPositionSeconds - target) <= 0.25 &&
          b.readyState >= 3 &&
          !b.needsGesture &&
          b.bufferedAheadSeconds >=
            Math.min(2, Math.max(0, b.durationSeconds - target) - 0.1),
        "PARTNER_NOT_READY",
        409,
      );
      const key = `${i.user.id}:${b.barrierId}`;
      if (s.blockReason === "BUFFERING") {
        const since = this.readySince.get(key);
        if (!since) {
          this.readySince.set(key, this.now());
          return s;
        }
        if (this.now() - since < 500) return s;
      }
      notify = s.participants.some(
        (participant) =>
          participant.userId === i.user.id && participant.status !== "ready",
      );
      await c.query(
        "UPDATE playback_leases SET status='ready',last_report_json=$1 WHERE user_id=$2",
        [{ barrierId: b.barrierId }, i.user.id],
      );
      s.participants = s.participants.map((p) =>
        p.userId === i.user.id ? { ...p, status: "ready" } : p,
      );
      const n = reduceRoom(
        s,
        { type: "ready", userId: i.user.id, barrierId: b.barrierId },
        this.context(s),
      );
      if (n.revision !== s.revision) {
        notify = true;
        await c.query(
          "UPDATE playback_leases SET status='playing' WHERE room_id=$1 AND revoked_at IS NULL AND status='ready'",
          [s.roomId],
        );
        await this.save(n, s, c);
        this.readySince.clear();
      }
      return n;
    });
    if (notify) await this.db.afterCommit(() => this.broadcast(result));
    return result;
  }
  async status(i: Identity, b: PlaybackStatusReport) {
    const s = await this.snapshot();
    await this.validateLease(i, b.leaseId, s);
    assert(
      s.sessionId === b.sessionId &&
        s.media?.contentGeneration === b.contentGeneration,
      "STALE_CONTENT",
      409,
    );
    await this.db.query(
      "UPDATE playback_leases SET status=$1,last_report_json=$2 WHERE user_id=$3",
      [b.status, b, i.user.id],
    );
    if (b.status === "error") await this.event({ type: "unavailable" });
    else if (b.status === "ended") await this.event({ type: "ended" });
    else if (b.status === "needsGesture" || b.status === "paused")
      await this.event({
        type: "block",
        userId: i.user.id,
        reason: "AUTOPLAY_BLOCKED",
      });
    else if (b.status === "buffering") {
      const key = `buffer:${i.user.id}`;
      if (!this.readySince.has(key)) this.readySince.set(key, this.now());
      if (this.now() - this.readySince.get(key)! >= 750)
        await this.event({
          type: "block",
          userId: i.user.id,
          reason: "BUFFERING",
        });
    } else this.readySince.delete(`buffer:${i.user.id}`);
    return { ok: true };
  }
  async event(event: Event) {
    const n = await this.db.transaction(async (c) => {
      const s = await this.load(c, true);
      const result = reduceRoom(s, event, this.context(s));
      if (result.revision !== s.revision) await this.save(result, s, c);
      return result;
    });
    await this.db.afterCommit(() => this.broadcast(n));
    return n;
  }
  async leave(i: Identity, raw: string) {
    const s = await this.snapshot();
    await this.validateLease(i, raw, s);
    await this.db.query(
      "UPDATE playback_leases SET status='away',revoked_at=now() WHERE user_id=$1",
      [i.user.id],
    );
    await this.event({
      type: "block",
      userId: i.user.id,
      reason: "WAITING_FOR_PARTNER",
    });
  }
  async tick() {
    const s = await this.snapshot();
    if (s.sessionId && s.media) {
      if (s.phase === "playing") {
        if (this.now() - this.lastCheckpointAt >= 5000)
          await this.db.transaction(async (c) => {
            const current = await this.load(c, true);
            if (
              current.phase !== "playing" ||
              this.now() < current.anchorServerTimeMs
            )
              return;
            const pos = expectedPosition(current, this.now());
            const checkpoint = {
              ...current,
              anchorPositionSeconds: pos,
              anchorServerTimeMs: this.now(),
            };
            await this.save(checkpoint, current, c);
            this.lastCheckpointAt = this.now();
          });
        if (expectedPosition(s, this.now()) >= s.media.durationSeconds - 0.25)
          await this.event({ type: "ended" });
      }
      if (s.desiredPlayback === "playing" && s.waitTogether)
        for (const id of s.expectedUserIds.filter(
          (id) => !s.temporarilyExcludedUserIds.includes(id),
        )) {
          if (
            !s.participants.some((p) => p.userId === id && p.status !== "away")
          ) {
            await this.event({
              type: "block",
              userId: id,
              reason: "WAITING_FOR_PARTNER",
            });
            break;
          }
        }
    }
  }
  errorAck(b: RoomCommand, error: unknown, s: RoomSnapshot): CommandAck {
    return {
      commandId: b.commandId,
      accepted: false,
      code: (error instanceof AppError || error instanceof RoomError
        ? error.code
        : "INTERNAL_ERROR") as CommandAck["code"],
      revision: s.revision,
      snapshot: s,
    };
  }
}

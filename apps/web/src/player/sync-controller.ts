import { ApiError } from "../app/api";
import type { Socket } from "socket.io-client";
import type {
  RoomSnapshot,
  PlaybackStatusReport,
} from "../../../../packages/contracts/src/protocol";
import {
  expectedPosition,
  correction,
  clockOffset,
  type ClockSample,
} from "../../../../packages/room-core/src/index";
import type { EngineAdapter } from "./engines";
export function emitAck<T>(
  socket: Socket,
  event: string,
  payload: unknown,
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!socket.connected) {
      reject(new ApiError("RECONNECTING"));
      return;
    }
    socket
      .timeout(3000)
      .emit(
        event,
        payload,
        (
          err: Error | null,
          result: { ok: boolean; code?: string; result: T },
        ) => {
          if (err) reject(err);
          else if (!result.ok)
            reject(new ApiError(result.code ?? "INTERNAL_ERROR"));
          else resolve(result.result);
        },
      );
  });
}
export class SyncController {
  snapshot: RoomSnapshot | null = null;
  engine: EngineAdapter | null = null;
  activated = false;
  offset = 0;
  calibrated = false;
  settleUntil = 0;
  private playingRequest = false;
  private lastStatus = "";
  private lastStatusAt = 0;
  private detachPause?: () => void;
  private detachError?: () => void;
  private detachWaiting?: () => void;
  private applications: { kind: "pause"; expires: number }[] = [];
  private readyInFlight = false;
  private lastReadyAt = -Infinity;
  private timer: ReturnType<typeof setInterval>;
  private calibration: ReturnType<typeof setInterval>;
  constructor(
    private socket: Socket,
    private lease: () => string,
    private reportError: (e: unknown) => void,
    private needsActivation: () => void = () => {},
    private userId?: string,
  ) {
    this.timer = setInterval(() => this.tick(), 500);
    this.calibration = setInterval(
      () => void this.calibrate().catch(reportError),
      30000,
    );
  }
  now() {
    return performance.now() + this.offset;
  }
  diagnostics() {
    return {
      socketConnected: this.socket.connected,
      clockCalibrated: this.calibrated,
      state: this.snapshot?.phase ?? "empty",
      revision: this.snapshot?.revision ?? 0,
      drift:
        this.snapshot && this.engine
          ? expectedPosition(this.snapshot, this.now()) -
            this.engine.getPosition()
          : "—",
    };
  }
  async calibrate() {
    const samples: ClockSample[] = [];
    for (let i = 0; i < 5; i++) {
      const clientSend = performance.now();
      const pong = await emitAck<{
        serverReceiveMs: number;
        serverSendMs: number;
      }>(this.socket, "clock:ping", { clientSendMonotonicMs: clientSend });
      samples.push({
        clientSend,
        clientReceive: performance.now(),
        serverReceive: pong.serverReceiveMs,
        serverSend: pong.serverSendMs,
      });
    }
    this.offset = clockOffset(samples);
    this.calibrated = true;
  }
  update(s: RoomSnapshot) {
    if (
      this.snapshot &&
      s.serverInstanceId === this.snapshot.serverInstanceId &&
      s.revision < this.snapshot.revision
    )
      return;
    const instanceChanged =
      this.snapshot && this.snapshot.serverInstanceId !== s.serverInstanceId;
    this.snapshot = s;
    if (instanceChanged) {
      this.calibrated = false;
      void this.calibrate().catch(this.reportError);
    }
    this.tick();
  }
  attach(e: EngineAdapter | null) {
    this.detachPause?.();
    this.detachError?.();
    this.detachWaiting?.();
    this.engine = e;
    if (e) this.detachError = e.on("error", () => this.status("error"));
    if (e)
      this.detachWaiting = e.on("waiting", () => {
        if (
          this.snapshot?.phase === "playing" &&
          this.activated &&
          !e.video.ended
        )
          this.status("buffering");
      });
    if (e)
      this.detachPause = e.on("pause", () => {
        const now = performance.now();
        this.applications = this.applications.filter(
          (action) => action.expires > now,
        );
        const applied = this.applications.findIndex(
          (action) => action.kind === "pause",
        );
        if (applied >= 0) {
          this.applications.splice(applied, 1);
          return;
        }
        if (
          this.snapshot?.phase === "playing" &&
          this.now() >= this.snapshot.anchorServerTimeMs &&
          this.socket.connected &&
          !e.video.ended
        ) {
          this.activated = false;
          this.needsActivation();
          this.status("paused");
        }
      });
    this.settleUntil = 0;
    this.tick();
  }
  async activate() {
    if (!this.engine) return;
    try {
      await this.engine.play();
      this.activated = true;
      if (this.snapshot?.phase !== "playing") this.applyPause();
      this.tick();
    } catch (e) {
      this.activated = false;
      this.needsActivation();
      this.reportError(e);
      this.status("needsGesture");
    }
  }
  disconnected() {
    this.calibrated = false;
    this.applyPause();
  }
  private applyPause() {
    if (this.engine && !this.engine.video.paused) {
      this.applications.push({
        kind: "pause",
        expires: performance.now() + 1000,
      });
      this.engine.pause();
    }
  }
  status(status: PlaybackStatusReport["status"]) {
    const s = this.snapshot,
      e = this.engine;
    if (!s?.sessionId || !s.media || !e || !this.socket.connected) return;
    const now = performance.now();
    if (
      status === this.lastStatus &&
      now - this.lastStatusAt < (status === "buffering" ? 500 : 1000)
    )
      return;
    this.lastStatus = status;
    this.lastStatusAt = now;
    const body: PlaybackStatusReport = {
      protocolVersion: 1,
      roomId: s.roomId,
      sessionId: s.sessionId,
      leaseId: this.lease(),
      contentGeneration: s.media.contentGeneration,
      status,
      actualPositionSeconds: e.getPosition(),
      bufferedAheadSeconds: e.getBuffered(),
      readyState: e.video.readyState,
    };
    void emitAck(this.socket, "room:playback-status", body).catch(() => {});
  }
  tick() {
    const s = this.snapshot,
      e = this.engine;
    if (
      !s?.media ||
      !e ||
      !this.socket.connected ||
      !this.calibrated ||
      !Number.isFinite(e.getDuration())
    )
      return;
    const now = this.now();
    const target = expectedPosition(s, now),
      error = target - e.getPosition();
    if (s.phase !== "playing" || now < s.anchorServerTimeMs) {
      this.applyPause();
      if (Math.abs(error) > 0.15 && performance.now() > this.settleUntil) {
        e.seek(target);
        this.settleUntil = performance.now() + 750;
      }
      e.setRate(s.baseRate);
      if (
        s.barrier &&
        this.activated &&
        Math.abs(error) <= 0.25 &&
        e.video.readyState >= 3 &&
        e.getBuffered() >=
          Math.min(2, Math.max(0, e.getDuration() - target) - 0.1)
      ) {
        if (
          this.readyInFlight ||
          performance.now() - this.lastReadyAt < 500 ||
          s.participants.some(
            (participant) =>
              participant.userId === this.userId &&
              participant.status === "ready",
          )
        )
          return;
        this.readyInFlight = true;
        this.lastReadyAt = performance.now();
        void emitAck(this.socket, "room:ready", {
          protocolVersion: 1,
          roomId: s.roomId,
          sessionId: s.sessionId,
          leaseId: this.lease(),
          barrierId: s.barrier.barrierId,
          contentGeneration: s.media.contentGeneration,
          actualPositionSeconds: e.getPosition(),
          durationSeconds: e.getDuration(),
          bufferedAheadSeconds: e.getBuffered(),
          readyState: e.video.readyState,
          needsGesture: false,
        })
          .catch(() => {})
          .finally(() => {
            this.readyInFlight = false;
          });
      } else if (s.desiredPlayback === "playing" && !this.activated)
        this.status("needsGesture");
      return;
    }
    if (!this.activated) {
      this.status("needsGesture");
      return;
    }
    if (e.video.ended && target >= e.getDuration() - 0.25) {
      this.status("ended");
      return;
    }
    if (
      e.video.readyState < 3 ||
      (e.getBuffered() < 0.2 && target < e.getDuration() - 0.3)
    ) {
      this.status("buffering");
      return;
    }
    if (performance.now() > this.settleUntil) {
      const action = correction(error, s.baseRate);
      if (action.seek) {
        e.seek(target);
        this.settleUntil = performance.now() + 750;
      }
      e.setRate(action.rate);
    }
    if (e.video.paused && !this.playingRequest) {
      // Starting a paused engine must use the current authoritative position,
      // rather than applying steady-play drift correction to its stale frame.
      if (Math.abs(error) > 0.03) {
        e.seek(target);
        this.settleUntil = performance.now() + 750;
      }
      e.setRate(s.baseRate);
      this.playingRequest = true;
      void e
        .play()
        .catch((err) => {
          this.activated = false;
          this.needsActivation();
          this.reportError(err);
          this.status("needsGesture");
        })
        .finally(() => {
          this.playingRequest = false;
        });
    } else this.status("playing");
  }
  destroy() {
    clearInterval(this.timer);
    clearInterval(this.calibration);
    this.detachPause?.();
    this.applyPause();
    this.detachError?.();
    this.detachWaiting?.();
    this.engine = null;
  }
}

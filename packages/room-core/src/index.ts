import type {
  RoomSnapshot,
  RoomAction,
  MediaIdentity,
  ErrorCode,
} from "../../contracts/src/index.js";
export class RoomError extends Error {
  constructor(public code: ErrorCode) {
    super(code);
  }
}
export interface Context {
  now: number;
  barrierId: string;
  actorUserId?: string;
  activeUserIds: string[];
  hostPresent: boolean;
  media?: MediaIdentity;
  startDelayMs?: number;
}
export type Event =
  | { type: "command"; action: RoomAction }
  | { type: "ready"; userId: string; barrierId: string }
  | {
      type: "block";
      userId: string;
      reason: "BUFFERING" | "AUTOPLAY_BLOCKED" | "WAITING_FOR_PARTNER";
    }
  | { type: "join"; userId: string }
  | { type: "restart"; serverInstanceId: string }
  | { type: "unavailable" }
  | { type: "ended" };
export function expectedPosition(s: RoomSnapshot, now: number) {
  const position =
    s.anchorPositionSeconds +
    (s.phase === "playing"
      ? (Math.max(0, now - s.anchorServerTimeMs) / 1000) * s.baseRate
      : 0);
  return Math.max(0, Math.min(position, s.media?.durationSeconds ?? 0));
}
export function emptyRoom(
  roomId: string,
  serverInstanceId: string,
  revision = 0,
): RoomSnapshot {
  return {
    protocolVersion: 1,
    roomId,
    sessionId: null,
    serverInstanceId,
    revision,
    hostUserId: null,
    hostEpoch: 0,
    media: null,
    phase: "empty",
    desiredPlayback: "paused",
    anchorPositionSeconds: 0,
    anchorServerTimeMs: 0,
    baseRate: 1,
    waitTogether: true,
    expectedUserIds: [],
    temporarilyExcludedUserIds: [],
    barrier: null,
    blockReason: null,
    participants: [],
  };
}
function prepare(
  s: RoomSnapshot,
  c: Context,
  reason: RoomSnapshot["blockReason"] = null,
) {
  const required = s.waitTogether
    ? s.expectedUserIds.filter(
        (id) => !s.temporarilyExcludedUserIds.includes(id),
      )
    : s.expectedUserIds.filter((id) =>
        s.participants.some((p) => p.userId === id && p.status !== "away"),
      );
  if (!required.includes(s.hostUserId!)) required.push(s.hostUserId!);
  s.phase = reason ? "blocked" : "preparing";
  s.blockReason = reason;
  s.barrier = {
    barrierId: c.barrierId,
    contentGeneration: s.media!.contentGeneration,
    targetPositionSeconds: s.anchorPositionSeconds,
    requiredUserIds: required,
  };
  s.participants = s.participants.map((p) => ({
    ...p,
    status: p.status === "away" ? "away" : "present",
  }));
}
export function reduceRoom(
  original: RoomSnapshot,
  event: Event,
  c: Context,
): RoomSnapshot {
  const s = structuredClone(original);
  if (event.type === "restart") {
    s.anchorPositionSeconds = original.anchorPositionSeconds;
    s.anchorServerTimeMs = c.now;
    s.phase = s.media ? "paused" : "empty";
    s.desiredPlayback = "paused";
    s.barrier = null;
    s.blockReason = null;
    s.serverInstanceId = event.serverInstanceId;
    s.participants = s.participants.map((p) => ({ ...p, status: "away" }));
    s.revision++;
    return s;
  }
  if (event.type === "join") {
    if (
      s.media &&
      s.desiredPlayback === "playing" &&
      (s.temporarilyExcludedUserIds.includes(event.userId) ||
        !s.expectedUserIds.includes(event.userId) ||
        s.participants.find((p) => p.userId === event.userId)?.status ===
          "away")
    ) {
      s.anchorPositionSeconds = expectedPosition(original, c.now);
      s.anchorServerTimeMs = c.now;
      s.expectedUserIds = [...new Set([...s.expectedUserIds, event.userId])];
      s.temporarilyExcludedUserIds = s.temporarilyExcludedUserIds.filter(
        (id) => id !== event.userId,
      );
      prepare(s, c);
      s.revision++;
    }
    return s;
  }
  if (event.type === "unavailable") {
    if (!s.media) return s;
    s.anchorPositionSeconds = expectedPosition(original, c.now);
    s.anchorServerTimeMs = c.now;
    s.phase = "blocked";
    s.desiredPlayback = "paused";
    s.blockReason = "MEDIA_UNAVAILABLE";
    s.barrier = null;
    s.revision++;
    return s;
  }
  if (event.type === "ended") {
    if (
      !s.media ||
      s.phase !== "playing" ||
      expectedPosition(s, c.now) < s.media.durationSeconds - 0.25
    )
      return s;
    s.anchorPositionSeconds = s.media.durationSeconds;
    s.anchorServerTimeMs = c.now;
    s.phase = "ended";
    s.desiredPlayback = "paused";
    s.barrier = null;
    s.revision++;
    return s;
  }
  if (event.type === "block") {
    if (
      !s.media ||
      s.desiredPlayback !== "playing" ||
      !s.waitTogether ||
      s.temporarilyExcludedUserIds.includes(event.userId)
    )
      return s;
    if (s.barrier && s.phase === "blocked" && s.blockReason === event.reason)
      return s;
    s.anchorPositionSeconds = expectedPosition(original, c.now);
    s.anchorServerTimeMs = c.now;
    prepare(s, c, event.reason);
    s.revision++;
    return s;
  }
  if (event.type === "ready") {
    if (
      !s.barrier ||
      s.barrier.barrierId !== event.barrierId ||
      s.desiredPlayback !== "playing" ||
      !s.barrier.requiredUserIds.includes(event.userId)
    )
      return s;
    s.participants = s.participants.map((p) =>
      p.userId === event.userId ? { ...p, status: "ready" } : p,
    );
    if (
      s.barrier.requiredUserIds.every((id) =>
        s.participants.some((p) => p.userId === id && p.status === "ready"),
      )
    ) {
      s.phase = "playing";
      s.blockReason = null;
      s.anchorServerTimeMs =
        c.now + Math.max(300, Math.min(1000, c.startDelayMs ?? 300));
      s.barrier = null;
      s.revision++;
    }
    return s;
  }
  const a = event.action;
  if (!s.sessionId || !s.media) throw new RoomError("STALE_SESSION");
  if (a.type === "CLAIM_HOST") {
    if (c.hostPresent) throw new RoomError("HOST_STILL_PRESENT");
    s.hostUserId = c.actorUserId!;
    s.hostEpoch++;
    s.participants = s.participants.map((p) => ({
      ...p,
      isHost: p.userId === s.hostUserId,
    }));
    s.revision++;
    return s;
  }
  if (c.actorUserId !== s.hostUserId) throw new RoomError("NOT_HOST");
  s.anchorPositionSeconds = expectedPosition(original, c.now);
  s.anchorServerTimeMs = c.now;
  switch (a.type) {
    case "PLAY":
      if (s.phase === "ended") s.anchorPositionSeconds = 0;
      s.desiredPlayback = "playing";
      prepare(s, c);
      break;
    case "PAUSE":
      s.desiredPlayback = "paused";
      s.phase = "paused";
      s.barrier = null;
      s.blockReason = null;
      break;
    case "SEEK":
      if (
        !Number.isFinite(a.positionSeconds) ||
        a.positionSeconds < 0 ||
        a.positionSeconds > s.media.durationSeconds
      )
        throw new RoomError("INVALID_RANGE");
      s.anchorPositionSeconds = a.positionSeconds;
      if (s.desiredPlayback === "playing") prepare(s, c);
      else {
        s.phase = "paused";
        s.barrier = null;
        s.blockReason = null;
      }
      break;
    case "SET_RATE":
      if (![0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].includes(a.rate))
        throw new RoomError("SOURCE_UNSUPPORTED");
      s.baseRate = a.rate;
      break;
    case "TRANSFER_HOST":
      if (
        a.targetUserId === s.hostUserId ||
        !s.participants.some(
          (p) => p.userId === a.targetUserId && p.status !== "away",
        )
      )
        throw new RoomError("PARTNER_NOT_READY");
      s.hostUserId = a.targetUserId;
      s.hostEpoch++;
      s.participants = s.participants.map((p) => ({
        ...p,
        isHost: p.userId === a.targetUserId,
      }));
      break;
    case "CHANGE_MEDIA":
      if (!c.media) throw new RoomError("MEDIA_UNAVAILABLE");
      s.media = c.media;
      s.anchorPositionSeconds = 0;
      s.baseRate = 1;
      s.phase = "paused";
      s.desiredPlayback = "paused";
      s.barrier = null;
      s.blockReason = null;
      s.temporarilyExcludedUserIds = [];
      break;
    case "SET_WAIT_TOGETHER":
      s.waitTogether = a.enabled;
      if (s.desiredPlayback === "playing") prepare(s, c);
      break;
    case "CONTINUE_WITHOUT_WAITING":
      s.temporarilyExcludedUserIds = s.expectedUserIds.filter(
        (id) =>
          id !== s.hostUserId &&
          !s.participants.some((p) => p.userId === id && p.status === "ready"),
      );
      s.desiredPlayback = "playing";
      prepare(s, c);
      break;
    case "END_SESSION":
      return {
        ...emptyRoom(s.roomId, s.serverInstanceId, s.revision + 1),
        participants: s.participants.map((p) => ({ ...p, isHost: false })),
        hostEpoch: s.hostEpoch,
      };
  }
  s.revision++;
  return s;
}
export interface ClockSample {
  clientSend: number;
  clientReceive: number;
  serverReceive: number;
  serverSend: number;
}
export function clockOffset(samples: ClockSample[]) {
  const values = samples
    .map((v) => ({
      rtt: v.clientReceive - v.clientSend - (v.serverSend - v.serverReceive),
      offset:
        (v.serverReceive - v.clientSend + (v.serverSend - v.clientReceive)) / 2,
    }))
    .filter((v) => v.rtt >= 0 && v.rtt < 5000)
    .sort((a, b) => a.rtt - b.rtt)
    .slice(0, 3);
  if (!values.length) throw new Error("No valid clock samples");
  return values.map((v) => v.offset).sort((a, b) => a - b)[
    Math.floor(values.length / 2)
  ];
}
export function correction(
  errorSeconds: number,
  base: number,
): { seek: boolean; rate: number } {
  if (Math.abs(errorSeconds) <= 0.15) return { seek: false, rate: base };
  if (Math.abs(errorSeconds) > 0.8) return { seek: true, rate: base };
  return {
    seek: false,
    rate: base * Math.max(0.95, Math.min(1.05, 1 + errorSeconds / 5)),
  };
}

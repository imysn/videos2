/**
 * Rave privado — reference contract v1, 2026-09-30.
 * This is an implementation specification, not a working room server.
 * Add equivalent strict runtime validators and enforce the master-plan rules.
 */
export const PROTOCOL_VERSION = 1 as const;
export type UUID = string;
export type Role = "OWNER" | "PARTNER";
export type PlaybackPhase =
  "empty" | "paused" | "preparing" | "playing" | "blocked" | "ended";
export type PlaybackIntent = "paused" | "playing";
export type SourceKind = "local" | "http_file" | "hls" | "dash" | "drive";
export type SourceHealth =
  | "UNCHECKED"
  | "CHECKING"
  | "READY"
  | "EXPIRED"
  | "AUTH_REQUIRED"
  | "UNSUPPORTED"
  | "UNAVAILABLE"
  | "ERROR";
export type ParticipantStatus =
  | "away"
  | "connecting"
  | "present"
  | "ready"
  | "playing"
  | "buffering"
  | "needsGesture"
  | "reconnecting";
export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;
export type BaseRate = (typeof PLAYBACK_RATES)[number];
export const ROOM_LIMITS = {
  accounts: 2,
  rooms: 1,
  heartbeatMs: 5_000,
  leaseMs: 15_000,
  clockSampleCount: 5,
  clockBestSampleCount: 3,
  clockRecalibrationMs: 30_000,
  driftSampleMs: 500,
  driftIgnoreSeconds: 0.15,
  driftHardSeekSeconds: 0.8,
  maxSoftRateFraction: 0.05,
  settleMs: 750,
  barrierBufferSeconds: 2,
  bufferingDebounceMs: 750,
  readyStableMs: 500,
  scheduleMinMs: 300,
  scheduleMaxMs: 1_000,
  loadDiagnosticMs: 20_000,
  ackTimeoutMs: 3_000,
  commandRetries: 2,
  commandReceiptRetentionMs: 86_400_000,
  sharedCheckpointMs: 5_000,
  personalProgressMs: 10_000,
  maxChatCharacters: 2_000,
  chatPageSize: 50,
} as const;

export interface MediaIdentity {
  mediaId: UUID;
  sourceId: UUID;
  contentGeneration: UUID;
  title: string;
  durationSeconds: number;
}
export interface ParticipantView {
  userId: UUID;
  displayName: string;
  status: ParticipantStatus;
  expectedForPlayback: boolean;
  isHost: boolean;
  // Never include another participant's lease/session tokens or IP address.
}
export interface PreparationBarrier {
  barrierId: UUID;
  contentGeneration: UUID;
  targetPositionSeconds: number;
  requiredUserIds: UUID[];
}
export interface RoomSnapshot {
  protocolVersion: 1;
  roomId: UUID;
  sessionId: UUID | null;
  serverInstanceId: UUID;
  revision: number;
  hostUserId: UUID | null;
  hostEpoch: number;
  media: MediaIdentity | null;
  phase: PlaybackPhase;
  desiredPlayback: PlaybackIntent;
  anchorPositionSeconds: number;
  anchorServerTimeMs: number;
  baseRate: BaseRate;
  waitTogether: boolean;
  expectedUserIds: UUID[];
  temporarilyExcludedUserIds: UUID[];
  barrier: PreparationBarrier | null;
  blockReason: ErrorCode | "WAITING_FOR_PARTNER" | "BUFFERING" | null;
  participants: ParticipantView[];
  // Snapshot contains no URL, cloud token, cookie, or another user's lease.
}

export type RoomAction =
  | { type: "PLAY" }
  | { type: "PAUSE" }
  | { type: "SEEK"; positionSeconds: number }
  | { type: "SET_RATE"; rate: BaseRate }
  | { type: "CHANGE_MEDIA"; mediaId: UUID }
  | { type: "TRANSFER_HOST"; targetUserId: UUID }
  | { type: "CLAIM_HOST" }
  | { type: "SET_WAIT_TOGETHER"; enabled: boolean }
  | { type: "CONTINUE_WITHOUT_WAITING" }
  | { type: "END_SESSION" };
export interface RoomCommand {
  protocolVersion: 1;
  commandId: UUID;
  roomId: UUID;
  sessionId: UUID;
  leaseId: string;
  expectedRevision: number;
  expectedHostEpoch: number;
  contentGeneration: UUID | null;
  action: RoomAction;
}
export type ErrorCode =
  | "AUTH_REQUIRED"
  | "ACCESS_REVOKED"
  | "NOT_HOST"
  | "STALE_REVISION"
  | "STALE_SESSION"
  | "STALE_CONTENT"
  | "STALE_HOST_EPOCH"
  | "LEASE_REVOKED"
  | "HOST_STILL_PRESENT"
  | "PARTNER_NOT_READY"
  | "MEDIA_UNAVAILABLE"
  | "SOURCE_EXPIRED"
  | "SOURCE_AUTH_REQUIRED"
  | "SOURCE_UNSUPPORTED"
  | "SOURCE_NOT_SEEKABLE"
  | "AUTOPLAY_BLOCKED"
  | "INVALID_RANGE"
  | "RATE_LIMITED"
  | "IDEMPOTENCY_CONFLICT"
  | "INTERNAL_ERROR";
export interface CommandAck {
  commandId: UUID;
  accepted: boolean;
  code: "OK" | ErrorCode;
  revision: number;
  snapshot?: RoomSnapshot;
}
export interface RoomJoin {
  protocolVersion: 1;
  roomId: UUID;
  clientInstanceId: UUID;
  leaseId?: string;
  // Taking over another device must be an explicit authenticated HTTP action.
}
export interface RoomJoinAck {
  snapshot: RoomSnapshot;
  ownLeaseId: string;
  ownLeaseExpiresAtServerMs: number;
}
export interface RoomReady {
  protocolVersion: 1;
  roomId: UUID;
  sessionId: UUID;
  leaseId: string;
  barrierId: UUID;
  contentGeneration: UUID;
  actualPositionSeconds: number;
  durationSeconds: number;
  bufferedAheadSeconds: number;
  readyState: number;
  needsGesture: boolean;
}
export interface PlaybackStatusReport {
  protocolVersion: 1;
  roomId: UUID;
  sessionId: UUID;
  leaseId: string;
  contentGeneration: UUID;
  status:
    "playing" | "paused" | "buffering" | "needsGesture" | "ended" | "error";
  actualPositionSeconds: number;
  bufferedAheadSeconds: number;
  readyState: number;
  safeErrorCode?: ErrorCode;
  // Informational: never grants the reporter host authority.
}
export interface ClockPing {
  clientSendMonotonicMs: number;
}
export interface ClockPong {
  clientSendMonotonicMs: number;
  serverReceiveMs: number;
  serverSendMs: number;
  serverInstanceId: UUID;
}
export interface PlayerCapabilities {
  seek: boolean;
  rate: boolean;
  qualitySelection: boolean;
  audioTrackSelection: boolean;
  subtitles: boolean;
  thumbnails: boolean;
  chapters: boolean;
}
export interface PlaybackTrack {
  id: string;
  kind: "audio" | "subtitle" | "video";
  label: string;
  language?: string;
  width?: number;
  height?: number;
  bandwidth?: number;
}
export interface PlaybackDescriptor {
  protocolVersion: 1;
  mediaId: UUID;
  sourceId: UUID;
  contentGeneration: UUID;
  kind: "file" | "hls" | "dash";
  delivery: "direct" | "relay";
  url: string;
  expiresAt: string | null;
  durationSeconds: number;
  mimeType: string;
  capabilities: PlayerCapabilities;
  tracks: PlaybackTrack[];
  approvedOrigins: string[];
  // Only playback-access URLs; never provider refresh tokens/credentials.
}
export interface ChatSend {
  protocolVersion: 1;
  roomId: UUID;
  clientMessageId: UUID;
  body: string;
}
export interface ChatMessage {
  id: UUID;
  roomId: UUID;
  senderId: UUID;
  clientMessageId: UUID;
  sequence: string; // PostgreSQL bigint serialized losslessly.
  body: string | null;
  createdAt: string;
  deletedAt: string | null;
}

import { z } from "zod";
export * from "./protocol.js";
export const uuid = z.uuid();
export const position = z.number().finite().nonnegative();
export const rate = z.union([
  z.literal(0.5),
  z.literal(0.75),
  z.literal(1),
  z.literal(1.25),
  z.literal(1.5),
  z.literal(1.75),
  z.literal(2),
]);
export const actionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("PLAY") }),
  z.strictObject({ type: z.literal("PAUSE") }),
  z.strictObject({ type: z.literal("SEEK"), positionSeconds: position }),
  z.strictObject({ type: z.literal("SET_RATE"), rate }),
  z.strictObject({ type: z.literal("CHANGE_MEDIA"), mediaId: uuid }),
  z.strictObject({ type: z.literal("TRANSFER_HOST"), targetUserId: uuid }),
  z.strictObject({ type: z.literal("CLAIM_HOST") }),
  z.strictObject({
    type: z.literal("SET_WAIT_TOGETHER"),
    enabled: z.boolean(),
  }),
  z.strictObject({ type: z.literal("CONTINUE_WITHOUT_WAITING") }),
  z.strictObject({ type: z.literal("END_SESSION") }),
]);
export const commandSchema = z.strictObject({
  protocolVersion: z.literal(1),
  commandId: uuid,
  roomId: uuid,
  sessionId: uuid,
  leaseId: z.string().min(32).max(128),
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  expectedHostEpoch: z.number().int().nonnegative(),
  contentGeneration: uuid.nullable(),
  action: actionSchema,
});
export const joinSchema = z.strictObject({
  protocolVersion: z.literal(1),
  roomId: uuid,
  clientInstanceId: uuid,
  leaseId: z.string().min(32).max(128).optional(),
});
export const readySchema = z.strictObject({
  protocolVersion: z.literal(1),
  roomId: uuid,
  sessionId: uuid,
  leaseId: z.string().min(32).max(128),
  barrierId: uuid,
  contentGeneration: uuid,
  actualPositionSeconds: position,
  durationSeconds: position,
  bufferedAheadSeconds: position,
  readyState: z.number().int().min(0).max(4),
  needsGesture: z.boolean(),
});
export const statusSchema = z.strictObject({
  protocolVersion: z.literal(1),
  roomId: uuid,
  sessionId: uuid,
  leaseId: z.string().min(32).max(128),
  contentGeneration: uuid,
  status: z.enum([
    "playing",
    "paused",
    "buffering",
    "needsGesture",
    "ended",
    "error",
  ]),
  actualPositionSeconds: position,
  bufferedAheadSeconds: position,
  readyState: z.number().int().min(0).max(4),
  safeErrorCode: z
    .enum([
      "AUTOPLAY_BLOCKED",
      "MEDIA_UNAVAILABLE",
      "SOURCE_UNSUPPORTED",
      "SOURCE_AUTH_REQUIRED",
      "SOURCE_EXPIRED",
      "INTERNAL_ERROR",
    ])
    .optional(),
});
export const heartbeatSchema = z.strictObject({
  protocolVersion: z.literal(1),
  roomId: uuid,
  sessionId: uuid.nullable(),
  leaseId: z.string().min(32).max(128),
});
export const chatSchema = z.strictObject({
  protocolVersion: z.literal(1),
  roomId: uuid,
  clientMessageId: uuid,
  body: z
    .string()
    .trim()
    .min(1)
    .refine((v) => Array.from(v).length <= 2000 && v.split("\n").length <= 11),
});
export const password = z.string().min(12).max(128);
export const preferencesSchema = z.strictObject({
  volume: z.number().min(0).max(1).optional(),
  muted: z.boolean().optional(),
  subtitleId: uuid.nullable().optional(),
  subtitleLanguage: z.string().max(80).nullable().optional(),
  subtitleOffset: z.number().min(-5).max(5).multipleOf(0.25).optional(),
  subtitleSize: z.number().min(75).max(200).optional(),
  subtitleBackground: z.boolean().optional(),
  quality: z.string().max(80).optional(),
});
export const metadataSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(4000).default(""),
  category: z.string().trim().max(80).nullable().optional(),
});
export const chaptersSchema = z
  .array(
    z.strictObject({
      startSeconds: position,
      title: z.string().trim().min(1).max(200),
    }),
  )
  .max(500);
export function watched(p: number, d: number): boolean {
  return d > 0 && (p / d >= 0.95 || (d > 600 && d - p <= 120));
}

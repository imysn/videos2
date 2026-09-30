import { Server } from "socket.io";
import type { Socket } from "socket.io";
import { z } from "zod";
import {
  joinSchema,
  commandSchema,
  readySchema,
  statusSchema,
  heartbeatSchema,
  chatSchema,
  uuid,
} from "../../../../../packages/contracts/src/index.js";
import { Http } from "../../infrastructure/http.js";
import { assert, AppError } from "../../infrastructure/errors.js";
import { RoomService } from "./service.js";
import type { AuthService, Identity } from "../auth/service.js";
import { Chat } from "../chat/service.js";
export function roomTransport(
  h: Http,
  room: RoomService,
  chat: Chat,
  auth: AuthService,
  resolvePlayback: (mediaId: string, i: Identity) => Promise<unknown>,
) {
  const io = new Server(h.app.server, {
    maxHttpBufferSize: 16384,
    serveClient: false,
    cors: { origin: auth.config.origin, credentials: true },
    allowRequest: (r, done) =>
      done(null, r.headers.origin === auth.config.origin),
    transports: ["websocket", "polling"],
  });
  const identity = async (s: Socket) =>
    auth.authenticate(
      h.app.parseCookie(s.handshake.headers.cookie ?? "")[
        auth.config.cookieName
      ],
    );
  io.use(async (s, next) => {
    try {
      assert(
        s.handshake.headers.origin === auth.config.origin,
        "ORIGIN_REJECTED",
        403,
      );
      s.data.identity = await identity(s);
      assert(
        !s.data.identity.user.must_change_password,
        "PASSWORD_CHANGE_REQUIRED",
        403,
      );
      next();
    } catch {
      next(new Error("AUTH_REQUIRED"));
    }
  });
  room.broadcast = (s) => {
    io.to(s.roomId).emit("room:snapshot", s);
  };
  room.revokeLease = (userId) => {
    for (const s of io.sockets.sockets.values())
      if ((s.data.identity as Identity)?.user.id === userId) {
        s.emit("room:lease-revoked", { code: "LEASE_REVOKED" });
        s.data.leaseId = undefined;
      }
  };
  chat.broadcast = (m) => io.to(m.roomId).emit("chat:message", m);
  chat.notice = (type, b) => {
    void room.snapshot().then((s) => io.to(s.roomId).emit(type, b));
  };
  io.on("connection", (socket) => {
    const on = <T extends z.ZodType>(
      name: string,
      schema: T,
      fn: (b: z.infer<T>, i: Identity) => Promise<unknown>,
    ) =>
      socket.on(name, (raw: unknown, ack?: (v: unknown) => void) => {
        void (async () => {
          try {
            const body = schema.parse(raw),
              i = await identity(socket);
            socket.data.identity = i;
            const value = await fn(body, i);
            ack?.({ ok: true, result: value });
          } catch (e) {
            const code =
              e instanceof AppError
                ? e.code
                : e instanceof z.ZodError
                  ? "INVALID_PAYLOAD"
                  : "INTERNAL_ERROR";
            ack?.({ ok: false, code });
          }
        })();
      });
    on("room:join", joinSchema, async (b, i) => {
      const s = await room.snapshot();
      assert(b.roomId === s.roomId, "NOT_FOUND", 404);
      const r = await room.lease(i, b.clientInstanceId, false, b.leaseId);
      socket.data.leaseId = r.ownLeaseId;
      socket.data.roomId = s.roomId;
      await socket.join(s.roomId);
      return r;
    });
    on("room:heartbeat", heartbeatSchema, async (b, i) => {
      const s = await room.snapshot();
      assert(
        b.roomId === s.roomId && b.sessionId === s.sessionId,
        "STALE_SESSION",
        409,
      );
      return room.heartbeat(i, b.leaseId);
    });
    on("room:leave", heartbeatSchema, async (b, i) => {
      await room.leave(i, b.leaseId);
      await socket.leave(b.roomId);
      return { ok: true };
    });
    socket.on("room:command", (raw: unknown, ack?: (v: unknown) => void) => {
      void (async () => {
        try {
          assert(
            Buffer.byteLength(JSON.stringify(raw)) <= 8192,
            "INVALID_PAYLOAD",
          );
          const b = commandSchema.parse(raw),
            i = await identity(socket);
          try {
            ack?.(await room.command(i, b));
          } catch (e) {
            ack?.(room.errorAck(b, e, await room.snapshot()));
          }
        } catch {
          ack?.({ accepted: false, code: "INVALID_PAYLOAD" });
        }
      })();
    });
    on("room:ready", readySchema, (b, i) => room.ready(i, b));
    on("room:playback-status", statusSchema, (b, i) => room.status(i, b));
    on(
      "room:resync",
      z.strictObject({ protocolVersion: z.literal(1), roomId: uuid }),
      async (b) => {
        const s = await room.snapshot();
        assert(b.roomId === s.roomId, "NOT_FOUND", 404);
        return s;
      },
    );
    on(
      "clock:ping",
      z.strictObject({
        clientSendMonotonicMs: z.number().finite().nonnegative(),
      }),
      async (b) => {
        const receive = room.now();
        return {
          clientSendMonotonicMs: b.clientSendMonotonicMs,
          serverReceiveMs: receive,
          serverSendMs: room.now(),
          serverInstanceId: room.instanceId,
        };
      },
    );
    on("room:request-control", heartbeatSchema, async (b, i) => {
      const s = await room.snapshot();
      await room.validateLease(i, b.leaseId, s);
      room.limits.check(`request:${i.user.id}`, 1, 3000);
      io.to(s.roomId).emit("room:notice", {
        code: "CONTROL_REQUESTED",
        userId: i.user.id,
      });
      return { ok: true };
    });
    on("chat:send", chatSchema, (b, i) => chat.send(i, b));
    on(
      "chat:typing",
      z.strictObject({
        protocolVersion: z.literal(1),
        roomId: uuid,
        typing: z.boolean(),
      }),
      async (b, i) => {
        const s = await room.snapshot();
        assert(b.roomId === s.roomId, "NOT_FOUND", 404);
        chat.limits.check(`typing:${i.user.id}`, 1, 1000);
        socket.to(s.roomId).emit("chat:typing", {
          userId: i.user.id,
          typing: b.typing,
          expiresAtServerMs: room.now() + 3000,
        });
        return { ok: true };
      },
    );
    socket.on("disconnect", () => {
      const i = socket.data.identity as Identity | undefined;
      if (i && socket.data.leaseId)
        void auth.db
          .query(
            "UPDATE playback_leases SET status='reconnecting' WHERE user_id=$1 AND lease_hash=$2 AND revoked_at IS NULL",
            [i.user.id, importHash(socket.data.leaseId)],
          )
          .then(() =>
            room.event({
              type: "block",
              userId: i.user.id,
              reason: "WAITING_FOR_PARTNER",
            }),
          )
          .catch(() => {});
    });
  });
  const empty = z.strictObject({});
  h.route("GET", "/api/v1/room", empty, "user", async () => room.snapshot());
  h.route(
    "POST",
    "/api/v1/room/start",
    z.strictObject({
      mediaId: uuid,
      personalPositionSeconds: z.number().finite().nonnegative().optional(),
    }),
    "user",
    async (b, i) => room.start(i, b.mediaId, b.personalPositionSeconds),
  );
  h.route(
    "POST",
    "/api/v1/room/lease",
    z.strictObject({
      clientInstanceId: uuid,
      takeover: z.boolean().default(false),
      leaseId: z.string().min(32).max(128).optional(),
    }),
    "user",
    async (b, i) => room.lease(i, b.clientInstanceId, b.takeover, b.leaseId),
  );
  h.route(
    "POST",
    "/api/v1/room/playback/resolve",
    z.strictObject({
      leaseId: z.string().min(32).max(128),
      contentGeneration: uuid,
    }),
    "user",
    async (b, i) => {
      const s = await room.snapshot();
      await room.validateLease(i, b.leaseId, s);
      assert(
        s.media?.contentGeneration === b.contentGeneration,
        "STALE_CONTENT",
        409,
      );
      const descriptor = (await resolvePlayback(
        s.media.mediaId,
        i,
      )) as import("../../../../../packages/contracts/src/protocol.js").PlaybackDescriptor;
      assert(
        descriptor.contentGeneration === b.contentGeneration &&
          descriptor.sourceId === s.media.sourceId,
        "STALE_CONTENT",
        409,
      );
      return descriptor;
    },
  );
  const interval = setInterval(() => {
    void room.tick().catch(() => {});
  }, 1000);
  return {
    io,
    close: async () => {
      clearInterval(interval);
      await io.close();
      await room.close();
    },
  };
}
import { hash as importHash } from "../../infrastructure/secrets.js";

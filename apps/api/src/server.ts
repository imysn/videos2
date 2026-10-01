import Fastify from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import staticFiles from "@fastify/static";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { mkdir, access } from "node:fs/promises";
import { Database } from "../../../packages/db/src/index.js";
import type { Config } from "./infrastructure/config.js";
import { AppError, assert } from "./infrastructure/errors.js";
import { Http } from "./infrastructure/http.js";
import { AuthService } from "./modules/auth/service.js";
import { authRoutes } from "./modules/auth/routes.js";
import { LibraryService } from "./modules/library/service.js";
import { libraryRoutes } from "./modules/library/routes.js";
import { UrlAdapter } from "./modules/sources/service.js";
import { Streams } from "./modules/media/streams.js";
import { uploadRoutes } from "./modules/media/uploads.js";
import { Jobs } from "./jobs/service.js";
import { RoomService } from "./modules/room/service.js";
import { roomTransport } from "./modules/room/transport.js";
import { Chat } from "./modules/chat/service.js";
import { Drive } from "./modules/drive/service.js";
import { driveRoutes } from "./modules/drive/routes.js";
import { adminRoutes } from "./modules/admin/routes.js";
import { checkMasterKey } from "./infrastructure/key-state.js";
export async function createApp(
  config: Config,
  options: { logger?: boolean; roomLock?: boolean; webRoot?: string } = {},
) {
  const db = new Database(config.databaseUrl);
  await db.migrate();
  try {
    await checkMasterKey(db, config);
  } catch (error) {
    await db.close();
    throw error;
  }
  await mkdir(config.DATA_ROOT, { recursive: true, mode: 0o700 });
  const app = Fastify({
    exposeHeadRoutes: false,
    bodyLimit: 8 * 1024 * 1024,
    disableRequestLogging: true,
    logger:
      options.logger === false
        ? false
        : {
            level: "info",
            redact: [
              "req.headers.authorization",
              "req.headers.cookie",
              "res.headers.set-cookie",
            ],
            serializers: {
              req: (r) => ({ id: r.id, method: r.method }),
              err: (e) => ({
                type: e.name,
                code: e.code ?? "INTERNAL_ERROR",
                message: "Operation failed",
                stack: "",
              }),
            },
          },
  });
  app.setErrorHandler((e, r, p) => {
    const error = e as Error & { statusCode?: number; code?: string };
    const status =
      e instanceof AppError
        ? e.status
        : e instanceof z.ZodError
          ? 400
          : (error.statusCode ?? 500);
    const code =
      e instanceof AppError
        ? e.code
        : e instanceof z.ZodError
          ? "INVALID_PAYLOAD"
          : status === 429
            ? "RATE_LIMITED"
            : status < 500
              ? "INVALID_REQUEST"
              : "INTERNAL_ERROR";
    const correlationId = randomUUID();
    if (status >= 500)
      app.log.error({ code, correlationId }, "Operation failed");
    p.header("Cache-Control", "no-store")
      .code(status)
      .send({
        code,
        message:
          e instanceof AppError
            ? e.message
            : "No se pudo completar la operación.",
        correlationId,
      });
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: 1000,
    timeWindow: "1 minute",
  });
  await app.register(helmet, {
    contentSecurityPolicy: false,
    referrerPolicy: { policy: "no-referrer" },
    crossOriginResourcePolicy: { policy: "same-origin" },
  });
  app.addHook("onSend", async (r, p, payload) => {
    p.header("Cache-Control", "private, no-store");
    if (
      !r.url.startsWith("/media/") &&
      !r.url.startsWith("/assets/") &&
      !r.url.startsWith("/api/") &&
      !r.url.startsWith("/health/")
    ) {
      const sources = await db.query<{ approved_origins_json: string[] }>(
        "SELECT approved_origins_json FROM sources WHERE health='READY' AND delivery_strategy='direct'",
      );
      const approved = [
        ...new Set(sources.flatMap((s) => s.approved_origins_json)),
      ]
        .filter((raw) => {
          try {
            const u = new URL(raw);
            return (
              u.protocol === "https:" &&
              u.origin === raw &&
              !u.username &&
              !u.password
            );
          } catch {
            return false;
          }
        })
        .join(" ");
      const admin = r.url.startsWith("/admin"),
        ws = config.origin.replace(/^http/, "ws");
      p.header(
        "Content-Security-Policy",
        `default-src 'self'; script-src 'self'${admin ? " https://apis.google.com https://www.gstatic.com" : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob: ${approved}; connect-src 'self' ${ws} ${approved}${admin ? " https://www.googleapis.com https://apis.google.com https://docs.google.com" : ""}; frame-src ${admin ? "https://docs.google.com https://drive.google.com https://accounts.google.com" : "'none'"}; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`,
      );
    }
    return payload;
  });
  app.addHook("preHandler", async (r) => {
    if (
      !["GET", "HEAD"].includes(r.method) &&
      /^\/api\/v1\/admin\/(videos|sources|uploads|jobs)/.test(r.url)
    ) {
      const maintenance = await db.query(
        "SELECT 1 FROM settings WHERE key='maintenance' AND value_json='true'::jsonb",
      );
      assert(!maintenance.length, "MAINTENANCE", 503);
    }
  });
  const auth = new AuthService(db, config),
    http = new Http(app, auth),
    library = new LibraryService(db, config),
    urls = new UrlAdapter(undefined, library),
    streams = new Streams(auth),
    jobs = new Jobs(db),
    room = new RoomService(db, library),
    chat = new Chat(db),
    drive = new Drive(db, config, library, streams);
  if (options.roomLock !== false) await room.initialize();
  const playback = async (
    id: string,
    i: Parameters<LibraryService["get"]>[1],
  ) => {
    const m = await library.get(id, i);
    assert(m.primary_source_id, "MEDIA_UNAVAILABLE", 409);
    const s = await library.source(m.primary_source_id);
    assert(s.health === "READY", "MEDIA_UNAVAILABLE", 409);
    return s.kind === "local"
      ? library.localDescriptor(m, s)
      : s.kind === "drive"
        ? drive.descriptor(id, i)
        : urls.resolvePlayback(m, s);
  };
  const transport = roomTransport(http, room, chat, auth, playback);
  auth.onRevoke = async (ids) => {
    streams.revoke(ids);
    for (const socket of transport.io.sockets.sockets.values())
      if (ids.includes(socket.data.identity?.session.id)) {
        socket.emit("room:lease-revoked", { code: "ACCESS_REVOKED" });
        socket.disconnect(true);
      }
    await room.tick();
  };
  library.onUnavailable = async (mediaId) => {
    const s = await room.snapshot();
    if (s.media?.mediaId === mediaId) await room.event({ type: "unavailable" });
    const ids = await db.query<{ id: string }>(
      "SELECT id FROM sessions WHERE revoked_at IS NULL",
    );
    await db.afterCommit(() => streams.revoke(ids.map((v) => v.id)));
  };
  authRoutes(http);
  uploadRoutes(http, library, jobs);
  libraryRoutes(
    http,
    library,
    jobs,
    urls,
    streams,
    (id, i) => drive.descriptor(id, i),
    (id, i, r, p) => drive.stream(id, i, r, p),
  );
  chat.routes(http);
  driveRoutes(http, drive);
  adminRoutes(http);
  app.get("/health/live", async () => ({ ok: true }));
  app.get("/health/ready", async (_r, p) => {
    try {
      await db.query("SELECT 1");
      return { ok: true };
    } catch {
      return p.code(503).send({ ok: false });
    }
  });
  let built = false;
  try {
    await access(resolve(options.webRoot ?? "dist/web", "index.html"));
    built = true;
  } catch {
    /* Build is required for SPA. */
  }
  if (built) {
    await app.register(staticFiles, {
      root: resolve(options.webRoot ?? "dist/web"),
      serve: false,
      decorateReply: true,
    });
    app.get("/assets/*", async (r, p) => {
      const key = (r.params as { "*": string })["*"];
      assert(/^[A-Za-z0-9_.-]+$/.test(key), "NOT_FOUND", 404);
      return p.sendFile(`assets/${key}`);
    });
  }
  app.setNotFoundHandler(async (r, p) => {
    if (r.url.startsWith("/api/") || r.url.startsWith("/media/") || !built)
      return p.code(404).send({
        code: "NOT_FOUND",
        message: "No encontrado.",
        correlationId: randomUUID(),
      });
    if (r.method !== "GET") return p.code(404).send();
    return p.type("text/html").sendFile("index.html");
  });
  app.addHook("preClose", async () => {
    // HTTP shutdown must not wait indefinitely on upgraded WebSocket clients.
    // Close transports without a namespace DISCONNECT so clients can reconnect.
    transport.io.engine.close();
  });
  app.addHook("onClose", async () => {
    await transport.close();
    await db.close();
  });
  return { app, db, auth, library, room, drive, jobs, transport, http, config };
}

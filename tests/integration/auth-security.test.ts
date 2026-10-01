import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import argon2 from "argon2";
import { io, type Socket } from "socket.io-client";
import { testApp, actor } from "../helpers/context.js";
import { Database } from "../../packages/db/src/index.js";
import { AuthService } from "../../apps/api/src/modules/auth/service.js";
import { Worker } from "../../apps/worker/src/worker.js";
import {
  checksum,
  preparePath,
} from "../../apps/api/src/modules/media/storage.js";
let app: Awaited<ReturnType<typeof testApp>>;
beforeAll(async () => {
  app = await testApp();
  expect(app.config.APP_ENV).toBe("test");
  await app.app.listen({ host: "127.0.0.1", port: app.config.PORT });
});
afterAll(async () => {
  await app.app.close();
});
function connect(cookie: string, origin = app.config.origin) {
  const socket = io(app.config.origin, {
    transports: ["websocket"],
    extraHeaders: { cookie, origin },
    reconnection: false,
    timeout: 2000,
  });
  const ready = new Promise<void>((done, fail) => {
    socket.once("connect", done);
    socket.once("connect_error", fail);
  });
  return { socket, ready };
}
async function ack(socket: Socket, event: string, payload: unknown) {
  return (await socket.timeout(3000).emitWithAck(event, payload)) as {
    ok: boolean;
    result: { ownLeaseId: string };
  };
}
it("AUTH-01 bootstrap en DB nueva crea dos cuentas y una sala una sola vez", async () => {
  const name = `rave_bootstrap_${randomUUID().replaceAll("-", "")}`;
  const adminUrl = new URL(app.config.databaseUrl);
  adminUrl.pathname = "/postgres";
  const admin = new pg.Pool({ connectionString: adminUrl.href });
  const url = new URL(app.config.databaseUrl);
  url.pathname = `/${name}`;
  const db = new Database(url.href),
    dir = await mkdtemp(resolve(".local/validation/bootstrap-")),
    file = resolve(dir, "credentials.json");
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    await db.migrate();
    const auth = new AuthService(db, { ...app.config, databaseUrl: url.href });
    expect(await auth.bootstrap(file)).toBe(2);
    const credentials = JSON.parse(await readFile(file, "utf8")) as Record<
      string,
      string
    >;
    expect((await stat(file)).mode & 0o077).toBe(0);
    const before = await db.query(
      "SELECT id,slot,username,role,password_hash,must_change_password FROM users ORDER BY slot",
    );
    expect(
      before.map((u) => [u.slot, u.username, u.role, u.must_change_password]),
    ).toEqual([
      ["owner", "jason", "OWNER", true],
      ["partner", "pareja", "PARTNER", true],
    ]);
    for (const user of before) {
      expect(user.password_hash.startsWith("$argon2id$")).toBe(true);
      expect(
        await argon2.verify(user.password_hash, credentials[user.username]),
      ).toBe(true);
      expect(
        (
          await auth.login(
            user.username,
            credentials[user.username],
            "Fresh bootstrap",
          )
        ).identity.user.id,
      ).toBe(user.id);
    }
    const rooms = await db.query("SELECT id FROM rooms");
    expect(rooms).toHaveLength(1);
    expect(await auth.bootstrap(file)).toBe(0);
    expect(
      await db.query(
        "SELECT id,slot,username,role,password_hash,must_change_password FROM users ORDER BY slot",
      ),
    ).toEqual(before);
    expect(await db.query("SELECT id FROM rooms")).toEqual(rooms);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(credentials);
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.end();
    await rm(dir, { recursive: true, force: true });
  }
});
it("SEC-03 handshake WebSocket ajeno con cookie válida se rechaza", async () => {
  const owner = await actor(app),
    bad = connect(owner.cookie, "https://untrusted.invalid");
  try {
    await expect(bad.ready).rejects.toThrow();
    expect(bad.socket.connected).toBe(false);
  } finally {
    bad.socket.close();
  }
  const good = connect(owner.cookie);
  try {
    await good.ready;
    expect(good.socket.connected).toBe(true);
  } finally {
    good.socket.close();
  }
});
it("AUTH-06 desactivar partner corta socket, lease y relay real aún abierto", async () => {
  const owner = await actor(app),
    partner = await actor(app, "pareja"),
    media = await app.library.create(owner.identity, {
      title: "[TEST] active revocation",
      description: "",
    });
  const id = randomUUID(),
    key = `derived/${media}/${id}.mp4`,
    path = await preparePath(app.config.DATA_ROOT, key);
  await copyFile(resolve(".local/fixtures/long.mp4"), path);
  const bytes = (await stat(path)).size;
  await app.db.query(
    "INSERT INTO assets(id,media_id,kind,storage_key,mime_type,bytes,checksum) VALUES($1,$2,'compatible',$3,'video/mp4',$4,$5)",
    [id, media, key, bytes, await checksum(path)],
  );
  await app.library.addSource(media, "local", { assetId: id });
  await app.db.query(
    "UPDATE media SET publication_state='PUBLISHED',duration_seconds=1925 WHERE id=$1",
    [media],
  );
  const connection = connect(partner.cookie),
    controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    await connection.ready;
    const snapshot = await app.room.snapshot(),
      joined = await ack(connection.socket, "room:join", {
        protocolVersion: 1,
        roomId: snapshot.roomId,
        clientInstanceId: randomUUID(),
      });
    expect(joined.ok).toBe(true);
    const response = await fetch(`${app.config.origin}/media/assets/${id}`, {
      headers: { cookie: partner.cookie },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    reader = response.body!.getReader();
    let received = (await reader.read()).value!.length;
    const disconnected = new Promise<void>((done) =>
      connection.socket.once("disconnect", () => done()),
    );
    const started = performance.now();
    const disabled = await app.app.inject({
      method: "PATCH",
      url: `/api/v1/admin/accounts/${partner.identity.user.id}`,
      headers: owner.headers,
      payload: { disabled: true },
    });
    expect(disabled.statusCode).toBe(200);
    await disconnected;
    expect(performance.now() - started).toBeLessThan(1500);
    let truncated = false;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        received += next.value.length;
      }
    } catch {
      truncated = true;
    }
    expect(truncated).toBe(true);
    expect(received).toBeLessThan(bytes);
    expect(
      (
        await app.app.inject({
          url: `/media/assets/${id}`,
          headers: { cookie: partner.cookie, range: "bytes=0-127" },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      await app.db.query(
        "SELECT user_id FROM playback_leases WHERE user_id=$1 AND revoked_at IS NULL",
        [partner.identity.user.id],
      ),
    ).toHaveLength(0);
  } finally {
    controller.abort();
    await reader?.cancel().catch(() => {});
    connection.socket.close();
    await app.app.inject({
      method: "PATCH",
      url: `/api/v1/admin/accounts/${partner.identity.user.id}`,
      headers: owner.headers,
      payload: { disabled: false },
    });
  }
});
it("AUTH-07 cambiar contraseña rota cookie y revocar desde otra sesión es efectivo", async () => {
  const old = await actor(app),
    other = await actor(app),
    temporary = `Rave-test-${randomUUID()}`;
  try {
    const changed = await app.app.inject({
      method: "POST",
      url: "/api/v1/account/password",
      headers: old.headers,
      payload: { password: temporary },
    });
    expect(changed.statusCode).toBe(200);
    const cookie = String(changed.headers["set-cookie"]).split(";")[0];
    expect(cookie === old.cookie).toBe(false);
    expect(String(changed.headers["set-cookie"])).toContain("HttpOnly");
    expect(String(changed.headers["set-cookie"])).toContain("SameSite=Lax");
    for (const previous of [old, other])
      expect(
        (
          await app.app.inject({
            url: "/api/v1/auth/me",
            headers: { cookie: previous.cookie },
          })
        ).statusCode,
      ).toBe(401);
    const second = await app.auth.login("jason", temporary, "Second device"),
      secondCookie = `${app.config.cookieName}=${second.raw}`;
    const revoked = await app.app.inject({
      method: "DELETE",
      url: `/api/v1/account/sessions/${second.identity.session.id}`,
      headers: {
        cookie,
        origin: app.config.origin,
        "x-csrf-token": changed.json().csrf,
        "content-type": "application/json",
      },
      payload: {},
    });
    expect(revoked.statusCode).toBe(200);
    expect(
      (
        await app.app.inject({
          url: "/api/v1/auth/me",
          headers: { cookie: secondCookie },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await app.app.inject({ url: "/api/v1/auth/me", headers: { cookie } }))
        .statusCode,
    ).toBe(200);
  } finally {
    const current = await app.auth
      .login("jason", temporary, "Restore synthetic password")
      .catch(() => null);
    if (current)
      await app.db.transaction(() =>
        app.auth.changePassword(current.identity, app.passwords.jason),
      );
  }
});
it("CHAT-01/02/04 y SEC-08 chat durable, ACK perdido, permisos, cursor y retención reales", async () => {
  const owner = await actor(app),
    partner = await actor(app, "pareja"),
    a = connect(owner.cookie),
    b = connect(partner.cookie);
  try {
    await Promise.all([a.ready, b.ready]);
    const roomId = (await app.room.snapshot()).roomId;
    for (const c of [a, b])
      await ack(c.socket, "room:join", {
        protocolVersion: 1,
        roomId,
        clientInstanceId: randomUUID(),
      });
    const body = {
      protocolVersion: 1,
      roomId,
      clientMessageId: randomUUID(),
      body: "[TEST] ACK perdido 👋",
    };
    const delivered = new Promise<{ id: string; sequence: string }>((done) =>
      b.socket.once("chat:message", done),
    );
    a.socket.emit("chat:send", body);
    const first = await delivered;
    const retried = await a.socket.timeout(3000).emitWithAck("chat:send", body);
    expect(retried.ok).toBe(true);
    expect(retried.result.id).toBe(first.id);
    const messages = await Promise.all([
      a.socket.timeout(3000).emitWithAck("chat:send", {
        ...body,
        clientMessageId: randomUUID(),
        body: "Simultáneo A",
      }),
      b.socket.timeout(3000).emitWithAck("chat:send", {
        ...body,
        clientMessageId: randomUUID(),
        body: "Simultáneo B",
      }),
    ]);
    expect(messages.every((message) => message.ok)).toBe(true);
    expect(
      await app.db.query(
        "SELECT id FROM chat_messages WHERE sender_id=$1 AND client_message_id=$2",
        [owner.identity.user.id, body.clientMessageId],
      ),
    ).toHaveLength(1);
    const forbidden = await app.app.inject({
      method: "DELETE",
      url: `/api/v1/room/chat/${first.id}`,
      headers: partner.headers,
      payload: {},
    });
    expect(forbidden.statusCode).toBe(403);
    const own = await app.app.inject({
      method: "DELETE",
      url: `/api/v1/room/chat/${messages[1].result.id}`,
      headers: partner.headers,
      payload: {},
    });
    expect(own.statusCode).toBe(200);
    a.socket.close();
    const reconnected = connect(owner.cookie);
    try {
      await reconnected.ready;
      const replay = await reconnected.socket
        .timeout(3000)
        .emitWithAck("chat:send", body);
      expect(replay.result.id).toBe(first.id);
      const history = await app.app.inject({
        url: `/api/v1/room/chat?after=${first.sequence}`,
        headers: owner.headers,
      });
      expect(history.statusCode).toBe(200);
      expect(
        history
          .json()
          .filter((m: { id: string }) =>
            messages.some((msg) => msg.result.id === m.id),
          ),
      ).toHaveLength(2);
      const sequence = history
        .json()
        .map((m: { sequence: string }) => BigInt(m.sequence)) as bigint[];
      expect(sequence.every((seq, n) => !n || seq > sequence[n - 1])).toBe(
        true,
      );
      // Four owner sends above, then six accepted requests consume the actual
      // configured ten-per-ten-seconds budget. The next request is rejected.
      for (let n = 0; n < 6; n++)
        expect(
          (
            await reconnected.socket.timeout(3000).emitWithAck("chat:send", {
              ...body,
              clientMessageId: randomUUID(),
              body: `Limit ${n}`,
            })
          ).ok,
        ).toBe(true);
      const limited = await reconnected.socket
        .timeout(3000)
        .emitWithAck("chat:send", {
          ...body,
          clientMessageId: randomUUID(),
          body: "Too many",
        });
      expect(limited.code).toBe("RATE_LIMITED");
    } finally {
      reconnected.socket.close();
    }
    const old = randomUUID();
    await app.db.query(
      "INSERT INTO chat_messages(id,room_id,sender_id,client_message_id,body,created_at) VALUES($1,$2,$3,$4,'[TEST] expired',now()-interval '31 days')",
      [old, roomId, owner.identity.user.id, randomUUID()],
    );
    await new Worker(app.db, app.config).housekeeping();
    expect(
      await app.db.query("SELECT id FROM chat_messages WHERE id=$1", [old]),
    ).toHaveLength(0);
    const cleared = await app.app.inject({
      method: "DELETE",
      url: "/api/v1/admin/room/chat",
      headers: owner.headers,
      payload: {},
    });
    expect(cleared.statusCode).toBe(200);
    expect(
      await app.db.query(
        "SELECT id FROM chat_messages WHERE room_id=$1 AND body IS NOT NULL",
        [roomId],
      ),
    ).toHaveLength(0);
  } finally {
    a.socket.close();
    b.socket.close();
  }
});

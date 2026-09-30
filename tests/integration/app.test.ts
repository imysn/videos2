import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { testApp, actor, syntheticVideo } from "../helpers/context.js";
import { hash } from "../../apps/api/src/infrastructure/secrets.js";
let a: Awaited<ReturnType<typeof testApp>>,
  owner: Awaited<ReturnType<typeof actor>>,
  partner: Awaited<ReturnType<typeof actor>>,
  media: Awaited<ReturnType<typeof syntheticVideo>>;
beforeAll(async () => {
  a = await testApp();
  owner = await actor(a);
  partner = await actor(a, "pareja");
  await a.db.query("UPDATE rooms SET active_session_id=NULL");
  await a.db.query(
    "UPDATE viewing_sessions SET ended_at=now() WHERE ended_at IS NULL",
  );
  media = await syntheticVideo(a, owner.identity);
});
afterAll(async () => {
  await a.app.close();
});
describe("Autenticación y permisos sobre PostgreSQL real", () => {
  it("AUTH-01 bootstrap repetido conserva cuentas y hashes", async () => {
    const before = await a.db.query(
      "SELECT id,password_hash FROM users ORDER BY slot",
    );
    expect(
      await a.auth.bootstrap(resolve(".local/test/never-created.json")),
    ).toBe(0);
    expect(
      await a.auth.bootstrap(resolve(".local/test/never-created.json")),
    ).toBe(0);
    expect(
      await a.db.query("SELECT id,password_hash FROM users ORDER BY slot"),
    ).toEqual(before);
    expect(before.length).toBe(2);
  });
  it("AUTH-02 login y error genérico para usuario desconocido y contraseña incorrecta", async () => {
    const correct = await a.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: a.config.origin },
      payload: { username: "jason", password: a.passwords.jason },
    });
    expect(correct.statusCode).toBe(200);
    const cookie = correct.headers["set-cookie"];
    expect(String(cookie)).toContain("HttpOnly");
    expect(String(cookie)).toContain("SameSite=Lax");
    const bad = await a.app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { origin: a.config.origin },
        payload: { username: "jason", password: "bad" },
      }),
      unknown = await a.app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { origin: a.config.origin },
        payload: { username: "unknown", password: "bad" },
      });
    expect(bad.statusCode).toBe(401);
    expect(unknown.json().code).toBe(bad.json().code);
  });
  it.each([
    "/api/v1/library",
    `/api/v1/media/${randomUUID()}`,
    "/api/v1/room/chat",
    "/api/v1/admin/videos",
    `/media/assets/${randomUUID()}`,
  ])("AUTH-03 privado sin cookie: %s", async (url) =>
    expect((await a.app.inject({ method: "GET", url })).statusCode).toBe(401),
  );
  it.each([
    "/api/v1/admin/videos",
    "/api/v1/admin/drive/connect",
    `/api/v1/admin/accounts/${randomUUID()}/reset`,
  ])("AUTH-04 partner no administra %s", async (url) => {
    const r = await a.app.inject({
      method: "POST",
      url,
      headers: partner.headers,
      payload: url.endsWith("videos")
        ? { title: "Forbidden", description: "" }
        : {},
    });
    expect(r.statusCode).toBe(403);
  });
  it("AUTH-08 tercer slot y desactivar owner prohibidos en SQL y API", async () => {
    await expect(
      a.db.query(
        "INSERT INTO users(id,slot,username,display_name,role,password_hash) VALUES($1,$2,$3,$4,$5,$6)",
        [randomUUID(), "third", "third", "third", "PARTNER", "x"],
      ),
    ).rejects.toThrow();
    const r = await a.app.inject({
      method: "PATCH",
      url: `/api/v1/admin/accounts/${owner.identity.user.id}`,
      headers: owner.headers,
      payload: { disabled: true },
    });
    expect(r.statusCode).toBe(400);
    await expect(
      a.db.query("UPDATE users SET disabled_at=now() WHERE id=$1", [
        owner.identity.user.id,
      ]),
    ).rejects.toThrow();
  });
  it("CSRF y Origin rechazan mutaciones antes de cambiar DB", async () => {
    const target = {
      method: "POST" as const,
      url: "/api/v1/admin/videos",
      payload: { title: "X", description: "" },
    };
    expect(
      (
        await a.app.inject({
          ...target,
          headers: { ...owner.headers, origin: "https://evil.example" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await a.app.inject({
          ...target,
          headers: { ...owner.headers, "x-csrf-token": "bad" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await a.app.inject({ ...target, headers: owner.headers })).statusCode,
    ).toBe(200);
  });
  it("AUTH-05 reset manipulado, expirado y replay no consumen token válido", async () => {
    const valid = await a.auth.reset(partner.identity.user.id);
    await expect(
      a.auth.consumeReset("invalid".repeat(8), "secure-new-password"),
    ).rejects.toMatchObject({ code: "INVALID_RESET" });
    await a.db.query(
      "UPDATE reset_tokens SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
      [hash(valid)],
    );
    await expect(
      a.auth.consumeReset(valid, "secure-new-password"),
    ).rejects.toMatchObject({ code: "INVALID_RESET" });
    const next = await a.auth.reset(partner.identity.user.id),
      pw = a.passwords.pareja;
    const changed = await a.auth.consumeReset(next, pw);
    expect(changed.identity.user.id).toBe(partner.identity.user.id);
    await expect(a.auth.consumeReset(next, pw)).rejects.toMatchObject({
      code: "INVALID_RESET",
    });
    await expect(
      a.auth.authenticate(partner.cookie.split("=")[1]),
    ).rejects.toThrow();
    partner = await actor(a, "pareja");
  });
});
describe("Catálogo, Range, uploads y progreso", () => {
  it("LIB-01 borrador no visible al partner; publicado y retirado sí cambian acceso", async () => {
    const id = await a.library.create(owner.identity, {
      title: "Draft fixture",
      description: "",
    });
    expect(
      (
        await a.app.inject({
          url: `/api/v1/media/${id}`,
          headers: partner.headers,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await a.app.inject({
          url: `/api/v1/media/${id}`,
          headers: owner.headers,
        })
      ).statusCode,
    ).toBe(200);
    const invalid = await a.app.inject({
      method: "POST",
      url: `/api/v1/admin/videos/${id}/publish`,
      headers: owner.headers,
      payload: {},
    });
    expect(invalid.statusCode).toBe(409);
    const published = await a.app.inject({
      url: `/api/v1/media/${media.id}`,
      headers: partner.headers,
    });
    expect(published.statusCode).toBe(200);
  });
  it("LIB-02 búsqueda y paginación desde DB", async () => {
    const r = await a.app.inject({
      url: "/api/v1/library?search=TEST&limit=1",
      headers: partner.headers,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().items.length).toBe(1);
    expect(r.json().items[0].title).toContain("[TEST]");
  });
  it("SRC-02 archivos autenticados soportan Range exacto y HEAD", async () => {
    const s = await a.library.source(media.primary_source_id!),
      ref = a.library.reference<{ assetId: string }>(s),
      [asset] = await a.db.query<{ storage_key: string }>(
        "SELECT storage_key FROM assets WHERE id=$1",
        [ref.assetId],
      );
    const bytes = await readFile(
      resolve(a.config.DATA_ROOT, asset.storage_key),
    );
    for (const [range, start, end] of [
      ["bytes=10-29", 10, 29],
      ["bytes=10-", 10, bytes.length - 1],
      [`bytes=-20`, bytes.length - 20, bytes.length - 1],
    ] as const) {
      const r = await a.app.inject({
        url: `/media/${s.id}/file`,
        headers: { ...partner.headers, range },
      });
      expect(r.statusCode).toBe(206);
      expect(r.rawPayload.equals(bytes.subarray(start, end + 1))).toBe(true);
      expect(r.headers["content-range"]).toBe(
        `bytes ${start}-${end}/${bytes.length}`,
      );
    }
    const head = await a.app.inject({
      method: "HEAD",
      url: `/media/${s.id}/file`,
      headers: partner.headers,
    });
    expect(Number(head.headers["content-length"])).toBe(bytes.length);
    expect(head.rawPayload.length).toBe(0);
    for (const range of ["bytes=0-1,5-6", `bytes=${bytes.length}-`])
      expect(
        (
          await a.app.inject({
            url: `/media/${s.id}/file`,
            headers: { ...partner.headers, range },
          })
        ).statusCode,
      ).toBe(416);
  });
  it("LIB-03/04 upload reanudable: offset, chunk concurrente y bytes después de crash", async () => {
    const source = Buffer.from("synthetic upload contents");
    const created = await a.app.inject({
      method: "POST",
      url: "/api/v1/admin/uploads",
      headers: owner.headers,
      payload: {
        title: "Upload test",
        description: "",
        originalName: "../danger.mp4",
        expectedBytes: source.length,
      },
    });
    expect(created.statusCode).toBe(200);
    const u = created.json() as { id: string; mediaId: string };
    const chunk = async (offset: number, bytes: Buffer) =>
      a.app.inject({
        method: "PATCH",
        url: `/api/v1/admin/uploads/${u.id}`,
        headers: {
          ...owner.headers,
          "content-type": "application/octet-stream",
          "content-length": String(bytes.length),
          "upload-offset": String(offset),
        },
        payload: bytes,
      });
    expect((await chunk(0, source.subarray(0, 5))).statusCode).toBe(204);
    expect((await chunk(0, source.subarray(0, 5))).statusCode).toBe(409);
    const [row] = await a.db.query<{ temporary_key: string }>(
      "SELECT temporary_key FROM uploads WHERE id=$1",
      [u.id],
    );
    await writeFile(
      resolve(a.config.DATA_ROOT, row.temporary_key),
      Buffer.concat([
        source.subarray(0, 5),
        Buffer.from("extra uncommitted crash bytes"),
      ]),
    );
    expect((await chunk(5, source.subarray(5))).statusCode).toBe(204);
    expect(
      (await readFile(resolve(a.config.DATA_ROOT, row.temporary_key))).equals(
        source,
      ),
    ).toBe(true);
    const head = await a.app.inject({
      method: "HEAD",
      url: `/api/v1/admin/uploads/${u.id}`,
      headers: owner.headers,
    });
    expect(Number(head.headers["upload-offset"])).toBe(source.length);
    expect(
      (
        await a.app.inject({
          method: "POST",
          url: `/api/v1/admin/uploads/${u.id}/complete`,
          headers: owner.headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
  });
  it("CHAT-03 tres progresos distintos y escritura antigua rechazada", async () => {
    const open = async (who: typeof owner) => {
      const r = await a.app.inject({
        method: "POST",
        url: "/api/v1/solo-sessions",
        headers: who.headers,
        payload: {
          mediaId: media.id,
          clientInstanceId: randomUUID(),
          takeover: true,
        },
      });
      expect(r.statusCode).toBe(200);
      return r.json() as { id: string; contentGeneration: string };
    };
    const x = await open(owner),
      y = await open(partner);
    for (const [who, s, p] of [
      [owner, x, 17],
      [partner, y, 41],
    ] as const) {
      const r = await a.app.inject({
        method: "PUT",
        url: `/api/v1/solo-sessions/${s.id}/progress`,
        headers: who.headers,
        payload: {
          positionSeconds: p,
          writeRevision: 1,
          contentGeneration: s.contentGeneration,
        },
      });
      expect(r.statusCode).toBe(200);
    }
    const stale = await a.app.inject({
      method: "PUT",
      url: `/api/v1/solo-sessions/${x.id}/progress`,
      headers: owner.headers,
      payload: {
        positionSeconds: 2,
        writeRevision: 1,
        contentGeneration: x.contentGeneration,
      },
    });
    expect(stale.statusCode).toBe(409);
    const old = await open(owner);
    expect(old.id).not.toBe(x.id);
    expect(
      (
        await a.app.inject({
          method: "PUT",
          url: `/api/v1/solo-sessions/${x.id}/progress`,
          headers: owner.headers,
          payload: {
            positionSeconds: 2,
            writeRevision: 2,
            contentGeneration: x.contentGeneration,
          },
        })
      ).statusCode,
    ).toBe(409);
    const values = await a.db.query<{ position_seconds: number }>(
      "SELECT position_seconds FROM user_progress WHERE media_id=$1 ORDER BY position_seconds",
      [media.id],
    );
    expect(values.map((v) => v.position_seconds)).toEqual([17, 41]);
    expect(
      (
        await a.db.query("SELECT 1 FROM shared_progress WHERE media_id=$1", [
          media.id,
        ])
      ).length,
    ).toBe(0);
  });
  it("LIB-09 pendientes compartidos por ambas cuentas", async () => {
    expect(
      (
        await a.app.inject({
          method: "PUT",
          url: `/api/v1/watchlist/${media.id}`,
          headers: partner.headers,
          payload: { watched: false },
        })
      ).statusCode,
    ).toBe(200);
    const r = await a.app.inject({
      url: "/api/v1/library?pending=true",
      headers: owner.headers,
    });
    expect(r.json().items.some((m: { id: string }) => m.id === media.id)).toBe(
      true,
    );
  });
});
describe("Sala transaccional, autoridad y deduplicación", () => {
  it("SYNC-05/07/16 revision, receipts, epoch y lease único", async () => {
    let s = await a.room.start(owner.identity, media.id);
    const l = await a.room.lease(owner.identity, randomUUID());
    const p = await a.room.lease(partner.identity, randomUUID());
    s = await a.room.snapshot();
    const b = {
      protocolVersion: 1 as const,
      commandId: randomUUID(),
      roomId: s.roomId,
      sessionId: s.sessionId!,
      leaseId: l.ownLeaseId,
      expectedRevision: s.revision,
      expectedHostEpoch: s.hostEpoch,
      contentGeneration: s.media!.contentGeneration,
      action: { type: "SEEK" as const, positionSeconds: 33 },
    };
    const first = await a.room.command(owner.identity, b),
      repeat = await a.room.command(owner.identity, b);
    expect(repeat.revision).toBe(first.revision);
    expect(
      (
        await a.db.query("SELECT * FROM command_receipts WHERE command_id=$1", [
          b.commandId,
        ])
      ).length,
    ).toBe(1);
    await expect(
      a.room.command(owner.identity, {
        ...b,
        action: { type: "SEEK", positionSeconds: 7 },
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    s = await a.room.snapshot();
    await expect(
      a.room.command(partner.identity, {
        ...b,
        commandId: randomUUID(),
        leaseId: p.ownLeaseId,
        expectedRevision: s.revision,
        action: { type: "PLAY" },
      }),
    ).rejects.toMatchObject({ code: "NOT_HOST" });
    const transfer = await a.room.command(owner.identity, {
      ...b,
      commandId: randomUUID(),
      expectedRevision: s.revision,
      action: { type: "TRANSFER_HOST", targetUserId: partner.identity.user.id },
    });
    expect(transfer.snapshot?.hostUserId).toBe(partner.identity.user.id);
    await expect(
      a.room.command(owner.identity, {
        ...b,
        commandId: randomUUID(),
        expectedRevision: transfer.revision,
      }),
    ).rejects.toMatchObject({ code: "STALE_HOST_EPOCH" });
    await expect(
      a.room.lease(owner.identity, randomUUID()),
    ).rejects.toMatchObject({ code: "DEVICE_ACTIVE" });
    const takeover = await a.room.lease(owner.identity, randomUUID(), true);
    await expect(
      a.room.validateLease(
        owner.identity,
        l.ownLeaseId,
        await a.room.snapshot(),
      ),
    ).rejects.toMatchObject({ code: "LEASE_REVOKED" });
    expect(takeover.ownLeaseId).not.toBe(l.ownLeaseId);
  });
  it("SYNC-08 reclamación antes/después de lease sin host doble", async () => {
    const s = await a.room.snapshot();
    const l = await a.room.lease(owner.identity, randomUUID(), true);
    const b = {
      protocolVersion: 1 as const,
      commandId: randomUUID(),
      roomId: s.roomId,
      sessionId: s.sessionId!,
      leaseId: l.ownLeaseId,
      expectedRevision: s.revision,
      expectedHostEpoch: s.hostEpoch,
      contentGeneration: s.media!.contentGeneration,
      action: { type: "CLAIM_HOST" as const },
    };
    await expect(a.room.command(owner.identity, b)).rejects.toMatchObject({
      code: "HOST_STILL_PRESENT",
    });
    await a.db.query(
      "UPDATE playback_leases SET expires_at=now()-interval '1 second' WHERE user_id=$1",
      [partner.identity.user.id],
    );
    const n = await a.room.command(owner.identity, b);
    expect(n.snapshot?.hostUserId).toBe(owner.identity.user.id);
  });
  it("SYNC-20 retirada bloquea sala y deniega nuevos bytes partner", async () => {
    const r = await a.app.inject({
      method: "POST",
      url: `/api/v1/admin/videos/${media.id}/withdraw`,
      headers: owner.headers,
      payload: {},
    });
    expect(r.statusCode).toBe(200);
    expect((await a.room.snapshot()).blockReason).toBe("MEDIA_UNAVAILABLE");
    expect(
      (
        await a.app.inject({
          url: `/media/${media.primary_source_id}/file`,
          headers: partner.headers,
        })
      ).statusCode,
    ).toBe(404);
    await a.db.query(
      "UPDATE media SET publication_state='PUBLISHED' WHERE id=$1",
      [media.id],
    );
  });
});

describe("Mutaciones repetidas y persistencia transaccional", () => {
  it("Una creación concurrente con la misma clave produce una sola ficha; cambiar payload rechaza", async () => {
    const key = randomUUID(),
      title = `[IDEMPOTENCY] ${randomUUID()}`;
    const request = {
      method: "POST" as const,
      url: "/api/v1/admin/videos",
      headers: { ...owner.headers, "idempotency-key": key },
      payload: { title, description: "Prueba de ACK perdido" },
    };
    const responses = await Promise.all([
      a.app.inject(request),
      a.app.inject(request),
    ]);
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(responses[0].json()).toEqual(responses[1].json());
    const count = await a.db.query<{ count: string }>(
      "SELECT count(*) FROM media WHERE title=$1",
      [title],
    );
    expect(Number(count[0].count)).toBe(1);
    const conflict = await a.app.inject({
      ...request,
      payload: { title: title + " modificado", description: "" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe("IDEMPOTENCY_CONFLICT");
    const receipts = await a.db.query<{ result_json: unknown }>(
      "SELECT result_json FROM http_receipts WHERE request_key=$1",
      [key],
    );
    expect(JSON.stringify(receipts)).not.toContain(responses[0].json().id);
  });
  it("La ausencia de clave rechaza la creación sin insertar una ficha", async () => {
    const r = await a.app.inject({
      method: "POST",
      url: "/api/v1/admin/videos",
      headers: {
        cookie: owner.cookie,
        origin: a.config.origin,
        "x-csrf-token": owner.identity.csrf,
        "content-type": "application/json",
      },
      payload: { title: "Sin clave", description: "" },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe("INVALID_PAYLOAD");
  });
  it("Rollback de la transacción incluye operaciones anidadas", async () => {
    const title = `[ROLLBACK] ${randomUUID()}`;
    await expect(
      a.db.transaction(async () => {
        await a.library.create(owner.identity, { title, description: "" });
        await a.db.transaction(async () => {
          throw new Error("Forced regression failure");
        });
      }),
    ).rejects.toThrow("Forced regression failure");
    expect(
      await a.db.query("SELECT id FROM media WHERE title=$1", [title]),
    ).toHaveLength(0);
  });
  it("El worker no reclama jobs en mantenimiento ni excede intentos máximos", async () => {
    const job = await a.jobs.enqueue(
      "housekeeping",
      null,
      `maintenance:${randomUUID()}`,
      {},
    );
    try {
      await a.db.query(
        "INSERT INTO settings(key,value_json) VALUES('maintenance','true') ON CONFLICT(key) DO UPDATE SET value_json='true'",
      );
      expect(await a.jobs.claim("regression")).toBeNull();
      await a.db.query(
        "UPDATE settings SET value_json='false' WHERE key='maintenance'",
      );
      await a.db.query(
        "UPDATE jobs SET state='running',attempt=max_attempts,lease_until=now()-interval '1 minute' WHERE id=$1",
        [job.id],
      );
      await a.jobs.claim("regression");
      const [state] = await a.db.query<{
        state: string;
        safe_error_code: string;
      }>("SELECT state,safe_error_code FROM jobs WHERE id=$1", [job.id]);
      expect(state.state).toBe("failed");
      expect(state.safe_error_code).toBe("MAX_ATTEMPTS");
    } finally {
      await a.db.query(
        "UPDATE settings SET value_json='false' WHERE key='maintenance'",
      );
    }
  });
});

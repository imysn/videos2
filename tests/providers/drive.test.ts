import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { testApp, actor } from "../helpers/context.js";
import {
  SingleFlight,
  type DriveGateway,
} from "../../apps/api/src/modules/drive/service.js";
import {
  seal,
  hash,
  token,
} from "../../apps/api/src/infrastructure/secrets.js";
let a: Awaited<ReturnType<typeof testApp>>,
  owner: Awaited<ReturnType<typeof actor>>,
  partner: Awaited<ReturnType<typeof actor>>,
  connectionId: string,
  importedId: string,
  testGateway: DriveGateway;
beforeAll(async () => {
  a = await testApp();
  owner = await actor(a);
  partner = await actor(a, "pareja");
});
afterAll(async () => {
  await a.db.query("DELETE FROM oauth_states");
  if (connectionId) {
    await a.db.query(
      "UPDATE sources SET connection_id=NULL WHERE connection_id=$1",
      [connectionId],
    );
    await a.db.query("DELETE FROM provider_connections WHERE id=$1", [
      connectionId,
    ]);
  }
  await a.app.close();
});
it("SRC-08 sin configuración no afirma conectado", async () => {
  await a.db.query("UPDATE provider_connections SET status='revoked'");
  expect(await a.drive.status()).toMatchObject({
    implemented: true,
    configured: false,
    authorized: false,
  });
  const r = await a.app.inject({
    method: "POST",
    url: "/api/v1/admin/drive/connect",
    headers: owner.headers,
    payload: {},
  });
  expect(r.statusCode).toBe(409);
  expect(r.json().code).toBe("DRIVE_NOT_CONFIGURED");
});
it("SRC-05 state ligado a sesión, único, expirado o manipulado rechazado", async () => {
  const state = token();
  await a.db.query(
    "INSERT INTO oauth_states(id,state_hash,auth_session_id,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')",
    [randomUUID(), hash(state), owner.identity.session.id],
  );
  await expect(
    a.drive.consumeState(partner.identity, state),
  ).rejects.toMatchObject({ code: "INVALID_OAUTH_STATE" });
  await expect(
    a.drive.consumeState(owner.identity, "wrong".repeat(10)),
  ).rejects.toMatchObject({ code: "INVALID_OAUTH_STATE" });
  await a.drive.consumeState(owner.identity, state);
  await expect(
    a.drive.consumeState(owner.identity, state),
  ).rejects.toMatchObject({ code: "INVALID_OAUTH_STATE" });
});
it("SRC-06 lectura oficial autorizada y descriptor no expone tokens", async () => {
  connectionId = randomUUID();
  await a.db.query(
    "INSERT INTO provider_connections(id,provider,owner_id,encrypted_secrets,status) VALUES($1,'drive',$2,$3,'authorized') ON CONFLICT(provider,owner_id) DO UPDATE SET id=excluded.id,encrypted_secrets=excluded.encrypted_secrets,status='authorized'",
    [
      connectionId,
      owner.identity.user.id,
      seal(
        { refresh_token: "CONTRACT_TEST_ONLY" },
        a.config.masterKey,
        "provider",
        connectionId,
      ),
    ],
  );
  let mutations = 0;
  const gateway: DriveGateway = {
    client: {
      credentials: {
        access_token: "SHORT_CONTRACT_TOKEN",
        refresh_token: "CONTRACT_TEST_ONLY",
      },
      setCredentials(c) {
        this.credentials = c;
      },
      async getAccessToken() {
        return { token: "SHORT_CONTRACT_TOKEN" };
      },
      async revokeCredentials() {
        mutations++;
      },
    },
    metadata: async (fileId) => ({
      id: fileId,
      name: "[TEST] Drive contract",
      mimeType: "video/mp4",
      size: "1000",
      version: "1",
      capabilities: { canDownload: true },
      videoMediaMetadata: { durationMillis: "120000" },
    }),
    bytes: async (_file, range) => ({
      status: range ? 206 : 200,
      headers: {
        "content-range": "bytes 0-9/1000",
        "content-length": "10",
        "content-type": "video/mp4",
      },
      body: Readable.from([Buffer.alloc(10)]),
    }),
  };
  a.drive.gatewayFactory = () => gateway;
  testGateway = gateway;
  const ids = await a.drive.importFiles(owner.identity, [
    "test_drive_file_123",
  ]);
  expect(ids.length).toBe(1);
  importedId = ids[0];
  await a.db.query(
    "UPDATE media SET publication_state='PUBLISHED' WHERE id=$1",
    [ids[0]],
  );
  const descriptor = await a.drive.descriptor(ids[0], partner.identity);
  expect(JSON.stringify(descriptor)).not.toContain("CONTRACT");
  expect(descriptor.delivery).toBe("relay");
  expect(descriptor.url).toMatch(/^\/media\//);
  expect(mutations).toBe(0);
  const denied = {
    ...gateway,
    metadata: async () => ({
      mimeType: "video/mp4",
      capabilities: { canDownload: false },
    }),
  };
  await expect(
    a.drive.metadata(denied, "test_drive_file_123"),
  ).rejects.toMatchObject({ code: "SOURCE_UNSUPPORTED" });
});
it("SRC-06 errores 403/404/429 normalizados con reintentos acotados", async () => {
  for (const [status, code, count] of [
    [403, "SOURCE_AUTH_REQUIRED", 1],
    [404, "SOURCE_UNAVAILABLE", 1],
    [429, "DRIVE_QUOTA", 3],
  ] as const) {
    let attempts = 0;
    await expect(
      a.drive.bounded(async () => {
        attempts++;
        throw { response: { status } };
      }),
    ).rejects.toMatchObject({ code });
    expect(attempts).toBe(count);
  }
});
it("refresco concurrente single-flight ejecuta una vez", async () => {
  const flight = new SingleFlight();
  let count = 0;
  const tasks = Array.from({ length: 10 }, () =>
    flight.run("connection", async () => {
      count++;
      await new Promise((r) => setTimeout(r, 20));
      return "same";
    }),
  );
  expect(await Promise.all(tasks)).toEqual(Array(10).fill("same"));
  expect(count).toBe(1);
});
it("SRC-06 relay Range/HEAD usa el gateway y no marca un contrato como prueba viva", async () => {
  const descriptor = await a.drive.descriptor(importedId, partner.identity);
  const range = await a.app.inject({
    url: descriptor.url,
    headers: { ...partner.headers, range: "bytes=0-9" },
  });
  expect(range.statusCode).toBe(206);
  expect(range.headers["content-range"]).toBe("bytes 0-9/1000");
  expect(range.rawPayload).toEqual(Buffer.alloc(10));
  const head = await a.app.inject({
    method: "HEAD",
    url: descriptor.url,
    headers: partner.headers,
  });
  expect(head.statusCode).toBe(200);
  expect(head.rawPayload.length).toBe(0);
  expect((await a.drive.status()).liveVerifiedAt).toBeNull();
});
it("SRC-06 refresco real de la interfaz concurrente guarda credenciales cifradas una sola vez", async () => {
  const original = testGateway.client.getAccessToken;
  let calls = 0;
  testGateway.client.getAccessToken = async () => {
    calls++;
    await new Promise((done) => setTimeout(done, 50));
    testGateway.client.credentials = {
      ...testGateway.client.credentials,
      access_token: "RENEWED_CONTRACT_ONLY",
    };
    return { token: "RENEWED_CONTRACT_ONLY" };
  };
  try {
    await Promise.all(Array.from({ length: 10 }, () => a.drive.gateway()));
    expect(calls).toBe(1);
    const rows = await a.db.query(
      "SELECT encrypted_secrets FROM provider_connections WHERE id=$1",
      [connectionId],
    );
    expect(JSON.stringify(rows)).not.toContain("RENEWED_CONTRACT_ONLY");
  } finally {
    testGateway.client.getAccessToken = original;
  }
});
it("Importación Picker repetida tras perder ACK crea una sola ficha", async () => {
  const key = randomUUID(),
    request = {
      method: "POST" as const,
      url: "/api/v1/admin/drive/import",
      headers: { ...owner.headers, "idempotency-key": key },
      payload: { fileIds: ["test_drive_import_456"] },
    };
  const responses = await Promise.all([
    a.app.inject(request),
    a.app.inject(request),
  ]);
  expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
  expect(responses[0].json()).toEqual(responses[1].json());
  expect(responses[0].json().mediaIds).toHaveLength(1);
});
it("SRC-09 cambio de versión bloquea bytes antes de entregarlos y marca la fuente", async () => {
  const source = (await a.library.get(importedId, owner.identity))
    .primary_source_id!;
  const metadata = testGateway.metadata,
    bytes = testGateway.bytes;
  let delivered = 0;
  testGateway.metadata = async (id) => ({
    ...(await metadata(id)),
    version: "2",
  });
  testGateway.bytes = async (...args) => {
    delivered++;
    return bytes(...args);
  };
  try {
    const response = await a.app.inject({
      url: `/media/${source}/file`,
      headers: partner.headers,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("CONTENT_IDENTITY_MISMATCH");
    expect(delivered).toBe(0);
    expect((await a.library.source(source)).health).toBe("ERROR");
  } finally {
    testGateway.metadata = metadata;
    testGateway.bytes = bytes;
    await a.db.query(
      "UPDATE sources SET health='READY',safe_error_code=NULL WHERE id=$1",
      [source],
    );
  }
});
it("Desconexión local funciona aunque falle la revocación remota; no simula su éxito", async () => {
  testGateway.client.revokeCredentials = async () => {
    throw { response: { status: 503 } };
  };
  const result = await a.drive.revoke();
  expect(result).toEqual({ ok: true, remoteRevoked: false });
  expect((await a.drive.status()).authorized).toBe(false);
  await expect(a.drive.connection()).rejects.toMatchObject({
    code: "SOURCE_AUTH_REQUIRED",
  });
  const source = (await a.library.get(importedId, owner.identity))
    .primary_source_id!;
  expect((await a.library.source(source)).health).toBe("AUTH_REQUIRED");
});

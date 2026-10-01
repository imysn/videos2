import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { readFile, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { testApp, actor, syntheticVideo } from "../helpers/context.js";
import { SafeFetch } from "../../apps/api/src/infrastructure/safe-fetch/index.js";
import { UrlAdapter } from "../../apps/api/src/modules/sources/service.js";
import { parseRange } from "../../apps/api/src/modules/media/storage.js";
let a: Awaited<ReturnType<typeof testApp>>,
  owner: Awaited<ReturnType<typeof actor>>,
  partner: Awaited<ReturnType<typeof actor>>,
  mediaId: string,
  sourceId: string,
  generation: string;
let bytes: Buffer,
  version = '"fixture-v1"';
let spy: ReturnType<typeof vi.spyOn>;
beforeAll(async () => {
  a = await testApp();
  owner = await actor(a);
  partner = await actor(a, "pareja");
  bytes = await readFile(".local/fixtures/short.mp4");
  const safe = new SafeFetch(
    async () => [{ address: "93.184.216.34", family: 4 }],
    async (r) => {
      const range = parseRange(r.headers.range, bytes.length);
      return {
        status: range.partial ? 206 : 200,
        headers: {
          "content-type": "video/mp4",
          "content-length": String(range.end - range.start + 1),
          etag: version,
          ...(range.partial
            ? {
                "content-range": `bytes ${range.start}-${range.end}/${bytes.length}`,
              }
            : {}),
        },
        body: Readable.from([bytes.subarray(range.start, range.end + 1)]),
        url: r.url.href,
        origin: r.url.origin,
        abort() {},
      };
    },
  );
  const adapter = new UrlAdapter(safe, a.library);
  // Controlled official HTTP transport, actual inspectors/parsers, SQL and routes.
  const inspect = adapter.inspect.bind(adapter);
  spy = vi
    .spyOn(UrlAdapter.prototype, "inspect")
    .mockImplementation((url, signal) => inspect(url, signal));
  // Avoid recursive prototype interception: use the original implementation.
});
afterAll(async () => {
  spy?.mockRestore();
  await a?.app.close();
});
it("LIB-07/SRC-04: reemplazar conserva generación solo para mismo contenido comprobado", async () => {
  mediaId = await a.library.create(owner.identity, {
    title: "[TEST] URL lifecycle",
    description: "",
  });
  const created = await a.app.inject({
    method: "POST",
    url: `/api/v1/admin/videos/${mediaId}/sources`,
    headers: owner.headers,
    payload: { url: "https://example.com/movie.mp4" },
  });
  expect(created.statusCode).toBe(200);
  sourceId = created.json().sourceId;
  await a.db.query(
    "UPDATE media SET publication_state='PUBLISHED' WHERE id=$1",
    [mediaId],
  );
  generation = (await a.library.get(mediaId, owner.identity))
    .content_generation;
  await a.db.query(
    "INSERT INTO user_progress(user_id,media_id,content_generation,position_seconds,write_revision) VALUES($1,$2,$3,30,1)",
    [partner.identity.user.id, mediaId, generation],
  );
  const same = await a.app.inject({
    method: "PATCH",
    url: `/api/v1/admin/sources/${sourceId}`,
    headers: owner.headers,
    payload: { url: "https://example.com/renewed.mp4", sameContent: true },
  });
  expect(same.statusCode).toBe(200);
  expect(
    (await a.library.get(mediaId, owner.identity)).content_generation,
  ).toBe(generation);
  expect(
    a.library.view(await a.library.get(mediaId, partner.identity))
      .personalPosition,
  ).toBe(30);
  bytes = await readFile(".local/fixtures/adaptive.mp4");
  version = '"fixture-v2"';
  const changed = () =>
    a.app.inject({
      method: "PATCH",
      url: `/api/v1/admin/sources/${sourceId}`,
      headers: owner.headers,
      payload: { url: "https://example.com/different.mp4", sameContent: true },
    });
  expect((await changed()).json().code).toBe("CONTENT_IDENTITY_MISMATCH");
  const accepted = await a.app.inject({
    method: "PATCH",
    url: `/api/v1/admin/sources/${sourceId}`,
    headers: owner.headers,
    payload: { url: "https://example.com/different.mp4", sameContent: false },
  });
  expect(accepted.statusCode).toBe(200);
  const next = await a.library.get(mediaId, partner.identity);
  expect(next.content_generation).not.toBe(generation);
  expect(a.library.view(next).personalPosition).toBe(0);
});
it("SRC-09: revisar recurso cambiado bloquea identidad y no lo marca disponible", async () => {
  version = '"fixture-v3"';
  const response = await a.app.inject({
    method: "POST",
    url: `/api/v1/admin/sources/${sourceId}/recheck`,
    headers: owner.headers,
    payload: {},
  });
  expect(response.statusCode).toBe(409);
  expect(response.json().code).toBe("CONTENT_IDENTITY_MISMATCH");
  expect((await a.library.source(sourceId)).health).toBe("ERROR");
});
it("SEC-08: límite de inspección actúa antes de red y admite otra operación", async () => {
  let response;
  for (let n = 0; n < 11; n++)
    response = await a.app.inject({
      method: "POST",
      url: "/api/v1/admin/sources/inspect",
      headers: owner.headers,
      payload: { url: "https://example.com/movie.mp4" },
    });
  expect(response!.statusCode).toBe(429);
  expect(response!.json().code).toBe("RATE_LIMITED");
  expect(
    (await a.app.inject({ url: "/api/v1/library", headers: owner.headers }))
      .statusCode,
  ).toBe(200);
});
it("SRC-04: enlace manual expirado exige reemplazo y conserva generación/progreso", async () => {
  const id = await a.library.create(owner.identity, {
    title: "[TEST] expired",
    description: "",
  });
  const source = await a.library.addSource(
    id,
    "http_file",
    {
      url: "https://example.com/expired.mp4",
      domain: "example.com",
      bytes: 1000,
      mimeType: "video/mp4",
      durationSeconds: 120,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    },
    undefined,
    "relay",
  );
  await a.db.query(
    "UPDATE media SET duration_seconds=120,publication_state='PUBLISHED' WHERE id=$1",
    [id],
  );
  const before = (await a.library.get(id, owner.identity)).content_generation;
  const r = await a.app.inject({
    method: "POST",
    url: `/api/v1/playback/${id}/resolve`,
    headers: partner.headers,
    payload: {},
  });
  expect(r.statusCode).toBe(409);
  expect(r.json().code).toBe("SOURCE_EXPIRED");
  expect((await a.library.source(source)).health).toBe("EXPIRED");
  expect((await a.library.get(id, owner.identity)).content_generation).toBe(
    before,
  );
});
it("SEC-08: dos uploads activos permitidos, tercero denegado y cancelar libera capacidad", async () => {
  const requests: string[] = [];
  try {
    for (let n = 0; n < 2; n++) {
      const r = await a.app.inject({
        method: "POST",
        url: "/api/v1/admin/uploads",
        headers: owner.headers,
        payload: {
          title: "[TEST] upload limit",
          description: "",
          expectedBytes: 10,
          originalName: "file.mp4",
        },
      });
      expect(r.statusCode).toBe(200);
      requests.push(r.json().id);
    }
    const third = await a.app.inject({
      method: "POST",
      url: "/api/v1/admin/uploads",
      headers: owner.headers,
      payload: {
        title: "[TEST] upload limit",
        description: "",
        expectedBytes: 10,
        originalName: "file.mp4",
      },
    });
    expect(third.statusCode).toBe(409);
    expect(third.json().code).toBe("UPLOAD_LIMIT");
  } finally {
    for (const id of requests)
      expect(
        (
          await a.app.inject({
            method: "DELETE",
            url: `/api/v1/admin/uploads/${id}`,
            headers: owner.headers,
            payload: {},
          })
        ).statusCode,
      ).toBe(200);
  }
});

it("LIB-08: borrar propio limpia archivos con worker real y borrar ficha Drive no contacta el proveedor", async () => {
  const { Worker } = await import("../../apps/worker/src/worker.js");
  const local = await syntheticVideo(a, owner.identity),
    files = await a.db.query<{ storage_key: string }>(
      "SELECT storage_key FROM assets WHERE media_id=$1",
      [local.id],
    );
  expect(files.length).toBeGreaterThan(1);
  const removed = await a.app.inject({
    method: "DELETE",
    url: `/api/v1/admin/videos/${local.id}`,
    headers: owner.headers,
    payload: {},
  });
  expect(removed.statusCode).toBe(200);
  const [job] = await a.db.query(
    "SELECT id,state FROM jobs WHERE media_id=$1 AND kind='delete-media'",
    [local.id],
  );
  const worker = new Worker(a.db, a.config);
  while (
    (await a.db.query("SELECT state FROM jobs WHERE id=$1", [job.id]))[0]
      .state === "queued"
  )
    await worker.runNext();
  expect(
    (await a.db.query("SELECT state FROM jobs WHERE id=$1", [job.id]))[0].state,
  ).toBe("succeeded");
  for (const file of files)
    await expect(
      stat(`${a.config.DATA_ROOT}/${file.storage_key}`),
    ).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    await a.db.query("SELECT id FROM assets WHERE media_id=$1", [local.id]),
  ).toHaveLength(0);
  const id = await a.library.create(owner.identity, {
    title: "[TEST] Drive deletion",
    description: "",
  });
  await a.library.addSource(id, "drive", {
    fileId: "test_drive_file_deleted",
    version: "1",
    bytes: 1000,
    mimeType: "video/mp4",
    durationSeconds: 120,
  });
  await a.db.query(
    "UPDATE media SET duration_seconds=120,publication_state='PUBLISHED' WHERE id=$1",
    [id],
  );
  let providerCalls = 0;
  a.drive.gatewayFactory = () => {
    providerCalls++;
    throw new Error("Unexpected provider call");
  };
  const remote = await a.app.inject({
    method: "DELETE",
    url: `/api/v1/admin/videos/${id}`,
    headers: owner.headers,
    payload: {},
  });
  expect(remote.statusCode).toBe(200);
  expect(await worker.runNext()).toBe(true);
  expect(providerCalls).toBe(0);
  expect(
    (
      await a.app.inject({
        url: `/api/v1/media/${id}`,
        headers: partner.headers,
      })
    ).statusCode,
  ).toBe(404);
});

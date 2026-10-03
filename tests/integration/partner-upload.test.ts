import { it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { testApp, actor } from "../helpers/context.js";
import { largeUploadFixture } from "../helpers/large-upload.js";
import { Worker } from "../../apps/worker/src/worker.js";
import {
  storagePath,
  checksum,
} from "../../apps/api/src/modules/media/storage.js";
import type {
  UserUpload,
  UploadRecord,
} from "../../packages/contracts/src/upload-pipeline.js";

// The route regression must exercise low disk on hosts of any capacity. Other
// tests use the real filesystem, including the existing isolated ENOSPC suite.
const disk = vi.hoisted(() => ({ unavailable: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    statfs: vi.fn(async (path: Parameters<typeof actual.statfs>[0]) => {
      const result = await actual.statfs(path);
      return disk.unavailable ? { ...result, bavail: 0, bfree: 0 } : result;
    }),
  };
});

let app: Awaited<ReturnType<typeof testApp>>;
let owner: Awaited<ReturnType<typeof actor>>,
  partner: Awaited<ReturnType<typeof actor>>;
type Actor = Awaited<ReturnType<typeof actor>>;
const created: UploadRecord[] = [];
beforeAll(async () => {
  app = await testApp();
  expect(app.config.APP_ENV).toBe("test");
  owner = await actor(app);
  partner = await actor(app, "pareja");
  await mkdir(".local/upload-work", { recursive: true });
});
beforeEach(async () => {
  // This suite operates exclusively on the isolated synthetic test database.
  await app.db.query(
    "UPDATE jobs SET state='cancelled',lease_until=NULL WHERE state IN ('queued','running')",
  );
  await app.db.query(
    "UPDATE uploads SET state='cancelled' WHERE state='uploading'",
  );
});
afterAll(async () => {
  for (const u of created) {
    await app.db.query(
      "UPDATE uploads SET state='cancelled' WHERE id=$1 AND state='uploading'",
      [u.id],
    );
    const rows = await app.db.query<{ storage_key: string }>(
      "SELECT storage_key FROM assets WHERE media_id=$1 UNION SELECT temporary_key FROM uploads WHERE id=$2",
      [u.mediaId, u.id],
    );
    for (const row of rows)
      await rm(storagePath(app.config.DATA_ROOT, row.storage_key), {
        force: true,
      });
    await app.db.query(
      "UPDATE media SET publication_state='WITHDRAWN',deleted_at=now() WHERE id=$1",
      [u.mediaId],
    );
  }
  await app.app.close();
});
async function create(a: Actor, bytes: number, legacy = false, extra = {}) {
  const r = await app.app.inject({
    method: "POST",
    url: legacy ? "/api/v1/admin/uploads" : "/api/v1/uploads",
    headers: a.headers,
    payload: {
      title: `[TEST] permission upload ${randomUUID()}`,
      description: "",
      originalName: "synthetic.mp4",
      expectedBytes: bytes,
      ...extra,
    },
  });
  expect(r.statusCode, r.body).toBe(200);
  const u = r.json() as UploadRecord;
  created.push(u);
  return u;
}
async function patch(
  a: Actor,
  u: UploadRecord,
  offset: number,
  bytes: Buffer,
  legacy = false,
) {
  return app.app.inject({
    method: "PATCH",
    url: `/api/v1/${legacy ? "admin/" : ""}uploads/${u.id}`,
    headers: {
      ...a.headers,
      "content-type": "application/octet-stream",
      "content-length": String(bytes.length),
      "upload-offset": String(offset),
    },
    payload: bytes,
  });
}
async function action(
  a: Actor,
  u: UploadRecord,
  suffix: string,
  method: "POST" | "DELETE" = "POST",
  payload = {},
) {
  return app.app.inject({
    method,
    url: `/api/v1/uploads/${u.id}${suffix}`,
    headers: a.headers,
    payload,
  });
}
async function get(a: Actor, id: string) {
  const r = await app.app.inject({
    url: `/api/v1/uploads/${id}`,
    headers: a.headers,
  });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as UserUpload;
}
async function completed(a: Actor, bytes: Buffer) {
  const u = await create(a, bytes.length);
  for (
    let offset = 0;
    offset < bytes.length;
    offset += app.config.UPLOAD_CHUNK_MAX_BYTES
  ) {
    expect(
      (
        await patch(
          a,
          u,
          offset,
          bytes.subarray(offset, offset + app.config.UPLOAD_CHUNK_MAX_BYTES),
        )
      ).statusCode,
    ).toBe(204);
  }
  const done = await action(a, u, "/complete");
  expect(done.statusCode, done.body).toBe(200);
  return { u, jobId: done.json().jobId as string };
}

it("PERM-UPLOAD-01..05/22: shared OWNER compatibility and PARTNER durable multichunk resume, completion and creator", async () => {
  const own = await create(owner, 3, true);
  expect(
    (await patch(owner, own, 0, Buffer.from("own"), true)).statusCode,
  ).toBe(204);
  const ownerDone = await app.app.inject({
    method: "POST",
    url: `/api/v1/admin/uploads/${own.id}/complete`,
    headers: owner.headers,
    payload: {},
  });
  expect(ownerDone.statusCode).toBe(200);
  const file = await largeUploadFixture(
    `.local/upload-work/${randomUUID()}.mp4`,
  );
  try {
    const bytes = (await stat(file)).size;
    expect(bytes).toBeGreaterThan(8 * 1024 ** 2);
    const u = await create(partner, bytes);
    const handle = await open(file, "r");
    try {
      // Hundreds of sequential chunks with a new device/session after the first ACK.
      const chunk = Buffer.alloc(64 * 1024);
      let device = partner,
        count = 0;
      for (let offset = 0; offset < bytes; offset += chunk.length) {
        const { bytesRead } = await handle.read(
          chunk,
          0,
          Math.min(chunk.length, bytes - offset),
          offset,
        );
        const r = await patch(device, u, offset, chunk.subarray(0, bytesRead));
        expect(r.statusCode, r.body).toBe(204);
        expect(r.headers["upload-offset"]).toBe(String(offset + bytesRead));
        count++;
        if (offset === 0) {
          device = await actor(app, "pareja");
          const head = await app.app.inject({
            method: "HEAD",
            url: `/api/v1/uploads/${u.id}`,
            headers: device.headers,
          });
          expect(head.statusCode).toBe(204);
          expect(head.headers["upload-offset"]).toBe(String(bytesRead));
          expect((await get(device, u.id)).offset).toBe(bytesRead);
        }
      }
      expect(count).toBe(544);
      const responses = await Promise.all([
        action(device, u, "/complete"),
        action(device, u, "/complete"),
      ]);
      expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
      expect(responses[0].json()).toEqual(responses[1].json());
    } finally {
      await handle.close();
    }
    const r = await get(partner, u.id);
    expect(r.state).toBe("completed");
    expect(r.offset).toBe(bytes);
    expect(r.preparation.phase).toBe("queued");
    const [identity] = await app.db.query<{
      owner_id: string;
      created_by: string;
    }>(
      "SELECT u.owner_id,m.created_by FROM uploads u JOIN media m ON m.id=u.media_id WHERE u.id=$1",
      [u.id],
    );
    expect(identity).toEqual({
      owner_id: partner.identity.user.id,
      created_by: partner.identity.user.id,
    });
    const jobs = await app.db.query(
      "SELECT id FROM jobs WHERE media_id=$1 AND kind='ingest'",
      [u.mediaId],
    );
    expect(jobs).toHaveLength(1);
    const [original] = await app.db.query<{
      storage_key: string;
      checksum: string;
    }>(
      "SELECT storage_key,checksum FROM assets WHERE media_id=$1 AND kind='original'",
      [u.mediaId],
    );
    expect(
      await checksum(storagePath(app.config.DATA_ROOT, original.storage_key)),
    ).toBe(await checksum(file));
    expect(original.checksum).toBe(await checksum(file));
    const audit = await app.db.query<{
      actor_id: string;
      action: string;
      safe_details_json: Record<string, unknown>;
    }>(
      "SELECT actor_id,action,safe_details_json FROM audit_events WHERE target_id=$1 ORDER BY created_at",
      [u.id],
    );
    expect(audit.map((a) => a.action).sort()).toEqual([
      "upload.completed",
      "upload.created",
    ]);
    expect(audit.every((a) => a.actor_id === partner.identity.user.id)).toBe(
      true,
    );
    expect(JSON.stringify(audit)).not.toContain("synthetic.mp4");
  } finally {
    await rm(file, { force: true });
  }
});

it("PERM-UPLOAD-07/08/11: all foreign upload verbs, job actions and browser-supplied ownership are denied without existence leaks", async () => {
  const u = await create(owner, 2);
  for (const id of [u.id, randomUUID()]) {
    for (const method of ["GET", "HEAD", "PATCH", "POST", "DELETE"] as const) {
      const r = await app.app.inject({
        method,
        url: `/api/v1/uploads/${id}${method === "POST" ? "/complete" : ""}`,
        headers:
          method === "PATCH"
            ? {
                ...partner.headers,
                "content-type": "application/octet-stream",
                "content-length": "1",
                "upload-offset": "0",
              }
            : partner.headers,
        ...(["GET", "HEAD"].includes(method)
          ? {}
          : { payload: method === "PATCH" ? Buffer.from("a") : {} }),
      });
      expect(r.statusCode, `${method}: ${r.body}`).toBe(404);
      if (method === "HEAD") expect(r.headers["upload-offset"]).toBeUndefined();
      else expect(r.json().code).toBe("NOT_FOUND");
    }
    for (const suffix of ["/retry", "/cancel-preparation"]) {
      const r = await action(partner, { ...u, id }, suffix);
      expect(r.statusCode).toBe(404);
      expect(r.json().code).toBe("NOT_FOUND");
    }
  }
  for (const extra of [
    { ownerId: owner.identity.user.id },
    { createdBy: owner.identity.user.id },
    { publicationState: "PUBLISHED" },
    { url: "https://example.com/video.mp4" },
  ]) {
    const r = await app.app.inject({
      method: "POST",
      url: "/api/v1/uploads",
      headers: partner.headers,
      payload: {
        title: "[TEST] rejected",
        description: "",
        originalName: "video.mp4",
        expectedBytes: 1,
        ...extra,
      },
    });
    expect(r.statusCode).toBe(400);
  }
  const own = await create(partner, 2);
  const list = await app.app.inject({
    url: "/api/v1/uploads?limit=100",
    headers: partner.headers,
  });
  expect(list.statusCode).toBe(200);
  expect(list.json().items.map((r: UserUpload) => r.id)).toContain(own.id);
  expect(list.json().items.map((r: UserUpload) => r.id)).not.toContain(u.id);
  expect(JSON.stringify(list.json())).not.toMatch(
    /temporary_key|encrypted_reference|storage_key/,
  );
  // The legacy namespace remains strictly administrative, even for a PARTNER's own file.
  for (const method of ["GET", "HEAD", "PATCH", "POST", "DELETE"] as const) {
    const r = await app.app.inject({
      method,
      url: `/api/v1/admin/uploads/${own.id}${method === "POST" ? "/complete" : ""}`,
      headers:
        method === "PATCH"
          ? {
              ...partner.headers,
              "content-type": "application/octet-stream",
              "content-length": "1",
              "upload-offset": "0",
            }
          : partner.headers,
      ...(["GET", "HEAD"].includes(method)
        ? {}
        : { payload: method === "PATCH" ? Buffer.from("a") : {} }),
    });
    expect(r.statusCode).toBe(403);
  }
});

it("PERM-UPLOAD-12..15: PARTNER never gains admin, publishing, metadata, deletion, sources or global jobs", async () => {
  const u = await create(partner, 1),
    foreign = await create(owner, 1);
  const routes: [
    "GET" | "POST" | "PATCH" | "DELETE" | "PUT",
    string,
    Record<string, unknown> | undefined,
  ][] = [
    ["GET", "/admin/videos", undefined],
    ["GET", "/admin/uploads", undefined],
    ["GET", "/admin/accounts", undefined],
    ["GET", "/admin/system", undefined],
    ["PATCH", "/admin/settings", { maintenance: true }],
    ["GET", "/admin/jobs", undefined],
    ["GET", "/admin/drive/status", undefined],
    ["POST", "/admin/drive/connect", {}],
    ["POST", "/admin/drive/import", {}],
    [
      "POST",
      "/admin/sources/inspect",
      { url: "https://example.com/video.mp4" },
    ],
    ["POST", `/admin/videos/${u.mediaId}/publish`, {}],
    ["POST", `/admin/videos/${u.mediaId}/withdraw`, {}],
    ["DELETE", `/admin/videos/${u.mediaId}`, {}],
    ["PATCH", `/admin/videos/${foreign.mediaId}`, { title: "Changed" }],
    ["POST", `/admin/videos/${u.mediaId}/sources`, {}],
    ["POST", `/admin/videos/${u.mediaId}/poster`, {}],
    ["POST", `/admin/videos/${u.mediaId}/subtitles`, {}],
    ["PUT", `/admin/videos/${u.mediaId}/chapters`, {}],
    ["POST", `/admin/videos/${u.mediaId}/hls`, {}],
    ["POST", `/admin/jobs/${randomUUID()}/retry`, {}],
    ["POST", `/admin/jobs/${randomUUID()}/cancel`, {}],
  ];
  for (const [method, path, payload] of routes) {
    const r = await app.app.inject({
      method,
      url: `/api/v1${path}`,
      headers: partner.headers,
      ...(payload === undefined ? {} : { payload }),
    });
    expect(r.statusCode, `${path}: ${r.body}`).toBe(403);
  }
  expect(
    (await app.auth.authenticate(partner.cookie.split("=")[1])).user.role,
  ).toBe("PARTNER");
});

it("PERM-UPLOAD-06/20: independent account limits, concurrent chunks and cancelling only an incomplete own upload", async () => {
  const ours = await Promise.all([create(owner, 2, true), create(partner, 2)]);
  const second = [await create(owner, 2), await create(partner, 2)];
  for (const a of [owner, partner]) {
    const r = await app.app.inject({
      method: "POST",
      url: "/api/v1/uploads",
      headers: a.headers,
      payload: {
        title: "[TEST] too many",
        description: "",
        originalName: "v.mp4",
        expectedBytes: 1,
      },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe("UPLOAD_LIMIT");
  }
  const chunks = await Promise.all([
    patch(owner, ours[0], 0, Buffer.from("ow"), true),
    patch(partner, ours[1], 0, Buffer.from("pl")),
  ]);
  expect(chunks.map((r) => r.statusCode)).toEqual([204, 204]);
  expect((await action(partner, second[1], "", "DELETE")).statusCode).toBe(200);
  expect((await get(partner, second[1].id)).state).toBe("cancelled");
  expect(
    (await patch(partner, second[1], 0, Buffer.from("a"))).statusCode,
  ).toBe(409);
  expect((await get(owner, second[0].id)).state).toBe("uploading");
  expect(
    (
      await app.db.query("SELECT 1 FROM media WHERE id=$1 AND created_by=$2", [
        second[1].mediaId,
        partner.identity.user.id,
      ])
    ).length,
  ).toBe(1);
});

it("PERM-UPLOAD-09/16..19/21: real single-job worker queue, reload, admin attribution, OWNER publication and normal library", async () => {
  const bytes = await readFile(".local/fixtures/short.mp4");
  const first = await completed(owner, bytes),
    next = await completed(partner, bytes);
  expect((await get(partner, next.u.id)).preparation.phase).toBe("queued");
  const libraryBefore = await app.app.inject({
    url: "/api/v1/library?limit=100",
    headers: partner.headers,
  });
  expect(
    libraryBefore.json().items.map((m: { id: string }) => m.id),
  ).not.toContain(next.u.mediaId);
  for (const path of [
    `/api/v1/media/${next.u.mediaId}`,
    `/api/v1/playback/${next.u.mediaId}/resolve`,
  ]) {
    const r = await app.app.inject({
      method: path.includes("resolve") ? "POST" : "GET",
      url: path,
      headers: partner.headers,
      ...(path.includes("resolve") ? { payload: {} } : {}),
    });
    expect(r.statusCode).toBe(404);
  }
  const admin = await app.app.inject({
    url: "/api/v1/admin/videos?publication=preparing&limit=100",
    headers: owner.headers,
  });
  expect(
    admin.json().items.find((m: { id: string }) => m.id === next.u.mediaId)
      .createdBy,
  ).toEqual({
    id: partner.identity.user.id,
    displayName: partner.identity.user.display_name,
  });
  expect(
    (
      await app.app.inject({
        url: `/api/v1/admin/uploads/${next.u.id}`,
        headers: owner.headers,
      })
    ).statusCode,
  ).toBe(200);
  const publish = () =>
    app.app.inject({
      method: "POST",
      url: `/api/v1/admin/videos/${next.u.mediaId}/publish`,
      headers: owner.headers,
      payload: {},
    });
  expect((await publish()).statusCode).toBe(409);
  const worker = new Worker(app.db, app.config);
  const run = worker.runNext();
  await expect
    .poll(
      async () =>
        (
          await app.db.query<{ state: string }>(
            "SELECT state FROM jobs WHERE id=$1",
            [first.jobId],
          )
        )[0].state,
      { interval: 10 },
    )
    .toBe("running");
  expect(await new Worker(app.db, app.config).runNext()).toBe(false);
  expect((await get(partner, next.u.id)).preparation.phase).toBe("queued");
  await run;
  expect((await get(owner, first.u.id)).preparation.phase).toBe("ready");
  const secondRun = worker.runNext();
  await expect
    .poll(async () => (await get(partner, next.u.id)).preparation.phase, {
      interval: 10,
    })
    .toBe("processing");
  const reload = await actor(app, "pareja");
  expect((await get(reload, next.u.id)).preparation.job?.state).toBe("running");
  await secondRun;
  expect((await get(reload, next.u.id)).preparation.phase).toBe("ready");
  expect(
    (
      await app.app.inject({
        method: "POST",
        url: `/api/v1/admin/videos/${next.u.mediaId}/publish`,
        headers: partner.headers,
        payload: {},
      })
    ).statusCode,
  ).toBe(403);
  expect((await publish()).statusCode).toBe(200);
  expect((await get(partner, next.u.id)).preparation.phase).toBe("published");
  for (const a of [owner, partner]) {
    const list = await app.app.inject({
      url: "/api/v1/library?limit=100",
      headers: a.headers,
    });
    expect(
      list.json().items.filter((m: { id: string }) => m.id === next.u.mediaId),
    ).toHaveLength(1);
    expect(
      (
        await app.app.inject({
          url: `/api/v1/media/${next.u.mediaId}`,
          headers: a.headers,
        })
      ).statusCode,
    ).toBe(200);
  }
  const [asset] = await app.db.query<{
    storage_key: string;
    checksum: string;
    id: string;
  }>(
    "SELECT id,storage_key,checksum FROM assets WHERE media_id=$1 AND kind='original'",
    [next.u.mediaId],
  );
  expect(
    await checksum(storagePath(app.config.DATA_ROOT, asset.storage_key)),
  ).toBe(asset.checksum);
  expect((await action(partner, next.u, "", "DELETE")).statusCode).toBe(409);
  expect(
    (await action(partner, next.u, "/cancel-preparation")).statusCode,
  ).toBe(409);
  expect(
    (
      await app.app.inject({
        method: "POST",
        url: `/api/v1/admin/videos/${next.u.mediaId}/withdraw`,
        headers: owner.headers,
        payload: {},
      })
    ).statusCode,
  ).toBe(200);
  for (const path of [
    `/api/v1/uploads/${next.u.id}`,
    `/api/v1/media/${next.u.mediaId}`,
    `/media/assets/${asset.id}`,
  ])
    expect(
      (await app.app.inject({ url: path, headers: partner.headers }))
        .statusCode,
    ).toBe(404);
  expect((await action(partner, next.u, "/retry")).statusCode).toBe(404);
  expect(
    await checksum(storagePath(app.config.DATA_ROOT, asset.storage_key)),
  ).toBe(asset.checksum);
});

it("PERM-UPLOAD-10/11: retry/cancel fences ownership, current draft generation and original; audit preserves actor", async () => {
  const bad = await completed(partner, Buffer.from("invalid video"));
  await new Worker(app.db, app.config).runNext();
  const failed = await get(partner, bad.u.id);
  expect(failed.preparation.phase).toBe("error");
  expect(failed.preparation.job?.retryable).toBe(true);
  expect(failed.preparation.canManagePreparation).toBe(true);
  const retry = await action(partner, bad.u, "/retry");
  expect(retry.statusCode, retry.body).toBe(200);
  expect((await get(partner, bad.u.id)).preparation.phase).toBe("queued");
  const cancel = await action(partner, bad.u, "/cancel-preparation");
  expect(cancel.statusCode, cancel.body).toBe(200);
  expect((await get(partner, bad.u.id)).preparation.phase).toBe("cancelled");
  expect((await action(partner, bad.u, "/retry")).statusCode).toBe(409);
  expect((await action(partner, bad.u, "", "DELETE")).statusCode).toBe(409);
  const [original] = await app.db.query<{ storage_key: string }>(
    "SELECT storage_key FROM assets WHERE media_id=$1 AND kind='original'",
    [bad.u.mediaId],
  );
  expect(
    (await stat(storagePath(app.config.DATA_ROOT, original.storage_key))).size,
  ).toBe(13);
  const audit = await app.db.query<{ actor_id: string; action: string }>(
    "SELECT actor_id,action FROM audit_events WHERE target_id=$1",
    [bad.jobId],
  );
  expect(audit).toHaveLength(2);
  expect(audit.every((r) => r.actor_id === partner.identity.user.id)).toBe(
    true,
  );
  for (const actionName of ["retry", "cancel-preparation"]) {
    const r = await action(partner, bad.u, `/${actionName}`, "POST", {
      jobId: randomUUID(),
    });
    expect(r.statusCode).toBe(400);
  }
  // Fixture state changes below prove that read flags and mutation checks agree.
  await app.db.query(
    "UPDATE jobs SET state='failed',cancel_requested=false,attempt=max_attempts WHERE id=$1",
    [bad.jobId],
  );
  expect((await action(partner, bad.u, "/retry")).statusCode).toBe(409);
  await app.db.query(
    "UPDATE jobs SET attempt=1,payload_json=payload_json || jsonb_build_object('contentGeneration',$2::text) WHERE id=$1",
    [bad.jobId, randomUUID()],
  );
  expect((await get(partner, bad.u.id)).preparation.canManagePreparation).toBe(
    false,
  );
  expect((await action(partner, bad.u, "/retry")).statusCode).toBe(409);
  await app.db.query("UPDATE jobs SET state='queued' WHERE id=$1", [bad.jobId]);
  expect((await action(partner, bad.u, "/cancel-preparation")).statusCode).toBe(
    409,
  );
});

it("upload capability preserves CSRF, Origin, idempotency and shared storage reservation", async () => {
  const body = {
    title: `[TEST] idempotent partner ${randomUUID()}`,
    description: "",
    originalName: "video.mp4",
    expectedBytes: 1,
  };
  for (const headers of [
    { ...partner.headers, origin: "https://example.com" },
    { ...partner.headers, "x-csrf-token": "wrong" },
  ]) {
    expect(
      (
        await app.app.inject({
          method: "POST",
          url: "/api/v1/uploads",
          headers,
          payload: body,
        })
      ).statusCode,
    ).toBe(403);
  }
  const headers = { ...partner.headers, "idempotency-key": randomUUID() };
  const [a, b] = await Promise.all([
    app.app.inject({
      method: "POST",
      url: "/api/v1/uploads",
      headers,
      payload: body,
    }),
    app.app.inject({
      method: "POST",
      url: "/api/v1/uploads",
      headers,
      payload: body,
    }),
  ]);
  expect(a.statusCode).toBe(200);
  expect(b.statusCode).toBe(200);
  expect(a.json()).toEqual(b.json());
  created.push(a.json());
  expect(
    (await app.db.query("SELECT id FROM media WHERE title=$1", [body.title]))
      .length,
  ).toBe(1);
  disk.unavailable = true;
  try {
    for (const [a, url] of [
      [partner, "/api/v1/uploads"],
      [owner, "/api/v1/admin/uploads"],
    ] as const) {
      const insufficient = await app.app.inject({
        method: "POST",
        url,
        headers: a.headers,
        payload: body,
      });
      expect(insufficient.statusCode).toBe(507);
      expect(insufficient.json().code).toBe("INSUFFICIENT_STORAGE");
    }
    expect(
      (await app.db.query("SELECT id FROM media WHERE title=$1", [body.title]))
        .length,
    ).toBe(1);
  } finally {
    disk.unavailable = false;
  }
});

it("PARTNER metadata category selection cannot rename an existing global category", async () => {
  const name = `Category${randomUUID()}`;
  await create(owner, 1, true, { category: name });
  await create(partner, 1, false, { category: name.toLowerCase() });
  expect(
    (
      await app.db.query<{ name: string }>(
        "SELECT name FROM categories WHERE normalized_name=$1",
        [name.toLowerCase()],
      )
    )[0].name,
  ).toBe(name);
});

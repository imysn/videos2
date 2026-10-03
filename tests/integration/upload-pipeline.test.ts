import { it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { request } from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import { testApp, actor } from "../helpers/context.js";
import { largeUploadFixture } from "../helpers/large-upload.js";
import {
  checksum,
  storagePath,
} from "../../apps/api/src/modules/media/storage.js";
import { Worker } from "../../apps/worker/src/worker.js";
import type {
  UploadPreparation,
  UploadRecord,
} from "../../packages/contracts/src/upload-pipeline.js";
import { createApp } from "../../apps/api/src/server.js";

let app: Awaited<ReturnType<typeof testApp>>,
  owner: Awaited<ReturnType<typeof actor>>,
  partner: Awaited<ReturnType<typeof actor>>;
beforeAll(async () => {
  app = await testApp();
  expect(app.config.APP_ENV).toBe("test");
  owner = await actor(app);
  partner = await actor(app, "pareja");
  await mkdir(".local/upload-work", { recursive: true });
});
beforeEach(async () => {
  await app.db.query(
    "UPDATE jobs SET state='cancelled',lease_until=NULL WHERE state IN ('queued','running')",
  );
});
afterAll(async () => {
  await app.app.close();
});
async function createUpload(bytes: number, name = "video.mp4") {
  const response = await app.app.inject({
    method: "POST",
    url: "/api/v1/admin/uploads",
    headers: owner.headers,
    payload: {
      title: `[TEST] upload pipeline ${randomUUID()}`,
      description: "",
      originalName: name,
      expectedBytes: bytes,
    },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as UploadRecord;
}
async function patch(
  upload: Pick<UploadRecord, "id">,
  offset: number,
  bytes: Buffer,
) {
  return app.app.inject({
    method: "PATCH",
    url: `/api/v1/admin/uploads/${upload.id}`,
    headers: {
      ...owner.headers,
      "content-type": "application/octet-stream",
      "content-length": String(bytes.length),
      "upload-offset": String(offset),
    },
    payload: bytes,
  });
}
async function complete(upload: Pick<UploadRecord, "id">) {
  const response = await app.app.inject({
    method: "POST",
    url: `/api/v1/admin/uploads/${upload.id}/complete`,
    headers: owner.headers,
    payload: {},
  });
  expect(response.statusCode).toBe(200);
  return response.json() as { mediaId: string; jobId: string };
}
async function preparation(mediaId: string) {
  const response = await app.app.inject({
    url: `/api/v1/media/${mediaId}`,
    headers: owner.headers,
  });
  expect(response.statusCode).toBe(200);
  return response.json().preparation as UploadPreparation;
}
async function original(mediaId: string) {
  const [row] = await app.db.query<{ storage_key: string; checksum: string }>(
    "SELECT storage_key,checksum FROM assets WHERE media_id=$1 AND kind='original'",
    [mediaId],
  );
  return {
    path: storagePath(app.config.DATA_ROOT, row.storage_key),
    checksum: row.checksum,
  };
}
async function bytesUpload(bytes: Buffer) {
  const u = await createUpload(bytes.length);
  expect((await patch(u, 0, bytes)).statusCode).toBe(204);
  return { upload: u, ...(await complete(u)) };
}

it("a slow live chunk does not expire its database transaction before durable acknowledgement", async () => {
  const a = app;
  let uploadId: string | undefined;
  try {
    const upload = (
      await a.app.inject({
        method: "POST",
        url: "/api/v1/admin/uploads",
        headers: owner.headers,
        payload: {
          title: "[TEST] slow chunk",
          description: "",
          originalName: "slow.bin",
          expectedBytes: 2,
        },
      })
    ).json() as { id: string };
    uploadId = upload.id;
    await a.app.listen({ host: "127.0.0.1", port: 0 });
    const status = await new Promise<number>((done, fail) => {
      const req = request(
        `${a.app.listeningOrigin}/api/v1/admin/uploads/${upload.id}`,
        {
          method: "PATCH",
          headers: {
            ...owner.headers,
            "content-type": "application/octet-stream",
            "content-length": "2",
            "upload-offset": "0",
          },
        },
        (response) => {
          response.resume();
          done(response.statusCode!);
        },
      );
      req.on("error", fail);
      req.write("a");
      setTimeout(() => req.end("b"), 11000);
    });
    expect(status).toBe(204);
    const head = await a.app.inject({
      method: "HEAD",
      url: `/api/v1/admin/uploads/${upload.id}`,
      headers: owner.headers,
    });
    expect(head.headers["upload-offset"]).toBe("2");
  } finally {
    if (uploadId)
      await a.app.inject({
        method: "DELETE",
        url: `/api/v1/admin/uploads/${uploadId}`,
        headers: owner.headers,
        payload: {},
      });
  }
}, 20000);

it("544 chunks, exact completion, concurrent completion, reload and the real worker's single-job queue", async () => {
  const file = await largeUploadFixture(
    `.local/upload-work/${randomUUID()}.mp4`,
  );
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const first = await createUpload(
      (await stat(".local/fixtures/short.mp4")).size,
    );
    const firstBytes = await readFile(".local/fixtures/short.mp4");
    for (
      let offset = 0;
      offset < firstBytes.length;
      offset += app.config.UPLOAD_CHUNK_MAX_BYTES
    )
      expect(
        (
          await patch(
            first,
            offset,
            firstBytes.subarray(
              offset,
              offset + app.config.UPLOAD_CHUNK_MAX_BYTES,
            ),
          )
        ).statusCode,
      ).toBe(204);
    const firstDone = await complete(first);
    const bytes = (await stat(file)).size,
      u = await createUpload(bytes);
    const f = await open(file, "r"),
      buffer = Buffer.alloc(65536);
    let offset = 0,
      requests = 0;
    try {
      while (offset < bytes) {
        const { bytesRead } = await f.read(
          buffer,
          0,
          Math.min(buffer.length, bytes - offset),
          offset,
        );
        const response = await patch(u, offset, buffer.subarray(0, bytesRead));
        expect(response.statusCode).toBe(204);
        offset = Number(response.headers["upload-offset"]);
        requests++;
      }
    } finally {
      await f.close();
    }
    expect(requests).toBe(544);
    expect(offset).toBe(bytes);
    const [done, again] = await Promise.all([complete(u), complete(u)]);
    expect(again).toEqual(done);
    expect(
      await app.db.query(
        "SELECT id FROM jobs WHERE media_id=$1 AND kind='ingest'",
        [u.mediaId],
      ),
    ).toHaveLength(1);
    expect(
      await app.db.query(
        "SELECT id FROM assets WHERE media_id=$1 AND kind='original'",
        [u.mediaId],
      ),
    ).toHaveLength(1);
    expect(await preparation(u.mediaId)).toMatchObject({
      phase: "queued",
      upload: { state: "completed", offset: bytes, expectedBytes: bytes },
      job: { id: done.jobId, state: "queued", progress: 0 },
    });
    const stored = await original(u.mediaId),
      expected = await checksum(file);
    expect(stored.checksum).toBe(expected);
    expect(await checksum(stored.path)).toBe(expected);
    const cfg = app.config;
    await app.app.close();
    const restarted = await createApp(cfg, { logger: false });
    app = { ...restarted, passwords: app.passwords };
    await app.app.ready();
    expect((await preparation(u.mediaId)).phase).toBe("queued");
    const list = await app.app.inject({
      url: "/api/v1/admin/videos?publication=preparing",
      headers: owner.headers,
    });
    expect(
      list.json().items.find((m: { id: string }) => m.id === u.mediaId)
        .preparation.phase,
    ).toBe("queued");
    expect(
      (
        await app.app.inject({
          method: "POST",
          url: `/api/v1/admin/videos/${u.mediaId}/publish`,
          headers: owner.headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(409);
    child = spawn(
      process.execPath,
      ["--import", "tsx", "apps/worker/src/main.ts"],
      { env: process.env, stdio: "ignore" },
    );
    await expect
      .poll(async () => (await preparation(firstDone.mediaId)).phase, {
        timeout: 10000,
        interval: 20,
      })
      .toBe("processing");
    expect((await preparation(u.mediaId)).phase).toBe("queued");
    expect(await new Worker(app.db, app.config).runNext()).toBe(false);
    await expect
      .poll(async () => (await preparation(u.mediaId)).phase, {
        timeout: 60000,
        interval: 30,
      })
      .toBe("processing");
    const running = await preparation(u.mediaId);
    const [row] = await app.db.query<{ progress: number }>(
      "SELECT progress FROM jobs WHERE id=$1",
      [done.jobId],
    );
    expect(Math.abs(running.job!.progress - row.progress)).toBeLessThanOrEqual(
      0.1,
    );
    await expect
      .poll(async () => (await preparation(u.mediaId)).phase, {
        timeout: 60000,
        interval: 100,
      })
      .toBe("ready");
    expect(await checksum(stored.path)).toBe(expected);
    expect(
      await app.db.query(
        "SELECT id FROM jobs WHERE media_id=$1 AND kind='ingest'",
        [u.mediaId],
      ),
    ).toHaveLength(1);
    expect(
      (
        await app.app.inject({
          method: "POST",
          url: `/api/v1/admin/videos/${u.mediaId}/publish`,
          headers: owner.headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect((await preparation(u.mediaId)).phase).toBe("published");
    const publicMedia = await app.app.inject({
      url: `/api/v1/media/${u.mediaId}`,
      headers: partner.headers,
    });
    expect(publicMedia.statusCode).toBe(200);
    expect(publicMedia.json()).not.toHaveProperty("preparation");
  } finally {
    if (child && child.exitCode === null) {
      const exit = new Promise<void>((done) =>
        child!.once("exit", () => done()),
      );
      child.kill("SIGTERM");
      await exit;
    }
    await rm(file, { force: true });
  }
});

it("real ingest failure stays visible; retry preserves the original and obeys maximum attempts", async () => {
  const data = Buffer.from("Not a valid media container"),
    u = await bytesUpload(data),
    stored = await original(u.mediaId),
    worker = new Worker(app.db, app.config);
  for (let attempt = 1; attempt <= 3; attempt++) {
    expect(await worker.runNext()).toBe(true);
    const p = await preparation(u.mediaId);
    expect(p).toMatchObject({
      phase: "error",
      safeErrorCode: "MEDIA_CORRUPT",
      job: { state: "failed", retryable: attempt < 3 },
    });
    expect(await checksum(stored.path)).toBe(stored.checksum);
    const retry = await app.app.inject({
      method: "POST",
      url: `/api/v1/admin/jobs/${u.jobId}/retry`,
      headers: owner.headers,
      payload: {},
    });
    expect(retry.statusCode).toBe(attempt < 3 ? 200 : 409);
    if (attempt < 3)
      expect(await preparation(u.mediaId)).toMatchObject({
        phase: "queued",
        job: { id: u.jobId, progress: 0 },
      });
  }
});

it("cancelling a queued ingest retains its original and cannot be retried as a failed job", async () => {
  const u = await bytesUpload(Buffer.from("original retained")),
    stored = await original(u.mediaId);
  expect(
    (
      await app.app.inject({
        method: "POST",
        url: `/api/v1/admin/jobs/${u.jobId}/cancel`,
        headers: owner.headers,
        payload: {},
      })
    ).statusCode,
  ).toBe(200);
  expect(await preparation(u.mediaId)).toMatchObject({
    phase: "cancelled",
    job: { state: "cancelled", retryable: false },
  });
  expect(await checksum(stored.path)).toBe(stored.checksum);
  expect(
    (
      await app.app.inject({
        method: "POST",
        url: `/api/v1/admin/jobs/${u.jobId}/retry`,
        headers: owner.headers,
        payload: {},
      })
    ).statusCode,
  ).toBe(409);
});

it("withdraw keeps processing semantics; delete cancels active work before intentional cleanup", async () => {
  const u = await bytesUpload(Buffer.from("preserved before deletion")),
    stored = await original(u.mediaId);
  expect(
    (
      await app.app.inject({
        method: "POST",
        url: `/api/v1/admin/videos/${u.mediaId}/withdraw`,
        headers: owner.headers,
        payload: {},
      })
    ).statusCode,
  ).toBe(200);
  expect(await preparation(u.mediaId)).toMatchObject({
    phase: "queued",
    job: { cancelRequested: false },
  });
  expect(await checksum(stored.path)).toBe(stored.checksum);
  expect(
    (
      await app.app.inject({
        method: "POST",
        url: "/api/v1/auth/reauth",
        headers: owner.headers,
        payload: { password: app.passwords.jason },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await app.app.inject({
        method: "DELETE",
        url: `/api/v1/admin/videos/${u.mediaId}`,
        headers: owner.headers,
        payload: {},
      })
    ).statusCode,
  ).toBe(200);
  const [job] = await app.db.query(
    "SELECT state,cancel_requested FROM jobs WHERE id=$1",
    [u.jobId],
  );
  expect(job).toEqual({ state: "cancelled", cancel_requested: true });
  expect(await checksum(stored.path)).toBe(stored.checksum);
});

it("different generation cannot be retried; same filename creates independent media", async () => {
  const one = await bytesUpload(Buffer.from("one")),
    two = await bytesUpload(Buffer.from("two"));
  expect(one.mediaId).not.toBe(two.mediaId);
  expect(one.jobId).not.toBe(two.jobId);
  await app.db.query(
    "UPDATE jobs SET state='failed',safe_error_code='CONTENT_GENERATION_MISMATCH' WHERE id=$1",
    [one.jobId],
  );
  await app.db.query("UPDATE media SET content_generation=$1 WHERE id=$2", [
    randomUUID(),
    one.mediaId,
  ]);
  expect(await preparation(one.mediaId)).toMatchObject({
    phase: "error",
    safeErrorCode: "CONTENT_GENERATION_MISMATCH",
    job: { retryable: false },
  });
  expect(
    (
      await app.app.inject({
        method: "POST",
        url: `/api/v1/admin/jobs/${one.jobId}/retry`,
        headers: owner.headers,
        payload: {},
      })
    ).statusCode,
  ).toBe(409);
  expect((await preparation(two.mediaId)).phase).toBe("queued");
});

it("partner cannot create, inspect or mutate uploads, jobs or unpublished drafts", async () => {
  const u = await bytesUpload(Buffer.from("private original"));
  for (const [method, url, payload] of [
    [
      "POST",
      "/api/v1/admin/uploads",
      {
        title: "forbidden",
        description: "",
        originalName: "x",
        expectedBytes: 1,
      },
    ],
    ["GET", `/api/v1/admin/uploads/${u.upload.id}`, undefined],
    ["HEAD", `/api/v1/admin/uploads/${u.upload.id}`, undefined],
    ["POST", `/api/v1/admin/jobs/${u.jobId}/cancel`, {}],
    ["POST", `/api/v1/admin/jobs/${u.jobId}/retry`, {}],
  ] as const)
    expect(
      (await app.app.inject({ method, url, headers: partner.headers, payload }))
        .statusCode,
    ).toBe(403);
  expect(
    (
      await app.app.inject({
        url: `/api/v1/media/${u.mediaId}`,
        headers: partner.headers,
      })
    ).statusCode,
  ).toBe(404);
});

it("durable offset is not advanced while fsync is pending; failed sync preserves the old offset", async () => {
  const u = await createUpload(8),
    f = await open(resolve(".local/upload-work", randomUUID()), "wx");
  const prototype = Object.getPrototypeOf(f) as FileHandle;
  await f.close();
  let release!: () => void, entered!: () => void;
  const enteredPromise = new Promise<void>((done) => {
      entered = done;
    }),
    gate = new Promise<void>((done) => {
      release = done;
    });
  const originalSync = prototype.sync;
  const spy = vi
    .spyOn(prototype, "sync")
    .mockImplementationOnce(async function (this: FileHandle) {
      entered();
      await gate;
      return originalSync.call(this);
    });
  try {
    const response = patch(u, 0, Buffer.from("1234"));
    await enteredPromise;
    expect(
      (
        await app.app.inject({
          method: "HEAD",
          url: `/api/v1/admin/uploads/${u.id}`,
          headers: owner.headers,
        })
      ).headers["upload-offset"],
    ).toBe("0");
    release();
    expect((await response).statusCode).toBe(204);
    spy.mockRestore();
    const failed = vi
      .spyOn(prototype, "sync")
      .mockRejectedValueOnce(
        Object.assign(new Error("Synthetic sync failure"), { code: "ENOSPC" }),
      );
    try {
      const r = await patch(u, 4, Buffer.from("5678"));
      expect(r.statusCode).toBe(507);
      expect(r.json().code).toBe("INSUFFICIENT_STORAGE");
    } finally {
      failed.mockRestore();
    }
    expect(
      (
        await app.app.inject({
          method: "HEAD",
          url: `/api/v1/admin/uploads/${u.id}`,
          headers: owner.headers,
        })
      ).headers["upload-offset"],
    ).toBe("4");
    const [row] = await app.db.query<{ temporary_key: string }>(
      "SELECT temporary_key FROM uploads WHERE id=$1",
      [u.id],
    );
    expect(
      await readFile(storagePath(app.config.DATA_ROOT, row.temporary_key)),
    ).toEqual(Buffer.from("1234"));
    expect((await patch(u, 4, Buffer.from("5678"))).statusCode).toBe(204);
    await complete(u);
    expect((await original(u.mediaId)).checksum).toBe(
      createHash("sha256").update("12345678").digest("hex"),
    );
  } finally {
    release();
    spy.mockRestore();
  }
});

it("missing confirmed bytes at completion persist a failed upload without an ingest", async () => {
  const u = await createUpload(4);
  expect((await patch(u, 0, Buffer.from("1234"))).statusCode).toBe(204);
  const [row] = await app.db.query<{ temporary_key: string }>(
    "SELECT temporary_key FROM uploads WHERE id=$1",
    [u.id],
  );
  const f = await open(
    storagePath(app.config.DATA_ROOT, row.temporary_key),
    "r+",
  );
  await f.truncate(2);
  await f.sync();
  await f.close();
  const response = await app.app.inject({
    method: "POST",
    url: `/api/v1/admin/uploads/${u.id}/complete`,
    headers: owner.headers,
    payload: {},
  });
  expect(response.statusCode).toBe(409);
  expect(response.json().code).toBe("UPLOAD_CORRUPT");
  expect(await preparation(u.mediaId)).toMatchObject({
    phase: "error",
    safeErrorCode: "UPLOAD_CORRUPT",
    upload: { state: "failed" },
    job: null,
  });
  expect(
    await app.db.query("SELECT id FROM jobs WHERE media_id=$1", [u.mediaId]),
  ).toHaveLength(0);
});

it("interrupted live body acknowledges nothing and resumes exactly, including an uncommitted crash tail", async () => {
  if (!app.app.server.listening)
    await app.app.listen({ host: "127.0.0.1", port: 0 });
  const data = Buffer.alloc(1024 ** 2, 42),
    u = await createUpload(data.length);
  await new Promise<void>((done) => {
    const req = request(
      `${app.app.listeningOrigin}/api/v1/admin/uploads/${u.id}`,
      {
        method: "PATCH",
        headers: {
          ...owner.headers,
          "content-type": "application/octet-stream",
          "content-length": String(data.length),
          "upload-offset": "0",
        },
      },
    );
    req.on("error", () => done());
    req.write(data.subarray(0, 128 * 1024));
    setTimeout(() => req.destroy(), 50);
  });
  await expect
    .poll(
      async () =>
        (
          await app.app.inject({
            method: "HEAD",
            url: `/api/v1/admin/uploads/${u.id}`,
            headers: owner.headers,
          })
        ).headers["upload-offset"],
    )
    .toBe("0");
  const [row] = await app.db.query<{ temporary_key: string }>(
    "SELECT temporary_key FROM uploads WHERE id=$1",
    [u.id],
  );
  const f = await open(
    storagePath(app.config.DATA_ROOT, row.temporary_key),
    "r+",
  );
  await f.write(Buffer.from("tail from an uncommitted write"), 0);
  await f.sync();
  await f.close();
  expect((await patch(u, 0, data)).statusCode).toBe(204);
  await complete(u);
  const stored = await original(u.mediaId);
  expect(await stat(stored.path)).toHaveProperty("size", data.length);
  expect(await checksum(stored.path)).toBe(
    createHash("sha256").update(data).digest("hex"),
  );
});

it("advertises the configured chunk ceiling and rejects an oversized body before allocation", async () => {
  const cfg = { ...app.config, UPLOAD_CHUNK_MAX_BYTES: 1024 };
  const small = await createApp(cfg, { logger: false, roomLock: false });
  try {
    const u = await createUpload(2048);
    const metadata = await small.app.inject({
      url: `/api/v1/admin/uploads/${u.id}`,
      headers: owner.headers,
    });
    expect(metadata.json().chunkMaxBytes).toBe(1024);
    const head = await small.app.inject({
      method: "HEAD",
      url: `/api/v1/admin/uploads/${u.id}`,
      headers: owner.headers,
    });
    expect(head.headers["upload-chunk-max-bytes"]).toBe("1024");
    const tooLarge = await small.app.inject({
      method: "PATCH",
      url: `/api/v1/admin/uploads/${u.id}`,
      headers: {
        ...owner.headers,
        "content-type": "application/octet-stream",
        "upload-offset": "0",
        "content-length": "2048",
      },
      payload: Buffer.alloc(2048),
    });
    expect(tooLarge.statusCode).toBe(400);
    expect(tooLarge.json().code).toBe("INVALID_CHUNK");
    for (const offset of [0, 1024]) {
      const ok = await small.app.inject({
        method: "PATCH",
        url: `/api/v1/admin/uploads/${u.id}`,
        headers: {
          ...owner.headers,
          "content-type": "application/octet-stream",
          "upload-offset": String(offset),
          "content-length": "1024",
        },
        payload: Buffer.alloc(1024),
      });
      expect(ok.statusCode).toBe(204);
    }
    await complete(u);
  } finally {
    await small.app.close();
  }
});

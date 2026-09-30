import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  statfs,
} from "node:fs/promises";
import { resolve } from "node:path";
import { testApp, actor } from "../helpers/context.js";
import { Worker } from "../../apps/worker/src/worker.js";
import { prepareVideo } from "../../apps/worker/src/media/process.js";
import { reserveSpace } from "../../apps/api/src/modules/media/uploads.js";
import {
  preparePath,
  checksum,
} from "../../apps/api/src/modules/media/storage.js";
let a: Awaited<ReturnType<typeof testApp>>,
  owner: Awaited<ReturnType<typeof actor>>;
beforeAll(async () => {
  a = await testApp();
  owner = await actor(a);
  expect(a.config.APP_ENV).toBe("test");
  await a.db.query(
    "UPDATE jobs SET state='cancelled',lease_until=NULL WHERE state IN ('queued','running')",
  );
});
afterAll(async () => {
  await a.app.close();
});
it("LIB-05/SEC-07 archivo corrupto falla realmente en ffprobe y no derriba la API", async () => {
  const media = await a.library.create(owner.identity, {
    title: "[TEST] corrupt worker",
    description: "",
  });
  const id = randomUUID(),
    key = `originals/${media}/${id}.bin`,
    path = await preparePath(a.config.DATA_ROOT, key);
  await writeFile(
    path,
    Buffer.from("This is deliberately not video; $(touch injected)"),
  );
  const sum = await checksum(path);
  await a.db.query(
    "INSERT INTO assets(id,media_id,kind,storage_key,mime_type,bytes,checksum) VALUES($1,$2,'original',$3,'application/octet-stream',$4,$5)",
    [id, media, key, (await readFile(path)).length, sum],
  );
  const job = await a.jobs.enqueue("ingest", media, `corrupt:${id}`, {
    assetId: id,
  });
  const worker = new Worker(a.db, a.config);
  expect(await worker.runNext()).toBe(true);
  const [result] = await a.db.query(
    "SELECT state,safe_error_code FROM jobs WHERE id=$1",
    [job.id],
  );
  expect(result).toEqual({ state: "failed", safe_error_code: "MEDIA_CORRUPT" });
  expect(await checksum(path)).toBe(sum);
  expect(
    await a.db.query(
      "SELECT id FROM assets WHERE media_id=$1 AND kind='compatible'",
      [media],
    ),
  ).toHaveLength(0);
  expect((await a.app.inject({ url: "/health/ready" })).statusCode).toBe(200);
  expect(
    await readdir(resolve(a.config.DATA_ROOT, "temp", job.id)),
  ).toHaveLength(0);
});
it("OPS-03 cancelar FFmpeg real conserva el original y termina el proceso", async () => {
  const input = resolve(".local/fixtures/adaptive.mp4"),
    out = resolve(".local/validation", `cancel-${randomUUID()}`),
    before = await checksum(input),
    controller = new AbortController();
  await mkdir(out, { recursive: true });
  const started = performance.now(),
    timer = setTimeout(() => controller.abort(), 50);
  try {
    await expect(
      prepareVideo(input, out, 2, controller.signal, () => {}),
    ).rejects.toThrow();
    expect(controller.signal.aborted).toBe(true);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(await checksum(input)).toBe(before);
    expect((await a.app.inject({ url: "/health/live" })).statusCode).toBe(200);
  } finally {
    clearTimeout(timer);
    await rm(out, { recursive: true, force: true });
  }
});
it("OPS-03 presupuesto real de statfs insuficiente rechaza antes de procesar", async () => {
  const fs = await statfs(a.config.DATA_ROOT),
    free = Number(fs.bavail) * Number(fs.bsize);
  await expect(reserveSpace(a.config.DATA_ROOT, free)).rejects.toMatchObject({
    code: "INSUFFICIENT_STORAGE",
  });
  // This checks the real volume budget, not a physical ENOSPC on a separate mount.
});
it("OPS-02 lease antiguo no puede publicar; éxito y publicación son atómicos", async () => {
  const worker = new Worker(a.db, a.config),
    job = await a.jobs.enqueue(
      "housekeeping",
      null,
      `fence:${randomUUID()}`,
      {},
    );
  await a.db.query(
    "UPDATE jobs SET state='running',attempt=1,lease_owner=$1,lease_until=now()+interval '30 seconds' WHERE id=$2",
    [worker.id, job.id],
  );
  const [claimed] = await a.db.query<
    import("../../apps/api/src/jobs/service.js").Job
  >("SELECT * FROM jobs WHERE id=$1", [job.id]);
  await a.db.query(
    "UPDATE jobs SET lease_owner='replacement',attempt=2 WHERE id=$1",
    [job.id],
  );
  let publications = 0;
  await expect(
    worker.publish(claimed, new AbortController().signal, async () => {
      publications++;
    }),
  ).rejects.toMatchObject({ code: "JOB_CANCELLED" });
  expect(publications).toBe(0);
  await a.db.query("UPDATE jobs SET lease_owner=$1,attempt=1 WHERE id=$2", [
    worker.id,
    job.id,
  ]);
  await expect(
    worker.publish(claimed, new AbortController().signal, async () => {
      await a.db.query(
        "INSERT INTO settings(key,value_json) VALUES($1,'true')",
        [job.id],
      );
      throw new Error("Crash before commit");
    }),
  ).rejects.toThrow("Crash before commit");
  expect(
    await a.db.query("SELECT 1 FROM settings WHERE key=$1", [job.id]),
  ).toHaveLength(0);
  await worker.publish(claimed, new AbortController().signal, async () => {
    await a.db.query("INSERT INTO settings(key,value_json) VALUES($1,'true')", [
      job.id,
    ]);
  });
  const [result] = await a.db.query("SELECT state FROM jobs WHERE id=$1", [
    job.id,
  ]);
  expect(result.state).toBe("succeeded");
  await expect(
    worker.publish(claimed, new AbortController().signal, async () => {
      publications++;
    }),
  ).rejects.toMatchObject({ code: "JOB_CANCELLED" });
  expect(publications).toBe(0);
});

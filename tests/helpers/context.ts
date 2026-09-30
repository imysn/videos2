import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../../apps/api/src/infrastructure/config.js";
import { createApp } from "../../apps/api/src/server.js";
import { Worker } from "../../apps/worker/src/worker.js";
import type { Identity } from "../../apps/api/src/modules/auth/service.js";
export async function testApp() {
  process.env.RAVE_CONFIG_FILE ??= resolve(".local/test/config.json");
  const app = await createApp(loadConfig(), { logger: false });
  await app.app.ready();
  const passwords = JSON.parse(
    await readFile(
      resolve(dirname(process.env.RAVE_CONFIG_FILE), "credentials.json"),
      "utf8",
    ),
  ) as Record<string, string>;
  return { ...app, passwords };
}
export async function actor(
  a: Awaited<ReturnType<typeof testApp>>,
  name = "jason",
) {
  const session = await a.auth.login(name, a.passwords[name], "Test");
  return {
    identity: session.identity,
    cookie: `${a.config.cookieName}=${session.raw}`,
    headers: {
      cookie: `${a.config.cookieName}=${session.raw}`,
      origin: a.config.origin,
      "x-csrf-token": session.identity.csrf,
      "content-type": "application/json",
      get "idempotency-key"() {
        return randomUUID();
      },
    },
  };
}
export async function syntheticVideo(
  a: Awaited<ReturnType<typeof testApp>>,
  i: Identity,
  file = "short.mp4",
) {
  const mediaId = await a.library.create(i, {
    title: `[TEST] ${file} ${randomUUID().slice(0, 8)}`,
    description: "Contenido sintético generado para pruebas",
  });
  const { copyFile, stat } = await import("node:fs/promises"),
    { preparePath, checksum } =
      await import("../../apps/api/src/modules/media/storage.js");
  const id = randomUUID(),
    key = `originals/${mediaId}/${id}.mp4`,
    path = await preparePath(a.config.DATA_ROOT, key);
  await copyFile(resolve(".local/fixtures", file), path);
  await a.db.query(
    "INSERT INTO assets(id,media_id,kind,storage_key,mime_type,bytes,checksum) VALUES($1,$2,'original',$3,'video/mp4',$4,$5)",
    [id, mediaId, key, (await stat(path)).size, await checksum(path)],
  );
  const job = await a.jobs.enqueue("ingest", mediaId, `test:${mediaId}`, {
    assetId: id,
  });
  const worker = new Worker(a.db, a.config);
  while (true) {
    await worker.runNext();
    const [j] = await a.db.query<{ state: string; safe_error_code: string }>(
      "SELECT state,safe_error_code FROM jobs WHERE id=$1",
      [job.id],
    );
    if (j.state === "succeeded") break;
    if (j.state === "failed") throw new Error(j.safe_error_code);
  }
  await a.db.query(
    "UPDATE media SET publication_state='PUBLISHED' WHERE id=$1",
    [mediaId],
  );
  return a.library.get(mediaId, i);
}

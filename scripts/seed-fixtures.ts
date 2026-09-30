import { testApp, actor, syntheticVideo } from "../tests/helpers/context.js";
import { writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { Worker } from "../apps/worker/src/worker.js";
const a = await testApp();
try {
  const owner = await actor(a);
  const index = resolve(".local/test/media.json");
  try {
    await access(index);
    console.log("Fixtures DB existentes conservados.");
  } catch {
    const existing = async (file: string) => {
      const [m] = await a.db.query<{ id: string }>(
        "SELECT id FROM media WHERE title LIKE $1 AND publication_state='PUBLISHED' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1",
        ["[TEST] " + file + "%"],
      );
      return m
        ? await a.library.get(m.id, owner.identity)
        : syntheticVideo(a, owner.identity, file);
    };
    const short = await existing("short.mp4"),
      long = await existing("long.mp4"),
      adaptive = await existing("adaptive.mp4");
    const job = await a.jobs.enqueue(
      "hls",
      adaptive.id,
      `hls:${adaptive.id}`,
      {},
    );
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
    await writeFile(
      index,
      JSON.stringify(
        { short: short.id, long: long.id, adaptive: adaptive.id },
        null,
        2,
      ),
    );
    console.log("Catálogo de test: MP4, vídeo largo y HLS de dos calidades.");
  }
  const s = await a.room.snapshot();
  if (s.sessionId) {
    await a.db.transaction(async (c) => {
      await c.query("UPDATE rooms SET active_session_id=NULL");
      await c.query(
        "UPDATE viewing_sessions SET ended_at=now() WHERE ended_at IS NULL",
      );
      await c.query("UPDATE playback_leases SET revoked_at=now()");
    });
  }
} finally {
  await a.app.close();
}

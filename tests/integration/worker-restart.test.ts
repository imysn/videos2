import { it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { testApp, actor, syntheticVideo } from "../helpers/context.js";
import { Worker } from "../../apps/worker/src/worker.js";
import { checksum } from "../../apps/api/src/modules/media/storage.js";
it("OPS-02: matar worker nativo durante job y expirar lease real permite un solo resultado durable", async () => {
  const app = await testApp(),
    owner = await actor(app),
    partner = await actor(app, "pareja");
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await app.db.query(
      "UPDATE jobs SET state='cancelled',lease_until=NULL WHERE state IN ('queued','running')",
    );
    const media = await syntheticVideo(app, owner.identity),
      [original] = await app.db.query(
        "SELECT storage_key,checksum FROM assets WHERE media_id=$1 AND kind='original'",
        [media.id],
      );
    const job = await app.jobs.enqueue(
      "hls",
      media.id,
      `restart:${media.id}`,
      {},
    );
    child = spawn(
      process.execPath,
      ["--import", "tsx", "apps/worker/src/main.ts"],
      { env: process.env, detached: true, stdio: "ignore" },
    );
    const exit = new Promise<void>((done) => child!.once("exit", () => done()));
    let claimed: Record<string, unknown> | undefined;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const [row] = await app.db.query(
        "SELECT state,attempt,lease_until FROM jobs WHERE id=$1",
        [job.id],
      );
      if (row.state === "running") {
        claimed = row;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(claimed?.attempt).toBe(1);
    await new Promise((r) => setTimeout(r, 250));
    process.kill(-child.pid!, "SIGKILL");
    await exit;
    child = undefined;
    const waitStarted = performance.now();
    let expired = false;
    while (performance.now() - waitStarted < 40000) {
      expect(
        (
          await app.app.inject({
            url: "/api/v1/library",
            headers: partner.headers,
          })
        ).statusCode,
      ).toBe(200);
      const [lease] = await app.db.query(
        "SELECT lease_until<now() AS expired,state FROM jobs WHERE id=$1",
        [job.id],
      );
      expect(lease.state).toBe("running");
      if (lease.expired) {
        expired = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(expired).toBe(true);
    const waited = (performance.now() - waitStarted) / 1000;
    expect(await new Worker(app.db, app.config).runNext()).toBe(true);
    const [done] = await app.db.query(
      "SELECT state,attempt FROM jobs WHERE id=$1",
      [job.id],
    );
    expect(done).toEqual({ state: "succeeded", attempt: 2 });
    expect(
      await app.db.query(
        "SELECT id FROM assets WHERE media_id=$1 AND kind='hls'",
        [media.id],
      ),
    ).toHaveLength(1);
    expect(
      await checksum(resolve(app.config.DATA_ROOT, original.storage_key)),
    ).toBe(original.checksum);
    await rm(resolve(app.config.DATA_ROOT, "temp", job.id), {
      recursive: true,
      force: true,
    });
    await mkdir("artifacts/verification", { recursive: true });
    await writeFile(
      "artifacts/verification/worker-restart.json",
      JSON.stringify(
        {
          status: "PASS",
          actualProcessGroupSigkill: true,
          actualLeaseExpiry: true,
          waitedSeconds: waited,
          attempts: 2,
          originalChecksumPreserved: true,
          singlePublishedHls: true,
          apiAvailable: true,
          containerVerified: false,
        },
        null,
        2,
      ),
    );
  } finally {
    if (child?.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already ended */
      }
    }
    await app.app.close();
  }
});

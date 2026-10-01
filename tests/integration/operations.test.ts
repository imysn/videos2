import { it, expect } from "vitest";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  copyFile,
  stat,
} from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { chromium, expect as browserExpect } from "@playwright/test";
import { Database } from "../../packages/db/src/index.js";
import { loadConfig } from "../../apps/api/src/infrastructure/config.js";
import { AuthService } from "../../apps/api/src/modules/auth/service.js";
import { LibraryService } from "../../apps/api/src/modules/library/service.js";
import { createApp } from "../../apps/api/src/server.js";
import {
  open,
  seal,
  type Ciphertext,
} from "../../apps/api/src/infrastructure/secrets.js";
import { checksum } from "../../apps/api/src/modules/media/storage.js";
import {
  createBackup,
  ageBinary,
  processCommand,
  pgEnvironment,
} from "../../scripts/backup.js";
import { rotateMasterKey } from "../../scripts/key-rotation.js";
async function fixture(previous = false) {
  const c = loadConfig();
  expect(c.APP_ENV).toBe("test");
  const name = `rave_ops_${randomUUID().replaceAll("-", "")}`,
    restore = `${name}_restore`;
  const url = new URL(c.databaseUrl),
    adminUrl = new URL(c.databaseUrl);
  adminUrl.pathname = "/postgres";
  const admin = new pg.Pool({ connectionString: adminUrl.href });
  await admin.query(`CREATE DATABASE "${name}"`);
  url.pathname = `/${name}`;
  const db = new Database(url.href),
    directory = await mkdtemp(resolve(".local/validation/ops-"));
  const config = {
    ...c,
    databaseUrl: url.href,
    DATA_ROOT: resolve(directory, "data"),
    BACKUP_TARGET: resolve(directory, "backups"),
  };
  await mkdir(config.DATA_ROOT, { mode: 0o700 });
  if (previous) {
    const sql = await readFile(
      "packages/db/migrations/001_initial.sql",
      "utf8",
    );
    await db.query(sql);
    await db.query(
      "CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())",
    );
    await db.query(
      "INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)",
      ["001_initial.sql", createHash("sha256").update(sql).digest("hex")],
    );
  } else await db.migrate();
  const auth = new AuthService(db, config),
    credentialsFile = resolve(directory, "credentials.json");
  await auth.bootstrap(credentialsFile);
  const passwords = JSON.parse(
    await readFile(credentialsFile, "utf8"),
  ) as Record<string, string>;
  for (const name of ["jason", "pareja"]) {
    const session = await auth.login(
      name,
      passwords[name],
      "Operational fixture",
    );
    await auth.changePassword(session.identity, passwords[name]);
  }
  const owner = await auth.login("jason", passwords.jason, "Fixture owner"),
    library = new LibraryService(db, config);
  const mediaId = await library.create(owner.identity, {
    title: "[TEST] operational MP4",
    description: "",
  });
  const id = randomUUID(),
    key = `fixture/${id}.mp4`,
    path = resolve(config.DATA_ROOT, key);
  await mkdir(resolve(config.DATA_ROOT, "fixture"));
  await copyFile(resolve(".local/fixtures/short.mp4"), path);
  const digest = await checksum(path);
  await db.query(
    "INSERT INTO assets(id,media_id,kind,storage_key,mime_type,bytes,checksum) VALUES($1,$2,'compatible',$3,'video/mp4',$4,$5)",
    [id, mediaId, key, (await stat(path)).size, digest],
  );
  const sourceId = await library.addSource(mediaId, "local", { assetId: id });
  await db.query(
    "UPDATE media SET duration_seconds=120,publication_state='PUBLISHED' WHERE id=$1",
    [mediaId],
  );
  const restoredUrl = new URL(url);
  restoredUrl.pathname = `/${restore}`;
  return {
    db,
    admin,
    directory,
    config,
    owner,
    mediaId,
    sourceId,
    id,
    key,
    digest,
    passwords,
    restore,
    restoredUrl,
    async restoreBackup(backup: string) {
      const extracted = resolve(directory, `extract-${randomUUID()}`);
      await mkdir(extracted);
      await processCommand(ageBinary(), [
        "-d",
        "-i",
        config.BACKUP_KEY_FILE,
        "-o",
        resolve(extracted, "backup.tar"),
        backup,
      ]);
      await processCommand("tar", [
        "-xf",
        resolve(extracted, "backup.tar"),
        "-C",
        extracted,
        "--no-same-owner",
      ]);
      const manifest = JSON.parse(
        await readFile(resolve(extracted, "manifest.json"), "utf8"),
      );
      expect(await checksum(resolve(extracted, "database.dump"))).toBe(
        manifest.databaseDumpSha256,
      );
      expect(await checksum(resolve(extracted, key))).toBe(digest);
      await admin.query(`CREATE DATABASE "${restore}"`);
      await processCommand(
        resolve(config.PG_BIN, "pg_restore"),
        [
          "--dbname",
          restore,
          "--no-owner",
          "--exit-on-error",
          resolve(extracted, "database.dump"),
        ],
        pgEnvironment(restoredUrl.href),
      );
      return extracted;
    },
    async cleanup() {
      await db.close();
      await admin.query(`DROP DATABASE IF EXISTS "${restore}"`);
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
it("OPS-06 upgrade de esquema previo y rollback respaldado conservan datos y vídeo real", async () => {
  const f = await fixture(true);
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    const jobId = randomUUID();
    await f.db.query(
      "INSERT INTO jobs(id,kind,media_id,unique_key,payload_json) VALUES($1,'ingest',$2,$3,$4)",
      [jobId, f.mediaId, jobId, { assetId: f.id }],
    );
    const backup = await createBackup(f.config),
      before = (
        await f.db.query("SELECT content_generation FROM media WHERE id=$1", [
          f.mediaId,
        ])
      )[0];
    await f.db.migrate();
    await f.db.migrate();
    expect(
      (
        await f.db.query("SELECT state,safe_error_code FROM jobs WHERE id=$1", [
          jobId,
        ])
      )[0],
    ).toEqual({
      state: "cancelled",
      safe_error_code: "CONTENT_GENERATION_UNKNOWN",
    });
    expect(
      (
        await f.db.query("SELECT content_generation FROM media WHERE id=$1", [
          f.mediaId,
        ])
      )[0],
    ).toEqual(before);
    expect(await checksum(resolve(f.config.DATA_ROOT, f.key))).toBe(f.digest);
    await expect(
      f.db.query(
        "INSERT INTO jobs(id,kind,media_id,unique_key) VALUES($1,'hls',$2,$3)",
        [randomUUID(), f.mediaId, randomUUID()],
      ),
    ).rejects.toThrow();
    const extracted = await f.restoreBackup(backup),
      db = new Database(f.restoredUrl.href);
    try {
      expect(
        (await db.query("SELECT state FROM jobs WHERE id=$1", [jobId]))[0]
          .state,
      ).toBe("queued");
      expect(
        await db.query("SELECT version FROM schema_migrations"),
      ).toHaveLength(1);
      expect(
        (
          await db.query("SELECT content_generation FROM media WHERE id=$1", [
            f.mediaId,
          ])
        )[0],
      ).toEqual(before);
    } finally {
      await db.close();
    }
    // Reapply the current compatible migrations in the restored namespace and
    // prove that rollback data supports login, playback and seeking.
    app = await createApp({
      ...f.config,
      databaseUrl: f.restoredUrl.href,
      DATA_ROOT: extracted,
    });
    await app.db.query(
      "UPDATE settings SET value_json='false' WHERE key='maintenance'",
    );
    await app.app.listen({ host: "127.0.0.1", port: f.config.PORT });
    const session = await app.auth.login(
        "jason",
        f.passwords.jason,
        "Rollback smoke",
      ),
      browser = await chromium.launch({
        executablePath: "/usr/bin/chromium",
        args: ["--no-sandbox"],
      });
    try {
      const context = await browser.newContext();
      await context.addCookies([
        {
          name: app.config.cookieName,
          value: session.raw,
          url: app.config.origin,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
      const page = await context.newPage();
      await page.goto(`${app.config.origin}/watch/${f.mediaId}`);
      await page
        .getByRole("button", { name: "Reproducir", exact: true })
        .click();
      await browserExpect
        .poll(async () =>
          page
            .locator("video")
            .evaluate((v: HTMLVideoElement) => v.currentTime),
        )
        .toBeGreaterThan(1);
      await page.getByRole("button", { name: "Avanzar 10 segundos" }).click();
      await browserExpect
        .poll(async () =>
          page
            .locator("video")
            .evaluate((v: HTMLVideoElement) => v.currentTime),
        )
        .toBeGreaterThan(10);
    } finally {
      await browser.close();
    }
    await mkdir("artifacts/restore", { recursive: true });
    await writeFile(
      "artifacts/restore/upgrade-rollback.json",
      JSON.stringify(
        {
          status: "PASS",
          previousSchema: "001_initial.sql",
          currentSchema: "002_job_generation.sql",
          legacyJobsFailClosed: true,
          originalChecksumPreserved: true,
          generationPreserved: true,
          rollbackToNewNamespace: true,
          realLoginPlaybackAndSeek: true,
          productionTouched: false,
          containerDeploymentVerified: false,
        },
        null,
        2,
      ),
    );
  } finally {
    await app?.app.close();
    await f.cleanup();
  }
});
it("SEC-09 rotación offline respaldada detecta ciphertext corrupto y conserva recuperación", async () => {
  const f = await fixture();
  try {
    const next = randomBytes(32),
      file = resolve(f.directory, "next-key");
    await writeFile(file, next.toString("base64"), { mode: 0o600 });
    const [source] = await f.db.query<{ encrypted_reference: Ciphertext }>(
      "SELECT encrypted_reference FROM sources WHERE id=$1",
      [f.sourceId],
    );
    const original = source.encrypted_reference;
    await f.db.query("UPDATE sources SET encrypted_reference=$1 WHERE id=$2", [
      { ...original, tag: randomBytes(16).toString("base64") },
      f.sourceId,
    ]);
    await expect(rotateMasterKey(f.config, file)).rejects.toThrow();
    expect(
      (
        await f.db.query(
          "SELECT value_json FROM settings WHERE key='maintenance'",
        )
      )[0].value_json,
    ).toBe(false);
    await f.db.query("UPDATE sources SET encrypted_reference=$1 WHERE id=$2", [
      original,
      f.sourceId,
    ]);
    const receiptId = randomUUID();
    await f.db.query(
      "INSERT INTO http_receipts(actor_user_id,request_key,operation,payload_hash,result_json) VALUES($1,$2,'TEST','fixture',$3)",
      [
        f.owner.identity.user.id,
        receiptId,
        seal(
          { status: 200, body: { id: f.mediaId } },
          f.config.masterKey,
          "http-receipt",
          `${f.owner.identity.user.id}:${receiptId}`,
        ),
      ],
    );
    const providerId = randomUUID();
    await f.db.query(
      "INSERT INTO provider_connections(id,provider,owner_id,encrypted_secrets,status) VALUES($1,'drive',$2,$3,'revoked')",
      [
        providerId,
        f.owner.identity.user.id,
        seal({ fixtureOnly: true }, f.config.masterKey, "provider", providerId),
      ],
    );
    const result = await rotateMasterKey(f.config, file);
    expect(result.counts).toEqual({ sources: 1, providers: 1, receipts: 1 });
    const rotated = (
      await f.db.query<{ encrypted_reference: Ciphertext }>(
        "SELECT encrypted_reference FROM sources WHERE id=$1",
        [f.sourceId],
      )
    )[0].encrypted_reference;
    expect(open(rotated, next, "source", f.sourceId)).toEqual({
      assetId: f.id,
    });
    expect(() =>
      open(rotated, f.config.masterKey, "source", f.sourceId),
    ).toThrow();
    expect(
      await f.db.query("SELECT id FROM sessions WHERE revoked_at IS NULL"),
    ).toHaveLength(0);
    await expect(createApp(f.config)).rejects.toMatchObject({
      code: "KEY_ROTATION_PENDING",
    });
    const configFile = resolve(f.directory, "config.json"),
      dsnFile = resolve(f.directory, "database-url");
    await writeFile(dsnFile, f.config.databaseUrl, { mode: 0o600 });
    const local = JSON.parse(
      await readFile(process.env.RAVE_CONFIG_FILE!, "utf8"),
    );
    await writeFile(
      configFile,
      JSON.stringify({
        ...local,
        DATA_ROOT: f.config.DATA_ROOT,
        BACKUP_TARGET: f.config.BACKUP_TARGET,
        DATABASE_URL_FILE: dsnFile,
      }),
      { mode: 0o600 },
    );
    await processCommand(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/key-rotation.ts",
        "--new-key-file",
        file,
        "--resume",
      ],
      { ...process.env, RAVE_CONFIG_FILE: configFile },
    );
    expect(JSON.parse(await readFile(configFile, "utf8")).MASTER_KEY_FILE).toBe(
      file,
    );
    expect(
      JSON.parse(await readFile(`${configFile}.rotation.json`, "utf8")).phase,
    ).toBe("COMPLETE");
    expect(
      (
        await f.db.query(
          "SELECT value_json FROM settings WHERE key='maintenance'",
        )
      )[0].value_json,
    ).toBe(false);
    const app = await createApp({
      ...f.config,
      masterKey: next,
      MASTER_KEY_FILE: file,
    });
    try {
      expect(
        (await app.auth.login("jason", f.passwords.jason, "Rotated smoke"))
          .identity.user.id,
      ).toBe(f.owner.identity.user.id);
    } finally {
      await app.app.close();
    }
    await f.restoreBackup(result.backup);
    const db = new Database(f.restoredUrl.href);
    try {
      const backed = (
        await db.query<{ encrypted_reference: Ciphertext }>(
          "SELECT encrypted_reference FROM sources WHERE id=$1",
          [f.sourceId],
        )
      )[0].encrypted_reference;
      expect(open(backed, f.config.masterKey, "source", f.sourceId)).toEqual({
        assetId: f.id,
      });
      expect(() => open(backed, next, "source", f.sourceId)).toThrow();
    } finally {
      await db.close();
    }
    await mkdir("artifacts/security", { recursive: true });
    await writeFile(
      "artifacts/security/key-rotation.json",
      JSON.stringify(
        {
          status: "PASS",
          offlineOnly: true,
          encryptedBackupBeforeRekey: true,
          corruptionRollsBack: true,
          allCiphertextKindsRekeyed: true,
          oldSessionsRevoked: true,
          oldKeyStartupRejected: true,
          actualCliResumeVerified: true,
          oldBackupRestoresWithOldKey: true,
          productionTouched: false,
        },
        null,
        2,
      ),
    );
  } finally {
    await f.cleanup();
  }
});

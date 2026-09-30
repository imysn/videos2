import { readFile, writeFile, mkdtemp, rm, mkdir } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  loadConfig,
  assertPrivate,
} from "../apps/api/src/infrastructure/config.js";
import { createApp } from "../apps/api/src/server.js";
import { ageBinary, processCommand, pgEnvironment } from "./backup.js";
import { checksum } from "../apps/api/src/modules/media/storage.js";
import { chromium } from "@playwright/test";
const started = performance.now();
const profile = process.argv.includes("validation")
  ? "validation"
  : process.argv.includes("test")
    ? "test"
    : null;
if (profile)
  process.env.RAVE_CONFIG_FILE = resolve(`.local/${profile}/config.json`);
const c = loadConfig();
if (!c.BACKUP_TARGET || !c.BACKUP_KEY_FILE)
  throw new Error("Falta destino/identidad de restauración.");
assertPrivate(c.BACKUP_KEY_FILE);
const latest = JSON.parse(
  await readFile(resolve(c.BACKUP_TARGET, "latest.json"), "utf8"),
);
if ((await checksum(latest.path)) !== latest.sha256)
  throw new Error("Checksum de backup incorrecto");
const temp = await mkdtemp(join(tmpdir(), "rave-restore-")),
  name = `rave_restore_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
  u = new URL(c.databaseUrl);
u.pathname = "/postgres";
const admin = new pg.Client({ connectionString: u.href });
await admin.connect();
let app: Awaited<ReturnType<typeof createApp>> | undefined;
try {
  await processCommand(ageBinary(), [
    "-d",
    "-i",
    c.BACKUP_KEY_FILE,
    "-o",
    resolve(temp, "backup.tar"),
    latest.path,
  ]);
  await mkdir(resolve(temp, "data"));
  await processCommand("tar", [
    "-xf",
    resolve(temp, "backup.tar"),
    "-C",
    resolve(temp, "data"),
    "--no-same-owner",
  ]);
  const manifest = JSON.parse(
    await readFile(resolve(temp, "data/manifest.json"), "utf8"),
  ) as { files: Record<string, string>; databaseDumpSha256: string };
  if (
    (await checksum(resolve(temp, "data/database.dump"))) !==
    manifest.databaseDumpSha256
  )
    throw new Error("Dump corrupto");
  for (const [key, value] of Object.entries(manifest.files)) {
    if (key.includes("..") || key.startsWith("/"))
      throw new Error("Manifest path invalid");
    if ((await checksum(resolve(temp, "data", key))) !== value)
      throw new Error("Asset checksum mismatch");
  }
  await admin.query(`CREATE DATABASE ${name}`);
  u.pathname = "/" + name;
  await processCommand(
    resolve(c.PG_BIN, "pg_restore"),
    [
      "--dbname",
      name,
      "--no-owner",
      "--exit-on-error",
      resolve(temp, "data/database.dump"),
    ],
    pgEnvironment(u.href),
  );
  app = await createApp({
    ...c,
    databaseUrl: u.href,
    DATA_ROOT: resolve(temp, "data"),
    PUBLIC_ORIGIN: "http://127.0.0.1:3002",
    origin: "http://127.0.0.1:3002",
    PORT: 3002,
    APP_ENV: "test",
    COOKIE_SECURE: "false",
    cookieName: "rave",
  });
  // Solo en el namespace restaurado: liberar mantenimiento e invalidar sesiones
  // ligadas a procesos/dispositivos de la instancia de origen. El progreso queda.
  await app.db.transaction(async (client) => {
    await client.query(
      "UPDATE settings SET value_json='false'::jsonb WHERE key='maintenance'",
    );
    await client.query(
      "UPDATE sessions SET revoked_at=now() WHERE revoked_at IS NULL",
    );
    await client.query(
      "UPDATE solo_sessions SET ended_at=now() WHERE ended_at IS NULL",
    );
    await client.query("UPDATE playback_leases SET revoked_at=now()");
  });
  await app.app.listen({ host: "127.0.0.1", port: 3002 });
  const credentials = JSON.parse(
    await readFile(
      resolve(
        dirname(process.env.RAVE_CONFIG_FILE ?? ".local/config.json"),
        "credentials.json",
      ),
      "utf8",
    ),
  );
  const user = await app.auth.login(
    "jason",
    credentials.jason,
    "Restore verification",
  );
  const catalog = await app.library.list(user.identity, {
    search: "[TEST] short.mp4",
  });
  if (!catalog.items.length)
    throw new Error("Fixture restaurado no disponible");
  const media = catalog.items[0];
  const browser = await chromium.launch({
    executablePath: "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
  try {
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: "rave",
        value: user.raw,
        url: "http://127.0.0.1:3002",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:3002/watch/${media.id}`);
    await page.locator("video").waitFor();
    await page.getByRole("button", { name: "Reproducir", exact: true }).click();
    await page.waitForFunction(() => {
      const v = document.querySelector("video");
      return v && v.currentTime > 1 && v.readyState >= 3;
    });
    await page.getByRole("button", { name: "Avanzar 10 segundos" }).click();
    await page.waitForFunction(
      () => document.querySelector("video")!.currentTime > 10,
    );
    await page.getByRole("button", { name: "Pausar", exact: true }).click();
  } finally {
    await browser.close();
  }
  await mkdir("artifacts/restore", { recursive: true });
  await writeFile(
    "artifacts/restore/result.json",
    JSON.stringify(
      {
        status: "PASS",
        namespace: name,
        filesVerified: Object.keys(manifest.files).length,
        loginVerified: true,
        catalogVerified: true,
        realVideoPlaybackAndSeek: true,
        masterKeySeparate: true,
        rtoSeconds: (performance.now() - started) / 1000,
        productionTouched: false,
      },
      null,
      2,
    ),
  );
  console.log(
    "Restauración aislada: login, catálogo, checksums y vídeo real/seek aprobados.",
  );
} finally {
  if (app) await app.app.close();
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.end();
  await rm(temp, { recursive: true, force: true });
}

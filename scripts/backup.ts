import { spawn } from "node:child_process";
import {
  mkdir,
  writeFile,
  readFile,
  readdir,
  stat,
  rm,
  mkdtemp,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../apps/api/src/infrastructure/config.js";
import type { Config } from "../apps/api/src/infrastructure/config.js";
import { Database } from "../packages/db/src/index.js";
import { checksum } from "../apps/api/src/modules/media/storage.js";
export function processCommand(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  return new Promise<void>((ok, fail) => {
    const p = spawn(binary, args, {
      env,
      stdio: ["ignore", "ignore", "pipe"],
      shell: false,
    });
    let error = "";
    p.stderr.on("data", (chunk) => {
      if (error.length < 2048) error += String(chunk);
    });
    p.on("error", fail);
    p.on("exit", (code) =>
      code === 0
        ? ok()
        : fail(
            new Error(
              `Operation failed: ${binary.split("/").at(-1)}, status ${code}; inspect private runtime logs.`,
            ),
          ),
    );
  });
}
export function pgEnvironment(dsn: string) {
  const u = new URL(dsn);
  return {
    ...process.env,
    PGHOST: u.hostname,
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: u.pathname.slice(1),
  };
}
export const ageBinary = () =>
  process.env.RAVE_AGE_BIN ?? "/workspace/rave-runtime/native/usr/bin/age";
export async function createBackup(c: Config = loadConfig()) {
  if (!c.BACKUP_TARGET || !c.BACKUP_RECIPIENT)
    throw new Error(
      "Configure BACKUP_TARGET y el destinatario público BACKUP_RECIPIENT.",
    );
  const db = new Database(c.databaseUrl);
  const lock = await db.pool.connect();
  const locked = await lock.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_lock(173007) AS locked",
  );
  if (!locked.rows[0].locked) {
    lock.release();
    await db.close();
    throw new Error("Otro backup está activo.");
  }
  const temp = await mkdtemp(join(tmpdir(), "rave-backup-"));
  let prior: unknown = false;
  try {
    const [old] = await db.query<{ value_json: unknown }>(
      "SELECT value_json FROM settings WHERE key='maintenance'",
    );
    prior = old?.value_json ?? false;
    await db.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(173005)");
      await client.query("SELECT pg_advisory_xact_lock(173006)");
      await client.query(
        "INSERT INTO settings(key,value_json) VALUES('maintenance','true') ON CONFLICT(key) DO UPDATE SET value_json='true'",
      );
    });
    let ready = false;
    for (let n = 0; n < 150; n++) {
      const running = await db.query(
        "SELECT 1 FROM jobs WHERE state='running' AND lease_until>now() LIMIT 1",
      );
      if (!running.length) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!ready)
      throw new Error(
        "Hay un trabajo activo; el backup no es consistente todavía.",
      );
    await processCommand(
      resolve(c.PG_BIN, "pg_dump"),
      [
        "--format=custom",
        "--no-owner",
        "--file",
        resolve(temp, "database.dump"),
      ],
      pgEnvironment(c.databaseUrl),
    );
    const files: Record<string, string> = {};
    for (const entry of await readdir(c.DATA_ROOT, { recursive: true })) {
      const path = resolve(c.DATA_ROOT, entry);
      if ((await stat(path)).isFile())
        files[String(entry)] = await checksum(path);
    }
    const manifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      databaseDumpSha256: await checksum(resolve(temp, "database.dump")),
      files,
      scope:
        "Incluye medios propios, DB y referencias; no contiene los vídeos remotos ni la clave maestra.",
      keyRequired: true,
      localCopyOnly: true,
    };
    await writeFile(
      resolve(temp, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      { mode: 0o600 },
    );
    await processCommand("tar", [
      "-cf",
      resolve(temp, "backup.tar"),
      "-C",
      temp,
      "database.dump",
      "manifest.json",
      "-C",
      c.DATA_ROOT,
      ".",
    ]);
    await mkdir(c.BACKUP_TARGET, { recursive: true, mode: 0o700 });
    const target = resolve(c.BACKUP_TARGET, `rave-${Date.now()}.tar.age`);
    await processCommand(ageBinary(), [
      "-r",
      c.BACKUP_RECIPIENT,
      "-o",
      target,
      resolve(temp, "backup.tar"),
    ]);
    await writeFile(
      resolve(c.BACKUP_TARGET, "latest.json"),
      JSON.stringify({
        path: target,
        createdAt: manifest.createdAt,
        sha256: await checksum(target),
      }),
      { mode: 0o600 },
    );
    const names = (await readdir(c.BACKUP_TARGET))
      .filter((n) => /^rave-\d+\.tar\.age$/.test(n))
      .sort()
      .reverse();
    const keep = new Set<string>(),
      days = new Set<number>(),
      weeks = new Set<number>();
    for (const name of names) {
      const ts = Number(name.slice(5, -8)),
        week = Math.floor(ts / (7 * 86400000));
      const day = Math.floor(ts / 86400000);
      if (days.size < 7 && !days.has(day)) {
        days.add(day);
        keep.add(name);
      }
      if (weeks.size < 4 && !weeks.has(week)) {
        weeks.add(week);
        keep.add(name);
      }
    }
    for (const name of names)
      if (!keep.has(name)) await rm(resolve(c.BACKUP_TARGET, name));
    await db.query(
      "INSERT INTO settings(key,value_json) VALUES('lastBackup',$1) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=now()",
      [JSON.stringify({ createdAt: manifest.createdAt, localCopyOnly: true })],
    );
    console.log(
      "Backup cifrado y checksums guardados en el destino configurado. Clave maestra excluida.",
    );
    return target;
  } finally {
    await db
      .query(
        "INSERT INTO settings(key,value_json) VALUES('maintenance',$1) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
        [JSON.stringify(prior)],
      )
      .catch(() => {});
    await lock.query("SELECT pg_advisory_unlock(173007)").catch(() => {});
    lock.release();
    await db.close();
    await rm(temp, { recursive: true, force: true });
  }
}
if (import.meta.url === new URL(process.argv[1], "file:").href) {
  const profile = process.argv.includes("validation")
    ? "validation"
    : process.argv.includes("test")
      ? "test"
      : null;
  if (profile) {
    process.env.RAVE_CONFIG_FILE = resolve(`.local/${profile}/config.json`);
    const cfg = JSON.parse(
      await readFile(process.env.RAVE_CONFIG_FILE, "utf8"),
    );
    const identity = resolve(
      dirname(process.env.RAVE_CONFIG_FILE),
      "backup_identity",
    );
    try {
      await stat(identity);
    } catch {
      await processCommand(ageBinary().replace(/age$/, "age-keygen"), [
        "-o",
        identity,
      ]);
    }
    const { execFileSync } = await import("node:child_process");
    cfg.BACKUP_RECIPIENT = execFileSync(
      ageBinary().replace(/age$/, "age-keygen"),
      ["-y", identity],
      { encoding: "utf8" },
    ).trim();
    cfg.BACKUP_KEY_FILE = identity;
    await writeFile(
      process.env.RAVE_CONFIG_FILE,
      JSON.stringify(cfg, null, 2),
      { mode: 0o600 },
    );
  }
  await createBackup();
}

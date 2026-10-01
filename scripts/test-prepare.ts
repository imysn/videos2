import { mkdir, writeFile, access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { execFileSync } from "node:child_process";
import { ageBinary } from "./backup.js";
import { loadConfig } from "../apps/api/src/infrastructure/config.js";
import { Database } from "../packages/db/src/index.js";
import { AuthService } from "../apps/api/src/modules/auth/service.js";
const namespace = process.argv.includes("validation") ? "validation" : "test";
const suffix = process.env.RAVE_TEST_DATABASE_SUFFIX ?? "";
if (suffix && !/^[a-z0-9_]{1,48}$/.test(suffix))
  throw new Error("Invalid isolated test database suffix");
const dbName = `rave_${namespace}${suffix ? `_${suffix}` : ""}`;
const current = loadConfig(),
  base = resolve(`.local/${namespace}`);
await mkdir(base, { recursive: true, mode: 0o700 });
const url = new URL(current.databaseUrl);
url.pathname = "/postgres";
const client = new pg.Client({ connectionString: url.href });
await client.connect();
if (
  !(await client.query("SELECT 1 FROM pg_database WHERE datname=$1", [dbName]))
    .rowCount
)
  await client.query(`CREATE DATABASE ${dbName}`);
await client.end();
url.pathname = `/${dbName}`;
const secret = async (name: string, text: string) => {
  const file = resolve(base, name);
  try {
    await access(file);
  } catch {
    await writeFile(file, text, { mode: 0o600, flag: "wx" });
  }
  return file;
};
const database = await secret("database_url", url.href),
  key = await secret("master_key", randomBytes(32).toString("base64"));
const data = resolve(base, "data");
await mkdir(data, { recursive: true, mode: 0o700 });
const backupIdentity = resolve(base, "backup_identity");
try {
  await access(backupIdentity);
} catch {
  execFileSync(
    ageBinary().replace(/age$/, "age-keygen"),
    ["-o", backupIdentity],
    { stdio: "ignore" },
  );
}
const recipient = execFileSync(
  ageBinary().replace(/age$/, "age-keygen"),
  ["-y", backupIdentity],
  { encoding: "utf8" },
).trim();
const configPath = resolve(base, "config.json");
await writeFile(
  configPath,
  JSON.stringify(
    {
      APP_ENV: "test",
      PUBLIC_ORIGIN:
        namespace === "test"
          ? "http://127.0.0.1:3001"
          : "http://127.0.0.1:3003",
      PORT: namespace === "test" ? 3001 : 3003,
      COOKIE_SECURE: "false",
      DATA_ROOT: data,
      DATABASE_URL_FILE: database,
      MASTER_KEY_FILE: key,
      PG_BIN: current.PG_BIN,
      BACKUP_TARGET: resolve(base, "backups"),
      BACKUP_KEY_FILE: backupIdentity,
      BACKUP_RECIPIENT: recipient,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
process.env.RAVE_CONFIG_FILE = configPath;
const cfg = loadConfig(),
  db = new Database(cfg.databaseUrl);
await db.migrate();
const auth = new AuthService(db, cfg),
  credentials = resolve(base, "credentials.json");
await auth.bootstrap(credentials);
await db.query("UPDATE users SET must_change_password=false"); // Exclusively the synthetic test namespace.
await readFile(credentials);
await db.close();
console.log(
  `Namespace de pruebas ${dbName} preparado; secretos privados, sin modificar las cuentas de Rave.`,
);

import { mkdir, writeFile, access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
const base = resolve(
  process.env.RAVE_RUNTIME_ROOT ?? "/workspace/rave-runtime/state",
);
await mkdir(base, { recursive: true, mode: 0o700 });
await mkdir(".local", { recursive: true });
const secret = async (name: string, value: string) => {
  const p = resolve(base, name);
  try {
    await access(p);
  } catch {
    await writeFile(p, value, { flag: "wx", mode: 0o600 });
  }
  return p;
};
const pw = await secret("pg_password", randomBytes(32).toString("base64url"));
const dsn = await secret(
  "database_url",
  `postgresql://rave:${encodeURIComponent((await readFile(pw, "utf8")).trim())}@127.0.0.1:54329/rave`,
);
const key = await secret("master_key", randomBytes(32).toString("base64"));
const pgBin =
  process.env.RAVE_PG_BIN ??
  "/workspace/rave-runtime/native/usr/lib/postgresql/17/bin";
const data = resolve(base, "postgres");
try {
  await access(resolve(data, "PG_VERSION"));
} catch {
  const r = spawnSync(
    resolve(pgBin, "initdb"),
    [
      "-D",
      data,
      "-U",
      "rave",
      "--pwfile",
      pw,
      "--auth=scram-sha-256",
      "--encoding=UTF8",
      "--locale=C.UTF-8",
    ],
    { stdio: "inherit" },
  );
  if (r.status !== 0) throw new Error("initdb failed");
}
const conf = resolve(".local/config.json");
try {
  await access(conf);
} catch {
  await writeFile(
    conf,
    JSON.stringify(
      {
        APP_ENV: "development",
        PUBLIC_ORIGIN: "http://127.0.0.1:3000",
        PORT: 3000,
        COOKIE_SECURE: "false",
        DATA_ROOT: resolve(base, "data"),
        DATABASE_URL_FILE: dsn,
        MASTER_KEY_FILE: key,
        PG_BIN: pgBin,
        BACKUP_TARGET: resolve(base, "backups"),
        GOOGLE_REDIRECT_URI:
          "http://127.0.0.1:3000/api/v1/admin/drive/callback",
      },
      null,
      2,
    ),
  );
}
await mkdir(resolve(base, "socket"), { recursive: true, mode: 0o700 });
console.log(
  "Configuración local creada sin revelar secretos. Credenciales DB y clave: directorio privado de runtime.",
);

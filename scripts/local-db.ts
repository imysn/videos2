import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { loadConfig } from "../apps/api/src/infrastructure/config.js";
import pg from "pg";
const c = loadConfig();
const base = resolve(
  process.env.RAVE_RUNTIME_ROOT ?? "/workspace/rave-runtime/state",
);
const pgCtl = resolve(c.PG_BIN, "pg_ctl");
const data = resolve(base, "postgres");
const status = spawnSync(pgCtl, ["-D", data, "status"], { stdio: "ignore" });
if (status.status !== 0) {
  const r = spawnSync(
    pgCtl,
    [
      "-D",
      data,
      "-l",
      resolve(base, "postgres.log"),
      "-o",
      `-h 127.0.0.1 -p 54329 -k ${resolve(base, "socket")}`,
      "-w",
      "start",
    ],
    { stdio: "inherit" },
  );
  if (r.status !== 0) throw new Error("PostgreSQL failed");
}
const u = new URL(c.databaseUrl);
u.pathname = "/postgres";
const db = new pg.Client({ connectionString: u.href });
await db.connect();
const existing = await db.query("SELECT 1 FROM pg_database WHERE datname=$1", [
  "rave",
]);
if (!existing.rowCount) await db.query("CREATE DATABASE rave");
await db.end();
console.log("PostgreSQL listo en loopback, DB rave.");

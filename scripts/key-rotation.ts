import { readFile, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { Database } from "../packages/db/src/index.js";
import {
  loadConfig,
  privateFile,
  type Config,
} from "../apps/api/src/infrastructure/config.js";
import {
  open,
  seal,
  type Ciphertext,
} from "../apps/api/src/infrastructure/secrets.js";
import { assert } from "../apps/api/src/infrastructure/errors.js";
import { createBackup } from "./backup.js";

// Offline operation: keep both key files and the encrypted pre-rotation backup.
// The new key is never printed, returned or placed in the database/backup.
export async function rotateMasterKey(config: Config, nextKeyFile: string) {
  const next = Buffer.from(privateFile(nextKeyFile), "base64");
  assert(
    next.length === 32 && !next.equals(config.masterKey),
    "INVALID_ROTATION_KEY",
  );
  const db = new Database(config.databaseUrl),
    lock = await db.pool.connect();
  let maintenance: unknown = false,
    changed = false,
    guarded = false;
  try {
    const result = await lock.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(173004) AS locked",
    );
    assert(result.rows[0].locked, "STOP_API_BEFORE_ROTATION", 409);
    await db.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(173005)");
      await client.query("SELECT pg_advisory_xact_lock(173006)");
      assert(
        !(
          await db.query(
            "SELECT id FROM jobs WHERE state='running' AND lease_until>now()",
            [],
            client,
          )
        ).length,
        "STOP_WORKER_BEFORE_ROTATION",
        409,
      );
      maintenance =
        (
          await db.query(
            "SELECT value_json FROM settings WHERE key='maintenance'",
            [],
            client,
          )
        )[0]?.value_json ?? false;
      await client.query(
        "INSERT INTO settings(key,value_json) VALUES('maintenance','true') ON CONFLICT(key) DO UPDATE SET value_json='true'",
      );
      guarded = true;
    });
    const backup = await createBackup(config);
    const counts = { sources: 0, providers: 0, receipts: 0 };
    await db.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(173005)");
      await client.query("SELECT pg_advisory_xact_lock(173006)");
      for (const source of await db.query<{
        id: string;
        encrypted_reference: Ciphertext;
      }>("SELECT id,encrypted_reference FROM sources FOR UPDATE", [], client)) {
        const reference = open(
          source.encrypted_reference,
          config.masterKey,
          "source",
          source.id,
        );
        await client.query(
          "UPDATE sources SET encrypted_reference=$1 WHERE id=$2",
          [
            seal(
              reference,
              next,
              "source",
              source.id,
              source.encrypted_reference.keyVersion + 1,
            ),
            source.id,
          ],
        );
        counts.sources++;
      }
      for (const provider of await db.query<{
        id: string;
        encrypted_secrets: Ciphertext;
      }>(
        "SELECT id,encrypted_secrets FROM provider_connections FOR UPDATE",
        [],
        client,
      )) {
        const secrets = open(
          provider.encrypted_secrets,
          config.masterKey,
          "provider",
          provider.id,
        );
        await client.query(
          "UPDATE provider_connections SET encrypted_secrets=$1 WHERE id=$2",
          [
            seal(
              secrets,
              next,
              "provider",
              provider.id,
              provider.encrypted_secrets.keyVersion + 1,
            ),
            provider.id,
          ],
        );
        counts.providers++;
      }
      for (const receipt of await db.query<{
        actor_user_id: string;
        request_key: string;
        result_json: Ciphertext;
      }>(
        "SELECT actor_user_id,request_key,result_json FROM http_receipts FOR UPDATE",
        [],
        client,
      )) {
        const id = `${receipt.actor_user_id}:${receipt.request_key}`;
        const result = open(
          receipt.result_json,
          config.masterKey,
          "http-receipt",
          id,
        );
        await client.query(
          "UPDATE http_receipts SET result_json=$1 WHERE actor_user_id=$2 AND request_key=$3",
          [
            seal(
              result,
              next,
              "http-receipt",
              id,
              receipt.result_json.keyVersion + 1,
            ),
            receipt.actor_user_id,
            receipt.request_key,
          ],
        );
        counts.receipts++;
      }
      await client.query(
        "UPDATE sessions SET revoked_at=now() WHERE revoked_at IS NULL",
      );
      await client.query("UPDATE playback_leases SET revoked_at=now()");
      await client.query(
        "UPDATE solo_sessions SET ended_at=now() WHERE ended_at IS NULL",
      );
      await client.query(
        "INSERT INTO settings(key,value_json) VALUES('keyRotation',$1) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
        [
          JSON.stringify({
            phase: "DB_REKEYED",
            keyFingerprint: createHash("sha256").update(next).digest("hex"),
            backup,
            nextKeyFile,
            counts,
            previousMaintenance: maintenance,
          }),
        ],
      );
    });
    changed = true;
    // Keep maintenance until the caller durably selects nextKeyFile. A crash
    // here has a known recovery path with both keys and the paired backup.
    return { backup, nextKeyFile, counts, previousMaintenance: maintenance };
  } finally {
    if (guarded && !changed)
      await db.query(
        "UPDATE settings SET value_json=$1 WHERE key='maintenance'",
        [JSON.stringify(maintenance)],
      );
    await lock.query("SELECT pg_advisory_unlock(173004)");
    lock.release();
    await db.close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const index = process.argv.indexOf("--new-key-file");
  if (index < 0 || !process.argv[index + 1])
    throw new Error(
      "Uso: pnpm rotate:key --new-key-file /ruta/privada/clave-nueva",
    );
  if (process.env.MASTER_KEY_FILE)
    throw new Error(
      "Selecciona un JSON RAVE_CONFIG_FILE sin override MASTER_KEY_FILE para la rotación offline.",
    );
  const file = resolve(process.env.RAVE_CONFIG_FILE ?? ".local/config.json"),
    config = loadConfig();
  const json = JSON.parse(await readFile(file, "utf8"));
  const nextFile = resolve(process.argv[index + 1]),
    journal = `${file}.rotation.json`;
  let result: Awaited<ReturnType<typeof rotateMasterKey>>;
  if (process.argv.includes("--resume")) {
    const db = new Database(config.databaseUrl);
    try {
      const stored = (
        await db.query<{
          value_json: Awaited<ReturnType<typeof rotateMasterKey>> & {
            phase: string;
            keyFingerprint: string;
          };
        }>("SELECT value_json FROM settings WHERE key='keyRotation'")
      )[0]?.value_json;
      assert(
        stored?.phase === "DB_REKEYED" &&
          stored.nextKeyFile === nextFile &&
          createHash("sha256")
            .update(Buffer.from(privateFile(nextFile), "base64"))
            .digest("hex") === stored.keyFingerprint,
        "INVALID_ROTATION_RESUME",
      );
      result = stored;
    } finally {
      await db.close();
    }
  } else {
    await writeFile(
      journal,
      JSON.stringify({
        phase: "PREPARED",
        oldKeyFile: config.MASTER_KEY_FILE,
        nextKeyFile: nextFile,
      }),
      { mode: 0o600, flag: "wx" },
    );
    result = await rotateMasterKey(config, nextFile);
  }
  await writeFile(journal, JSON.stringify({ ...result, phase: "DB_REKEYED" }), {
    mode: 0o600,
  });
  const temporary = `${file}.next`;
  await writeFile(
    temporary,
    JSON.stringify({ ...json, MASTER_KEY_FILE: nextFile }, null, 2),
    { mode: 0o600 },
  );
  await rename(temporary, file);
  const db = new Database(config.databaseUrl);
  try {
    await db.transaction(async (client) => {
      await client.query(
        "UPDATE settings SET value_json=$1 WHERE key='maintenance'",
        [JSON.stringify(result.previousMaintenance)],
      );
      await client.query(
        "UPDATE settings SET value_json=jsonb_set(value_json,'{phase}','\"COMPLETE\"') WHERE key='keyRotation'",
      );
    });
  } finally {
    await db.close();
  }
  await writeFile(journal, JSON.stringify({ ...result, phase: "COMPLETE" }), {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      status: "PASS",
      ...result.counts,
      backupCreated: true,
      sessionsRevoked: true,
      configUpdated: true,
    }),
  );
}

import { createHash } from "node:crypto";
import type { Database } from "../../../../packages/db/src/index.js";
import type { Config } from "./config.js";
import { assert } from "./errors.js";
export async function checkMasterKey(db: Database, config: Config) {
  const [state] = await db.query<{ value_json: { keyFingerprint: string } }>(
    "SELECT value_json FROM settings WHERE key='keyRotation'",
  );
  assert(
    !state ||
      state.value_json.keyFingerprint ===
        createHash("sha256").update(config.masterKey).digest("hex"),
    "KEY_ROTATION_PENDING",
    503,
  );
}

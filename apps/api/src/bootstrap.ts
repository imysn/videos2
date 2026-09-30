import { loadConfig } from "./infrastructure/config.js";
import { Database } from "../../../packages/db/src/index.js";
import { AuthService } from "./modules/auth/service.js";
import { resolve, dirname } from "node:path";
const c = loadConfig();
const db = new Database(c.databaseUrl);
try {
  await db.migrate();
  const file =
    c.BOOTSTRAP_CREDENTIALS_FILE ??
    resolve(dirname(c.MASTER_KEY_FILE), "bootstrap-credentials.json");
  const count = await new AuthService(db, c).bootstrap(file);
  console.log(
    JSON.stringify({
      created: count,
      credentialsFile: count ? file : null,
      existingAccountsPreserved: true,
    }),
  );
} finally {
  await db.close();
}

import { loadConfig } from "../apps/api/src/infrastructure/config.js";
import { Database } from "../packages/db/src/index.js";
const db = new Database(loadConfig().databaseUrl);
try {
  await db.migrate();
  console.log("Migraciones aplicadas/verificadas.");
} finally {
  await db.close();
}

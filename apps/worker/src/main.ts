import { loadConfig } from "../../api/src/infrastructure/config.js";
import { Database } from "../../../packages/db/src/index.js";
import { Worker } from "./worker.js";
const db = new Database(loadConfig().databaseUrl),
  worker = new Worker(db, loadConfig());
process.on("SIGTERM", () => {
  worker.stopping = true;
});
process.on("SIGINT", () => {
  worker.stopping = true;
});
let lastCleanup = 0,
  lastBackupAttempt = 0;
while (!worker.stopping) {
  if (Date.now() - lastCleanup > 86400000) {
    await worker.housekeeping();
    lastCleanup = Date.now();
  }
  const worked = await worker.runNext();
  if (
    !worked &&
    worker.config.APP_ENV === "production" &&
    worker.config.BACKUP_RECIPIENT &&
    worker.config.BACKUP_TARGET &&
    Date.now() - lastBackupAttempt > 3600000
  ) {
    lastBackupAttempt = Date.now();
    const [last] = await db.query<{ value_json: { createdAt?: string } }>(
      "SELECT value_json FROM settings WHERE key='lastBackup'",
    );
    if (
      !last?.value_json.createdAt ||
      Date.now() - Date.parse(last.value_json.createdAt) >= 86400000
    ) {
      try {
        const { createBackup } = await import("../../../scripts/backup.js");
        await createBackup();
      } catch {
        console.error(
          "BACKUP_FAILED: revisar configuración y estado privado; siguiente intento acotado.",
        );
      }
    }
  }
  if (!worked) await new Promise((r) => setTimeout(r, 1000));
}
await db.close();

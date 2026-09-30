import { mkdir, writeFile } from "node:fs/promises";
import { loadConfig } from "../apps/api/src/infrastructure/config.js";
import { createApp } from "../apps/api/src/server.js";
const app = await createApp(loadConfig(), { logger: false, roomLock: false });
try {
  await mkdir("docs", { recursive: true });
  await writeFile(
    "docs/openapi.json",
    JSON.stringify(app.http.openApi(), null, 2) + "\n",
  );
  console.log(
    "Contrato HTTP generado: docs/openapi.json. No se sirve documentación pública.",
  );
} finally {
  await app.app.close();
}

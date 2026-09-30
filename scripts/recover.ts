import { loadConfig } from "../apps/api/src/infrastructure/config.js";
import { Database } from "../packages/db/src/index.js";
import { AuthService } from "../apps/api/src/modules/auth/service.js";
import { writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
const c = loadConfig(),
  db = new Database(c.databaseUrl);
try {
  const username = process.argv[2] ?? "jason";
  const [u] = await db.query<{ id: string }>(
    "SELECT id FROM users WHERE username=$1",
    [username],
  );
  if (!u) throw new Error("Unknown account");
  const t = await new AuthService(db, c).reset(u.id);
  const file = resolve(
    dirname(c.BOOTSTRAP_CREDENTIALS_FILE ?? c.MASTER_KEY_FILE),
    `reset-${Date.now()}.txt`,
  );
  await writeFile(file, `${c.origin}/activate#${t}`, {
    mode: 0o600,
    flag: "wx",
  });
  console.log(`Enlace de un uso guardado en archivo privado: ${file}`);
} finally {
  await db.close();
}

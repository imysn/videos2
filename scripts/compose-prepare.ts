import { mkdir, writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
const base = resolve(".local/production");
await mkdir(base, { recursive: true, mode: 0o700 });
async function secret(name: string, value: string) {
  const path = resolve(base, name);
  try {
    await access(path);
  } catch {
    await writeFile(path, value, { mode: 0o600, flag: "wx" });
  }
}
await secret("postgres_password", randomBytes(32).toString("base64url"));
const { readFile } = await import("node:fs/promises");
const password = (
  await readFile(resolve(base, "postgres_password"), "utf8")
).trim();
await secret(
  "database_url",
  `postgresql://rave:${encodeURIComponent(password)}@db:5432/rave`,
);
await secret("master_key", randomBytes(32).toString("base64"));
await secret(
  "../compose.env",
  "PUBLIC_ORIGIN=http://127.0.0.1:3000\nRAVE_HOST=localhost\nRAVE_IMAGE_TAG=v1\nRAVE_SECRET_DIR=./.local/production\n",
);
console.log(
  "Secrets privados preparados; no se muestran valores. Compose local usa solo loopback.",
);

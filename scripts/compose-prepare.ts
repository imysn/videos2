import { mkdir, writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
const production = process.argv.includes("--production");
const origin = production ? process.env.PUBLIC_ORIGIN : "http://127.0.0.1:3000";
if (!origin) throw new Error("PUBLIC_ORIGIN HTTPS requerido para producción");
const url = new URL(origin);
if (
  (production && url.protocol !== "https:") ||
  url.pathname !== "/" ||
  url.search ||
  url.hash ||
  url.username ||
  url.password ||
  /[\r\n]/.test(origin)
)
  throw new Error(
    "PUBLIC_ORIGIN debe ser un origen HTTPS sin ruta ni credenciales",
  );
const base = resolve(process.env.RAVE_SECRET_DIR ?? ".local/production");
const envFile = resolve(
  process.env.RAVE_COMPOSE_ENV_FILE ?? ".local/compose.env",
);
const imageTag = process.env.RAVE_IMAGE_TAG ?? "v1";
if (!/^[\w][\w.-]{0,127}$/.test(imageTag))
  throw new Error("RAVE_IMAGE_TAG inválido");
if (/[\r\n'\\]/.test(base)) throw new Error("RAVE_SECRET_DIR inválido");
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
await mkdir(resolve(envFile, ".."), { recursive: true, mode: 0o700 });
try {
  await access(envFile);
} catch {
  await writeFile(
    envFile,
    `PUBLIC_ORIGIN=${url.origin}\n${production ? "" : "RAVE_HOST=localhost\n"}RAVE_IMAGE_TAG=${imageTag}\nRAVE_SECRET_DIR='${base}'\n`,
    { mode: 0o600, flag: "wx" },
  );
}
console.log(
  `Secrets privados preparados sin sobrescribir archivos existentes; perfil ${production ? "producción HTTPS" : "local loopback"}. No se muestran valores.`,
);

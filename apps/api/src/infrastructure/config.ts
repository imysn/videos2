import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { z } from "zod";
const schema = z.object({
  APP_ENV: z.enum(["development", "test", "production"]).default("development"),
  PUBLIC_ORIGIN: z.url().default("http://127.0.0.1:3000"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  COOKIE_SECURE: z.enum(["true", "false"]).default("false"),
  DATA_ROOT: z.string(),
  DATABASE_URL_FILE: z.string(),
  MASTER_KEY_FILE: z.string(),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(21474836480),
  UPLOAD_CHUNK_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(8388608)
    .default(8388608),
  FFMPEG_THREADS: z.coerce.number().int().min(1).max(2).default(2),
  MEDIA_JOB_CONCURRENCY: z.coerce.number().int().min(1).max(1).default(1),
  BOOTSTRAP_CREDENTIALS_FILE: z.string().optional(),
  CHAT_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  LOG_RETENTION_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  AUDIT_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(90),
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET_FILE: z.string().default(""),
  GOOGLE_PICKER_API_KEY: z.string().default(""),
  GOOGLE_CLOUD_PROJECT_NUMBER: z.string().default(""),
  GOOGLE_REDIRECT_URI: z.url().optional(),
  BACKUP_TARGET: z.string().optional(),
  BACKUP_RECIPIENT: z.string().default(""),
  BACKUP_KEY_FILE: z.string().default(""),
  PG_BIN: z.string().default("/usr/lib/postgresql/17/bin"),
});
export type Config = z.infer<typeof schema> & {
  databaseUrl: string;
  masterKey: Buffer;
  cookieName: string;
  origin: string;
  googleConfigured: boolean;
};
export function privateFile(path: string): string {
  assertPrivate(path);
  return readFileSync(path, "utf8").trim();
}
export function assertPrivate(path: string): void {
  if (!isAbsolute(path)) throw new Error("Secret file must be absolute");
  const st = statSync(path);
  if (!st.isFile() || (st.mode & 0o077) !== 0)
    throw new Error("Secret file must be private (0600)");
}
export function loadConfig(): Config {
  const file = process.env.RAVE_CONFIG_FILE ?? resolve(".local/config.json");
  const local: Record<string, unknown> = existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8"))
    : {};
  const c = schema.parse({ ...local, ...process.env });
  const u = new URL(c.PUBLIC_ORIGIN);
  if (u.pathname !== "/" || u.search || u.hash || u.username || u.password)
    throw new Error("PUBLIC_ORIGIN must be an origin");
  if (
    c.APP_ENV === "production" &&
    (u.protocol !== "https:" || c.COOKIE_SECURE !== "true")
  )
    throw new Error("Production requires HTTPS and secure cookies");
  if (
    c.APP_ENV !== "production" &&
    !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)
  )
    throw new Error("Development/test must use loopback");
  const masterKey = Buffer.from(privateFile(c.MASTER_KEY_FILE), "base64");
  if (masterKey.length !== 32)
    throw new Error("MASTER_KEY must contain 32 random bytes");
  return {
    ...c,
    databaseUrl: privateFile(c.DATABASE_URL_FILE),
    masterKey,
    cookieName: c.APP_ENV === "production" ? "__Host-rave" : "rave",
    origin: u.origin,
    googleConfigured: !!(
      c.GOOGLE_CLIENT_ID &&
      c.GOOGLE_CLIENT_SECRET_FILE &&
      c.GOOGLE_PICKER_API_KEY &&
      c.GOOGLE_CLOUD_PROJECT_NUMBER
    ),
  };
}

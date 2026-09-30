import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
  timingSafeEqual,
} from "node:crypto";
export interface Ciphertext {
  v: 1;
  nonce: string;
  tag: string;
  body: string;
  keyVersion: number;
}
export function seal(
  value: unknown,
  key: Buffer,
  type: string,
  id: string,
  keyVersion = 1,
): Ciphertext {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(Buffer.from(`${type}:${id}:${keyVersion}`));
  const body = Buffer.concat([
    c.update(JSON.stringify(value), "utf8"),
    c.final(),
  ]);
  return {
    v: 1,
    nonce: nonce.toString("base64"),
    tag: c.getAuthTag().toString("base64"),
    body: body.toString("base64"),
    keyVersion,
  };
}
export function open<T>(
  value: Ciphertext,
  key: Buffer,
  type: string,
  id: string,
): T {
  if (value.v !== 1) throw new Error("Unsupported cipher");
  const d = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(value.nonce, "base64"),
  );
  d.setAAD(Buffer.from(`${type}:${id}:${value.keyVersion}`));
  d.setAuthTag(Buffer.from(value.tag, "base64"));
  return JSON.parse(
    Buffer.concat([
      d.update(Buffer.from(value.body, "base64")),
      d.final(),
    ]).toString("utf8"),
  ) as T;
}
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export const token = () => randomBytes(32).toString("base64url");
export function same(a: string, b: string): boolean {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

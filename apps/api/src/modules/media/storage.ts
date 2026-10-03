import { realpath, stat, mkdir, open } from "node:fs/promises";
import { resolve, sep, dirname } from "node:path";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { assert } from "../../infrastructure/errors.js";
export function storagePath(root: string, key: string): string {
  assert(
    /^[a-zA-Z0-9_./-]+$/.test(key) &&
      key.split("/").every((p) => p && p !== "." && p !== ".."),
    "INVALID_STORAGE_KEY",
    400,
  );
  const file = resolve(root, key);
  assert(file.startsWith(resolve(root) + sep), "INVALID_STORAGE_KEY", 400);
  return file;
}
export async function existingPath(root: string, key: string): Promise<string> {
  const p = await realpath(storagePath(root, key));
  assert(
    p.startsWith((await realpath(root)) + sep),
    "INVALID_STORAGE_KEY",
    400,
  );
  return p;
}
export async function preparePath(root: string, key: string) {
  const p = storagePath(root, key);
  await mkdir(dirname(p), { recursive: true, mode: 0o700 });
  return p;
}
// fsync(file) preserves data; directory entries also need syncing after create/rename.
export async function syncParents(root: string, file: string) {
  const base = resolve(root);
  for (
    let directory = dirname(file);
    directory === base || directory.startsWith(base + sep);
    directory = dirname(directory)
  ) {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (directory === base) break;
  }
}
export async function checksum(file: string) {
  const h = createHash("sha256");
  for await (const v of createReadStream(file)) h.update(v);
  return h.digest("hex");
}
export function parseRange(
  value: string | undefined,
  size: number,
): { start: number; end: number; partial: boolean } {
  if (!value) return { start: 0, end: Math.max(0, size - 1), partial: false };
  assert(Number.isSafeInteger(size) && size > 0, "INVALID_RANGE", 416);
  const m = /^bytes=(\d*)-(\d*)$/.exec(value);
  assert(m && (m[1] || m[2]), "INVALID_RANGE", 416);
  let start: number, end: number;
  if (!m[1]) {
    const count = Number(m[2]);
    assert(Number.isSafeInteger(count) && count > 0, "INVALID_RANGE", 416);
    start = Math.max(0, size - count);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Number(m[2]) : size - 1;
    assert(
      Number.isSafeInteger(start) &&
        Number.isSafeInteger(end) &&
        start < size &&
        end >= start,
      "INVALID_RANGE",
      416,
    );
    end = Math.min(end, size - 1);
  }
  return { start, end, partial: true };
}
export async function fileInfo(path: string) {
  const s = await stat(path);
  assert(s.isFile(), "NOT_FOUND", 404);
  return s;
}

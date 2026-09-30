import { createFile, type MP4BoxBuffer } from "mp4box";
import { assert } from "../../infrastructure/errors.js";
import type { SafeFetch } from "../../infrastructure/safe-fetch/index.js";
export async function mp4Duration(
  first: Buffer,
  total: number,
  url: string,
  safe: SafeFetch,
  signal?: AbortSignal,
) {
  const file = createFile(false);
  let duration = 0;
  file.onReady = (info) => {
    if (info.videoTracks.length) duration = info.duration / info.timescale;
  };
  const append = (bytes: Buffer, start: number) => {
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as MP4BoxBuffer;
    buffer.fileStart = start;
    return file.appendBuffer(buffer);
  };
  let next = append(first, 0);
  for (
    let n = 0;
    n < 2 && !duration && Number.isSafeInteger(next) && next < total;
    n++
  ) {
    const end = Math.min(total - 1, next + 1048575);
    const part = await safe.limited(
      url,
      1048576,
      signal,
      `bytes=${next}-${end}`,
    );
    assert(
      part.response.status === 206 &&
        part.response.headers["content-range"]?.startsWith(`bytes ${next}-`),
      "SOURCE_NOT_SEEKABLE",
    );
    next = append(part.bytes, next);
  }
  file.flush();
  assert(
    Number.isFinite(duration) && duration > 0,
    "SOURCE_DURATION_UNKNOWN",
    409,
  );
  return duration;
}
export function webmDuration(bytes: Buffer) {
  let scale = 1000000,
    duration = 0,
    visited = 0;
  const vint = (position: number, identifier = false) => {
    assert(position < bytes.length, "SOURCE_DURATION_UNKNOWN");
    let width = 1,
      mask = 128;
    while (width <= 8 && !(bytes[position] & mask)) {
      width++;
      mask >>= 1;
    }
    assert(
      width <= 8 && position + width <= bytes.length,
      "SOURCE_DURATION_UNKNOWN",
    );
    let value = identifier ? bytes[position] : bytes[position] & (mask - 1);
    for (let n = 1; n < width; n++) value = value * 256 + bytes[position + n];
    return { width, value };
  };
  const walk = (start: number, end: number, depth: number) => {
    assert(depth < 5, "SOURCE_UNSUPPORTED");
    let p = start;
    while (p < end && p < bytes.length && visited++ < 10000) {
      const id = vint(p, true);
      p += id.width;
      const size = vint(p);
      p += size.width;
      const next = p + size.value;
      if (id.value === 0x18538067 || id.value === 0x1549a966)
        walk(p, Math.min(next, end, bytes.length), depth + 1);
      else if (id.value === 0x2ad7b1 && next <= bytes.length) {
        scale = 0;
        for (let n = p; n < next; n++) scale = scale * 256 + bytes[n];
      } else if (id.value === 0x4489 && next <= bytes.length) {
        if (size.value === 4) duration = bytes.readFloatBE(p);
        if (size.value === 8) duration = bytes.readDoubleBE(p);
      }
      if (next > bytes.length) break;
      p = next;
    }
  };
  walk(0, bytes.length, 0);
  const seconds = (duration * scale) / 1e9;
  assert(
    Number.isFinite(seconds) && seconds > 0,
    "SOURCE_DURATION_UNKNOWN",
    409,
  );
  return seconds;
}
export function signedExpiry(raw: string) {
  const u = new URL(raw),
    absolute = Number(u.searchParams.get("Expires"));
  if (Number.isFinite(absolute) && absolute > 0)
    return new Date(absolute * 1000).toISOString();
  const date = u.searchParams.get("X-Amz-Date"),
    ttl = Number(u.searchParams.get("X-Amz-Expires"));
  if (date && /^\d{8}T\d{6}Z$/.test(date) && ttl > 0) {
    const start = Date.parse(
      `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`,
    );
    if (Number.isFinite(start))
      return new Date(start + ttl * 1000).toISOString();
  }
  return undefined;
}

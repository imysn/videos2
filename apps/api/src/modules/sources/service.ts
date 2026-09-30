import { mp4Duration, webmDuration } from "./duration.js";
import { parse as parseHls } from "hls-parser";
import { XMLParser } from "fast-xml-parser";
import { SafeFetch, remoteUrl } from "../../infrastructure/safe-fetch/index.js";
import { assert, AppError } from "../../infrastructure/errors.js";
import {
  baseCapabilities,
  type LibraryService,
  type MediaRow,
  type SourceRow,
  type UrlReference,
} from "../library/service.js";
import type { PlaybackDescriptor } from "../../../../../packages/contracts/src/index.js";
export interface Inspection {
  kind: "http_file" | "hls" | "dash";
  health: "READY" | "UNSUPPORTED";
  durationSeconds: number;
  bytes: number;
  mimeType: string;
  seekable: boolean;
  delivery: "direct" | "relay";
  approvedOrigins: string[];
  fingerprint: string | null;
}
export interface SourceAdapter<R> {
  inspect(reference: R, signal?: AbortSignal): Promise<Inspection>;
  resolvePlayback(
    m: MediaRow,
    s: SourceRow,
    signal?: AbortSignal,
  ): Promise<PlaybackDescriptor>;
  checkHealth(reference: R, signal?: AbortSignal): Promise<Inspection>;
}
const allowsCors = (value: string | undefined, origin: string | undefined) =>
  value === "*" || (origin !== undefined && value === origin);
const asObject = (v: unknown): Record<string, unknown> => {
  assert(v && typeof v === "object" && !Array.isArray(v), "SOURCE_UNSUPPORTED");
  return v as Record<string, unknown>;
};
export function validateDash(
  text: string,
  url: URL,
): { origins: string[]; duration: number } {
  assert(
    !/<!DOCTYPE|<!ENTITY|xlink:|<ContentProtection/i.test(text),
    "SOURCE_UNSUPPORTED",
  );
  const mpd = asObject(
    new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      processEntities: false,
    }).parse(text).MPD,
  );
  assert(mpd["@_type"] === "static", "SOURCE_UNSUPPORTED");
  const origins = new Set([url.origin]);
  let refs = 0;
  const walk = (obj: unknown) => {
    if (++refs > 10000) throw new AppError("SOURCE_UNSUPPORTED");
    if (!obj || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj)) {
      if (
        ["BaseURL", "@_media", "@_initialization", "@_sourceURL"].includes(k) &&
        typeof v === "string"
      ) {
        const u = remoteUrl(new URL(v, url).href);
        origins.add(u.origin);
      } else if (typeof v === "object") walk(v);
    }
  };
  walk(mpd);
  const match =
    /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(
      String(mpd["@_mediaPresentationDuration"] ?? ""),
    );
  assert(match, "SOURCE_UNSUPPORTED");
  return {
    origins: [...origins],
    duration:
      Number(match[1] ?? 0) * 3600 +
      Number(match[2] ?? 0) * 60 +
      Number(match[3] ?? 0),
  };
}
export class UrlAdapter implements SourceAdapter<string> {
  constructor(
    public safe = new SafeFetch(),
    public library?: LibraryService,
  ) {}
  async inspect(raw: string, signal?: AbortSignal): Promise<Inspection> {
    const u = remoteUrl(raw);
    const { response: r, bytes } = await this.safe.limited(
      u.href,
      2097152,
      signal,
    );
    if (r.status === 401 || r.status === 403)
      throw new AppError("SOURCE_AUTH_REQUIRED", 409);
    if (r.status === 404) throw new AppError("SOURCE_UNAVAILABLE", 409);
    if (![200, 206].includes(r.status))
      throw new AppError("SOURCE_UNAVAILABLE", 409);
    const mime = r.headers["content-type"]?.split(";")[0].toLowerCase() ?? "";
    const text = bytes.toString("utf8");
    assert(
      !mime.includes("html") && !/^\s*<!doctype html|^\s*<html/i.test(text),
      "SOURCE_UNSUPPORTED",
    );
    const origins = new Set([u.origin, r.origin]);
    const fingerprint = r.headers.etag ?? null;
    if (text.startsWith("#EXTM3U")) {
      assert(!/#EXT-X-KEY|#EXT-X-SESSION-KEY/.test(text), "SOURCE_UNSUPPORTED");
      const p = parseHls(text);
      let duration = 0;
      if (p.isMasterPlaylist) {
        assert(
          "variants" in p && p.variants.length <= 30,
          "SOURCE_UNSUPPORTED",
        );
        for (const variant of p.variants) {
          const vurl = remoteUrl(new URL(variant.uri, r.url).href);
          origins.add(vurl.origin);
          const nested = await this.safe.limited(vurl.href, 2097152, signal);
          const nt = nested.bytes.toString("utf8");
          assert(!/#EXT-X-KEY/.test(nt), "SOURCE_UNSUPPORTED");
          const np = parseHls(nt);
          assert(
            !np.isMasterPlaylist &&
              "endlist" in np &&
              np.endlist &&
              "segments" in np,
            "SOURCE_UNSUPPORTED",
          );
          duration = np.segments.reduce((n, s) => n + s.duration, 0);
          for (const segment of np.segments) {
            origins.add(remoteUrl(new URL(segment.uri, vurl).href).origin);
            if (segment.map)
              origins.add(
                remoteUrl(new URL(segment.map.uri, vurl).href).origin,
              );
          }
          assert(
            allowsCors(
              nested.response.headers["access-control-allow-origin"],
              this.library?.config.origin,
            ),
            "SOURCE_CORS_REQUIRED",
          );
        }
      } else {
        assert(
          "endlist" in p && p.endlist && "segments" in p,
          "SOURCE_UNSUPPORTED",
        );
        duration = p.segments.reduce((n, s) => n + s.duration, 0);
        for (const segment of p.segments) {
          origins.add(remoteUrl(new URL(segment.uri, r.url).href).origin);
          if (segment.map)
            origins.add(remoteUrl(new URL(segment.map.uri, r.url).href).origin);
        }
      }
      assert(duration > 0, "SOURCE_UNSUPPORTED");
      assert(
        allowsCors(
          r.headers["access-control-allow-origin"],
          this.library?.config.origin,
        ),
        "SOURCE_CORS_REQUIRED",
      );
      return {
        kind: "hls",
        health: "READY",
        durationSeconds: duration,
        bytes: bytes.length,
        mimeType: "application/vnd.apple.mpegurl",
        seekable: true,
        delivery: "direct",
        approvedOrigins: [...origins],
        fingerprint,
      };
    }
    if (mime.includes("dash") || text.includes("<MPD")) {
      const p = validateDash(text, new URL(r.url));
      assert(
        allowsCors(
          r.headers["access-control-allow-origin"],
          this.library?.config.origin,
        ),
        "SOURCE_CORS_REQUIRED",
      );
      return {
        kind: "dash",
        health: "READY",
        durationSeconds: p.duration,
        bytes: bytes.length,
        mimeType: "application/dash+xml",
        seekable: true,
        delivery: "direct",
        approvedOrigins: p.origins,
        fingerprint,
      };
    }
    const mp4 = bytes.length > 12 && bytes.toString("ascii", 4, 8) === "ftyp";
    const webm = bytes.length > 4 && bytes.readUInt32BE(0) === 0x1a45dfa3;
    assert(mp4 || webm, "SOURCE_UNSUPPORTED");
    const m = /^bytes 0-(\d+)\/(\d+)$/.exec(r.headers["content-range"] ?? "");
    const seekable = r.status === 206 && !!m;
    assert(seekable, "SOURCE_NOT_SEEKABLE");
    const total = Number(m![2]);
    assert(
      Number(m![1]) + 1 === bytes.length && total >= bytes.length,
      "SOURCE_NOT_SEEKABLE",
    );
    const delivery = allowsCors(
      r.headers["access-control-allow-origin"],
      this.library?.config.origin,
    )
      ? "direct"
      : "relay";
    return {
      kind: "http_file",
      health: "READY",
      durationSeconds: mp4
        ? await mp4Duration(bytes, total, r.url, this.safe, signal)
        : webmDuration(bytes),
      bytes: total,
      mimeType: mp4 ? "video/mp4" : "video/webm",
      seekable: true,
      delivery,
      approvedOrigins: [...origins],
      fingerprint,
    };
  }
  checkHealth(raw: string, signal?: AbortSignal) {
    return this.inspect(raw, signal);
  }
  async resolvePlayback(
    m: MediaRow,
    s: SourceRow,
  ): Promise<PlaybackDescriptor> {
    assert(this.library, "INTERNAL_ERROR", 500);
    const ref = this.library.reference<UrlReference>(s);
    if (ref.expiresAt && new Date(ref.expiresAt).getTime() <= Date.now()) {
      await this.library.db.query(
        "UPDATE sources SET health='EXPIRED',safe_error_code='SOURCE_EXPIRED' WHERE id=$1",
        [s.id],
      );
      await this.library.onUnavailable(m.id);
      throw new AppError("SOURCE_EXPIRED", 409);
    }
    return {
      protocolVersion: 1,
      mediaId: m.id,
      sourceId: s.id,
      contentGeneration: m.content_generation,
      kind: s.kind === "hls" ? "hls" : s.kind === "dash" ? "dash" : "file",
      delivery: s.delivery_strategy,
      url: s.delivery_strategy === "relay" ? `/media/${s.id}/file` : ref.url,
      expiresAt: ref.expiresAt ?? null,
      durationSeconds: m.duration_seconds,
      mimeType: ref.mimeType,
      capabilities: { ...baseCapabilities, ...s.capabilities_json },
      tracks: [],
      approvedOrigins:
        s.delivery_strategy === "relay"
          ? [this.library.config.origin]
          : s.approved_origins_json,
    };
  }
  async openByteRange(
    reference: string,
    range: string | undefined,
    signal?: AbortSignal,
  ) {
    if (range) assert(/^bytes=(\d*)-(\d*)$/.test(range), "INVALID_RANGE", 416);
    const r = await this.safe.request(reference, {
      headers: range ? { range } : {},
      signal,
    });
    assert([200, 206, 416].includes(r.status), "SOURCE_UNAVAILABLE", 502);
    if (range && r.status !== 416)
      assert(
        r.status === 206 && !!r.headers["content-range"],
        "SOURCE_NOT_SEEKABLE",
        502,
      );
    return r;
  }
}

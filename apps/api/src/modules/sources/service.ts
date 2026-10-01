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
import { parseRange } from "../media/storage.js";
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
class InspectionFetch extends SafeFetch {
  private remaining = 2097152;
  constructor(private source: SafeFetch) {
    super();
  }
  override request(...args: Parameters<SafeFetch["request"]>) {
    return this.source.request(...args);
  }
  override async limited(
    raw: string,
    bytes = 2097152,
    signal?: AbortSignal,
    range?: string,
  ) {
    assert(this.remaining > 0, "INSPECTION_LIMIT");
    const result = await super.limited(
      raw,
      Math.min(bytes, this.remaining),
      signal,
      range,
    );
    this.remaining -= result.bytes.length;
    return result;
  }
}
export function validateDash(
  text: string,
  url: URL,
): { origins: string[]; duration: number; probes: string[] } {
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
  const probes = new Set<string>();
  let refs = 0;
  const walk = (
    obj: unknown,
    base = url,
    template?: Record<string, unknown>,
    representation?: Record<string, unknown>,
  ) => {
    if (++refs > 10000) throw new AppError("SOURCE_UNSUPPORTED");
    if (!obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      for (const item of obj) walk(item, base, template, representation);
      return;
    }
    const node = obj as Record<string, unknown>;
    if (node.BaseURL !== undefined) {
      const choices = Array.isArray(node.BaseURL)
        ? node.BaseURL
        : [node.BaseURL];
      assert(choices.length <= 8, "SOURCE_UNSUPPORTED");
      const value = choices[0];
      const text =
        typeof value === "string"
          ? value
          : typeof value === "object" && value !== null
            ? String((value as Record<string, unknown>)["#text"] ?? "")
            : "";
      assert(text, "SOURCE_UNSUPPORTED");
      const parentBase = base;
      base = remoteUrl(new URL(text, parentBase).href);
      for (const choice of choices) {
        const text =
          typeof choice === "string"
            ? choice
            : String((choice as Record<string, unknown>)["#text"] ?? "");
        origins.add(remoteUrl(new URL(text, parentBase).href).origin);
      }
      if (/\.(mp4|webm)(?:\?|$)/i.test(base.href)) probes.add(base.href);
    }
    if (node.SegmentTemplate)
      template = { ...template, ...asObject(node.SegmentTemplate) };
    const materialize = (raw: string, probe = false) => {
      const number = Number(template?.["@_startNumber"] ?? 1);
      const timeline = template?.SegmentTimeline as
        Record<string, unknown> | undefined;
      const entry = timeline?.S;
      const first = Array.isArray(entry) ? entry[0] : entry;
      const time = Number(
        (first as Record<string, unknown> | undefined)?.["@_t"] ?? 0,
      );
      const expanded = raw
        .replace(/\$\$/g, "__DOLLAR__")
        .replace(
          /\$(RepresentationID|Bandwidth|Number|Time)(?:%0(\d+)d)?\$/g,
          (token, kind: string, width: string | undefined) => {
            const value =
              kind === "RepresentationID"
                ? representation?.["@_id"]
                : kind === "Bandwidth"
                  ? representation?.["@_bandwidth"]
                  : kind === "Number"
                    ? number
                    : time;
            return value === undefined
              ? token
              : String(value).padStart(Number(width ?? 0), "0");
          },
        )
        .replaceAll("__DOLLAR__", "$");
      const target = remoteUrl(new URL(expanded, base).href);
      origins.add(target.origin);
      if (probe && !/\$[A-Za-z]/.test(expanded)) probes.add(target.href);
    };
    if (representation && template) {
      for (const key of ["@_initialization", "@_media"])
        if (typeof template[key] === "string")
          materialize(template[key] as string, true);
    }
    for (const [k, v] of Object.entries(obj)) {
      if (
        ["@_media", "@_initialization", "@_sourceURL"].includes(k) &&
        typeof v === "string"
      ) {
        materialize(v, k !== "@_media" || !v.includes("$"));
      } else if (k !== "BaseURL" && typeof v === "object") {
        if (k === "Representation")
          for (const rep of Array.isArray(v) ? v : [v])
            walk(rep, base, template, asObject(rep));
        else walk(v, base, template, representation);
      }
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
    probes: [...probes].slice(0, 60),
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
    const deadline = AbortSignal.timeout(20000);
    return this.inspectBounded(
      raw,
      signal ? AbortSignal.any([signal, deadline]) : deadline,
    );
  }
  private async inspectBounded(
    raw: string,
    signal: AbortSignal,
  ): Promise<Inspection> {
    const safe = new InspectionFetch(this.safe);
    const u = remoteUrl(raw);
    const { response: r, bytes: first } = await safe.limited(
      u.href,
      2097152,
      signal,
      "bytes=0-65535",
    );
    let bytes = first;
    if (r.status === 401 || r.status === 403)
      throw new AppError("SOURCE_AUTH_REQUIRED", 409);
    if (r.status === 404) throw new AppError("SOURCE_UNAVAILABLE", 409);
    if (![200, 206].includes(r.status))
      throw new AppError("SOURCE_UNAVAILABLE", 409);
    const mime = r.headers["content-type"]?.split(";")[0].toLowerCase() ?? "";
    // Probe file headers cheaply, preserving the global budget for a moov at
    // the end. A ranged manifest is completed within that same 2 MiB budget.
    const manifest =
      mime.includes("mpegurl") ||
      mime.includes("dash") ||
      bytes.toString("utf8", 0, 128).includes("#EXTM3U") ||
      bytes.toString("utf8", 0, 128).includes("<MPD");
    const contentRange = /^bytes 0-(\d+)\/(\d+)$/.exec(
      r.headers["content-range"] ?? "",
    );
    if (
      manifest &&
      contentRange &&
      Number(contentRange[1]) + 1 < Number(contentRange[2])
    ) {
      const start = Number(contentRange[1]) + 1,
        total = Number(contentRange[2]);
      assert(total <= 2097152, "INSPECTION_LIMIT");
      const tail = await safe.limited(
        r.url,
        total - start,
        signal,
        `bytes=${start}-${total - 1}`,
      );
      assert(
        tail.response.status === 206 && tail.bytes.length === total - start,
        "SOURCE_UNAVAILABLE",
      );
      bytes = Buffer.concat([bytes, tail.bytes]);
    }
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
          const nested = await safe.limited(vurl.href, 2097152, signal);
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
          const variantDuration = np.segments.reduce(
            (n, s) => n + s.duration,
            0,
          );
          assert(
            !duration || Math.abs(variantDuration - duration) <= 1,
            "CONTENT_IDENTITY_MISMATCH",
          );
          duration = variantDuration;
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
          await this.probeSegment(
            safe,
            new URL(
              np.segments[0]?.map?.uri ?? np.segments[0]?.uri ?? "",
              nested.response.url,
            ).href,
            signal,
            origins,
          );
          if (np.segments[0]?.map)
            await this.probeSegment(
              safe,
              new URL(np.segments[0].uri, nested.response.url).href,
              signal,
              origins,
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
        await this.probeSegment(
          safe,
          new URL(p.segments[0]?.map?.uri ?? p.segments[0]?.uri ?? "", r.url)
            .href,
          signal,
          origins,
        );
        if (p.segments[0]?.map)
          await this.probeSegment(
            safe,
            new URL(p.segments[0].uri, r.url).href,
            signal,
            origins,
          );
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
      const dashOrigins = new Set(p.origins);
      assert(p.probes.length > 0, "SOURCE_UNSUPPORTED");
      for (const probe of p.probes)
        await this.probeSegment(safe, probe, signal, dashOrigins);
      return {
        kind: "dash",
        health: "READY",
        durationSeconds: p.duration,
        bytes: bytes.length,
        mimeType: "application/dash+xml",
        seekable: true,
        delivery: "direct",
        approvedOrigins: [...dashOrigins],
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
        ? await mp4Duration(bytes, total, r.url, safe, signal)
        : webmDuration(bytes),
      bytes: total,
      mimeType: mp4 ? "video/mp4" : "video/webm",
      seekable: true,
      delivery,
      approvedOrigins: [...origins],
      fingerprint,
    };
  }
  private async probeSegment(
    safe: SafeFetch,
    raw: string,
    signal: AbortSignal,
    origins: Set<string>,
  ) {
    const response = await safe.request(raw, { method: "HEAD", signal });
    try {
      assert(
        response.status === 200 || response.status === 206,
        "SOURCE_SEGMENT_UNAVAILABLE",
        409,
      );
      assert(
        allowsCors(
          response.headers["access-control-allow-origin"],
          this.library?.config.origin,
        ),
        "SOURCE_CORS_REQUIRED",
      );
      assert(
        !response.headers["content-type"]?.includes("html"),
        "SOURCE_SEGMENT_UNAVAILABLE",
        409,
      );
      origins.add(response.origin);
    } finally {
      response.abort();
    }
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
    identity?: {
      bytes: number;
      fingerprint: string | null;
      method: "HEAD" | "GET";
    },
  ) {
    if (range) assert(/^bytes=(\d*)-(\d*)$/.test(range), "INVALID_RANGE", 416);
    const requested = identity ? parseRange(range, identity.bytes) : null;
    const r = await this.safe.request(reference, {
      method: identity?.method ?? "GET",
      headers: range
        ? {
            range: requested
              ? `bytes=${requested.start}-${requested.end}`
              : range,
          }
        : {},
      signal,
    });
    try {
      assert([200, 206, 416].includes(r.status), "SOURCE_UNAVAILABLE", 502);
      if (range && r.status !== 416)
        assert(
          r.status === 206 && !!r.headers["content-range"],
          "SOURCE_NOT_SEEKABLE",
          502,
        );
      if (identity && requested && r.status !== 416) {
        assert(
          !identity.fingerprint || identity.fingerprint === r.headers.etag,
          "CONTENT_IDENTITY_MISMATCH",
          409,
        );
        assert(
          Number(r.headers["content-length"]) ===
            requested.end - requested.start + 1,
          "CONTENT_IDENTITY_MISMATCH",
          409,
        );
        if (range)
          assert(
            r.headers["content-range"] ===
              `bytes ${requested.start}-${requested.end}/${identity.bytes}`,
            "CONTENT_IDENTITY_MISMATCH",
            409,
          );
      }
      return r;
    } catch (error) {
      r.abort();
      throw error;
    }
  }
}

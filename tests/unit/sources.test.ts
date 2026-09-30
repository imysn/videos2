import { it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import {
  SafeFetch,
  type SafeResponse,
} from "../../apps/api/src/infrastructure/safe-fetch/index.js";
import {
  mp4Duration,
  signedExpiry,
  webmDuration,
} from "../../apps/api/src/modules/sources/duration.js";
import {
  UrlAdapter,
  validateDash,
} from "../../apps/api/src/modules/sources/service.js";
it("SRC-01 MP4 real: duración obtenida por lectura acotada y Range", async () => {
  const data = await readFile(".local/fixtures/short.mp4");
  let requests = 0;
  const safe = new SafeFetch(
    async () => [{ address: "93.184.216.34", family: 4 }],
    async (r) => {
      requests++;
      const match = /bytes=(\d+)-(\d+)/.exec(r.headers.range),
        start = Number(match?.[1] ?? 0),
        end = Math.min(data.length - 1, Number(match?.[2] ?? data.length - 1));
      return {
        status: 206,
        headers: {
          "content-type": "video/mp4",
          "content-range": `bytes ${start}-${end}/${data.length}`,
        },
        body: Readable.from([data.subarray(start, end + 1)]),
        url: r.url.href,
        origin: r.url.origin,
        abort() {},
      } satisfies SafeResponse;
    },
  );
  expect(
    await mp4Duration(
      data.subarray(0, 65536),
      data.length,
      "https://example.com/movie.mp4",
      safe,
    ),
  ).toBeCloseTo(120, 0);
  expect(requests).toBeLessThanOrEqual(2);
  const inspected = await new UrlAdapter(safe).inspect(
    "https://example.com/movie.mp4",
  );
  expect(inspected.durationSeconds).toBeCloseTo(120, 0);
  expect(inspected.seekable).toBe(true);
  expect(inspected.delivery).toBe("relay");
});
it.each(["https://example.com/movie.mp4", "https://example.com/page"])(
  "SRC-01 HTML nunca es vídeo aunque el nombre diga MP4: %s",
  async (url) => {
    const safe = new SafeFetch(
      async () => [{ address: "93.184.216.34", family: 4 }],
      async (r) => ({
        status: 200,
        headers: { "content-type": "text/html" },
        body: Readable.from(["<!DOCTYPE html><h1>Download</h1>"]),
        url: r.url.href,
        origin: r.url.origin,
        abort() {},
      }),
    );
    await expect(new UrlAdapter(safe).inspect(url)).rejects.toMatchObject({
      code: "SOURCE_UNSUPPORTED",
    });
  },
);
it("SRC-03 HLS sin ENDLIST/CORS o con DRM no se acepta", async () => {
  for (const text of [
    "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\na.ts\n",
    '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST\n',
    "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST\n",
  ]) {
    const safe = new SafeFetch(
      async () => [{ address: "93.184.216.34", family: 4 }],
      async (r) => ({
        status: 200,
        headers: { "content-type": "application/vnd.apple.mpegurl" },
        body: Readable.from([text]),
        url: r.url.href,
        origin: r.url.origin,
        abort() {},
      }),
    );
    await expect(
      new UrlAdapter(safe).inspect("https://example.com/movie.m3u8"),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/SOURCE_(UNSUPPORTED|CORS_REQUIRED)/),
    });
  }
});
it("SRC-03 DASH: solo VOD sin DRM y con referencias públicas", () => {
  const valid =
    '<MPD type="static" mediaPresentationDuration="PT2M"><Period><AdaptationSet><Representation><SegmentTemplate initialization="init.mp4" media="chunk-$Number$.m4s" /></Representation></AdaptationSet></Period></MPD>';
  expect(
    validateDash(valid, new URL("https://example.com/movie.mpd")).duration,
  ).toBe(120);
  expect(() =>
    validateDash(
      valid.replace("static", "dynamic"),
      new URL("https://example.com/movie.mpd"),
    ),
  ).toThrow();
  expect(() =>
    validateDash(
      valid.replace("<Period>", "<Period><ContentProtection/>"),
      new URL("https://example.com/movie.mpd"),
    ),
  ).toThrow();
  expect(() =>
    validateDash(
      valid.replace("init.mp4", "https://127.0.0.1/init.mp4"),
      new URL("https://example.com/movie.mpd"),
    ),
  ).toThrow();
});
it("SRC-04 expiración de URLs firmadas estándar y ausencia explícita", () => {
  expect(signedExpiry("https://example.com/file?Expires=1893456000")).toBe(
    "2030-01-01T00:00:00.000Z",
  );
  expect(
    signedExpiry(
      "https://example.com/file?X-Amz-Date=20260930T120000Z&X-Amz-Expires=60",
    ),
  ).toBe("2026-09-30T12:01:00.000Z");
  expect(signedExpiry("https://example.com/file")).toBeUndefined();
});
it("SRC-01 WebM truncado o sin duración no inventa metadata", () => {
  expect(() => webmDuration(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))).toThrow();
  expect(() => webmDuration(Buffer.alloc(0))).toThrow();
});

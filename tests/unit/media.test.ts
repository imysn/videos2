import { it, expect } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import {
  parseRange,
  storagePath,
} from "../../apps/api/src/modules/media/storage.js";
import {
  parseSubtitles,
  toVtt,
} from "../../apps/api/src/modules/media/subtitles.js";
import { seal, open } from "../../apps/api/src/infrastructure/secrets.js";
it.each([
  ["bytes=3-8", 3, 8],
  ["bytes=3-", 3, 99],
  ["bytes=-10", 90, 99],
  ["bytes=0-200", 0, 99],
] as const)("Range %s tiene bytes exactos", (value, start, end) =>
  expect(parseRange(value, 100)).toEqual({ start, end, partial: true }),
);
it.each([
  "bytes=",
  "bytes=-0",
  "bytes=100-",
  "bytes=4-2",
  "bytes=0-1,4-5",
  "units=0-5",
  "bytes=Infinity-",
])("Range inválido %s", (value) =>
  expect(() => parseRange(value, 100)).toThrow(
    expect.objectContaining({ code: "INVALID_RANGE" }),
  ),
);
it.each([
  "../etc/passwd",
  "/etc/passwd",
  "foo/../../secret",
  "a//b",
  "a/./b",
  "a\\b",
])("confinamiento %s", (key) =>
  expect(() => storagePath("/data", key)).toThrow(),
);
it("cifrado GCM detecta corrupción, AAD y clave distinta", () => {
  const key = randomBytes(32),
    id = randomUUID(),
    c = seal({ url: "sensitive" }, key, "source", id);
  expect(open(c, key, "source", id)).toEqual({ url: "sensitive" });
  expect(() => open(c, key, "source", randomUUID())).toThrow();
  expect(() => open(c, randomBytes(32), "source", id)).toThrow();
  expect(() =>
    open({ ...c, tag: randomBytes(16).toString("base64") }, key, "source", id),
  ).toThrow();
  expect(seal({}, key, "source", id).nonce).not.toBe(c.nonce);
});
it("subtítulos normalizados y sin HTML ejecutable", () => {
  const c = parseSubtitles(
    "1\n00:00:01,000 --> 00:00:03,000\n<b>Hola</b> <script>mal</script>\n",
  );
  expect(c.length).toBe(1);
  const v = toVtt(c);
  expect(v).toContain("WEBVTT");
  expect(v).not.toContain("<script>");
});

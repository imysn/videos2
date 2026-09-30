import { it, expect } from "vitest";
import { Readable } from "node:stream";
import {
  SafeFetch,
  publicAddress,
  remoteUrl,
  type SafeResponse,
  type TransportRequest,
} from "../../apps/api/src/infrastructure/safe-fetch/index.js";
const response = (
  url: URL,
  status = 200,
  headers: Record<string, string> = {},
): SafeResponse => ({
  status,
  headers,
  body: Readable.from(["safe"]),
  url: url.href,
  origin: url.origin,
  abort: () => {},
});
it.each([
  "127.0.0.1",
  "10.0.0.1",
  "172.16.0.1",
  "192.168.1.1",
  "169.254.169.254",
  "100.64.0.1",
  "0.0.0.0",
  "224.0.0.1",
  "::1",
  "fc00::1",
  "fe80::1",
  "::ffff:127.0.0.1",
])("SEC-01 dirección interna rechazada %s", (ip) =>
  expect(publicAddress(ip)).toBe(false),
);
it.each([
  "http://example.com/a",
  "file:///etc/passwd",
  "blob:https://example.com/id",
  "data:text/plain,x",
  "javascript:alert(1)",
  "https://user:password@example.com/a",
  "https://example.com:444/a",
  "https://2130706433/a",
  "https://0x7f000001/a",
  "https://[::ffff:127.0.0.1]/a",
])("SEC-01 URL prohibida %s", (u) => expect(() => remoteUrl(u)).toThrow());
it("SEC-01 nunca conecta si DNS devuelve una IP privada entre públicas", async () => {
  let connections = 0;
  const safe = new SafeFetch(
    async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ],
    async (r) => {
      connections++;
      return response(r.url);
    },
  );
  await expect(
    safe.request("https://public.example/file"),
  ).rejects.toMatchObject({ code: "SSRF_REJECTED" });
  expect(connections).toBe(0);
});
it("SEC-02 valida redirección y corta antes de IP privada", async () => {
  let connections = 0;
  const safe = new SafeFetch(
    async (name) => [
      {
        address: name === "public.example" ? "93.184.216.34" : "10.0.0.1",
        family: 4,
      },
    ],
    async (r) => {
      connections++;
      return response(r.url, 302, {
        location: "https://internal.example/file",
      });
    },
  );
  await expect(
    safe.request("https://public.example/file"),
  ).rejects.toMatchObject({ code: "SSRF_REJECTED" });
  expect(connections).toBe(1);
});
it("SEC-02 transporte recibe exactamente la resolución validada (binding)", async () => {
  let supplied: TransportRequest | undefined;
  let resolutions = 0;
  const safe = new SafeFetch(
    async () => {
      resolutions++;
      return [
        {
          address: resolutions === 1 ? "93.184.216.34" : "127.0.0.1",
          family: 4,
        },
      ];
    },
    async (r) => {
      supplied = r;
      return response(r.url);
    },
  );
  await safe.request("https://public.example/file");
  expect(resolutions).toBe(1);
  expect(supplied?.address).toBe("93.184.216.34");
  expect(supplied?.url.hostname).toBe("public.example");
});
it("SEC-02 máximo tres redirecciones y headers no arbitrarios", async () => {
  let n = 0;
  const safe = new SafeFetch(
    async () => [{ address: "93.184.216.34", family: 4 }],
    async (r) => {
      n++;
      return response(r.url, 302, { location: "/again" });
    },
  );
  await expect(safe.request("https://public.example/a")).rejects.toThrow();
  expect(n).toBe(4);
  await expect(
    safe.request("https://public.example/a", {
      headers: { cookie: "rave=secret" },
    }),
  ).rejects.toMatchObject({ code: "UNSAFE_HEADERS" });
});
it("SEC-01 inspección acotada aborta upstream al superar presupuesto", async () => {
  let aborted = false;
  const safe = new SafeFetch(
    async () => [{ address: "93.184.216.34", family: 4 }],
    async (r) => ({
      ...response(r.url),
      body: Readable.from([Buffer.alloc(200)]),
      abort: () => {
        aborted = true;
      },
    }),
  );
  await expect(
    safe.limited("https://public.example/a", 100),
  ).rejects.toMatchObject({ code: "INSPECTION_LIMIT" });
  expect(aborted).toBe(true);
});

import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { Readable } from "node:stream";
import { AppError, assert } from "../errors.js";
export interface SafeResponse {
  status: number;
  headers: Record<string, string>;
  body: Readable;
  url: string;
  origin: string;
  abort: () => void;
}
export interface TransportRequest {
  url: URL;
  address: string;
  family: 4 | 6;
  headers: Record<string, string>;
  method: "GET" | "HEAD";
  signal?: AbortSignal;
}
export type Resolve = (
  name: string,
) => Promise<{ address: string; family: number }[]>;
export type Transport = (request: TransportRequest) => Promise<SafeResponse>;
export function publicAddress(raw: string): boolean {
  try {
    let ip = ipaddr.parse(raw);
    if (ip.kind() === "ipv6" && (ip as ipaddr.IPv6).isIPv4MappedAddress())
      ip = (ip as ipaddr.IPv6).toIPv4Address();
    return ip.range() === "unicast";
  } catch {
    return false;
  }
}
export function remoteUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AppError("SOURCE_UNSUPPORTED");
  }
  assert(
    u.protocol === "https:" &&
      (!u.port || u.port === "443") &&
      !u.username &&
      !u.password &&
      !u.hash,
    "SOURCE_UNSUPPORTED",
  );
  if (isIP(u.hostname.replace(/^\[|\]$/g, "")))
    assert(publicAddress(u.hostname.replace(/^\[|\]$/g, "")), "SSRF_REJECTED");
  return u;
}
const realTransport: Transport = async ({
  url,
  address,
  family,
  headers,
  method,
  signal,
}) =>
  new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method,
        headers,
        signal,
        servername: url.hostname,
        lookup: (_host, _opts, cb) => cb(null, address, family),
        rejectUnauthorized: true,
      },
      (res) => {
        const h: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers))
          if (v !== undefined)
            h[k] = Array.isArray(v) ? v.join(",") : String(v);
        res.setTimeout(30000, () => {
          res.destroy(new Error("Upstream inactivity timeout"));
        });
        resolve({
          status: res.statusCode ?? 502,
          headers: h,
          body: res,
          url: url.href,
          origin: url.origin,
          abort: () => {
            res.destroy();
            req.destroy();
          },
        });
      },
    );
    req.setTimeout(10000, () =>
      req.destroy(new Error("Upstream header timeout")),
    );
    const timer = setTimeout(
      () => req.destroy(new Error("Upstream connection timeout")),
      5000,
    );
    req.once("socket", (socket) =>
      socket.once("secureConnect", () => clearTimeout(timer)),
    );
    req.once("response", () => clearTimeout(timer));
    req.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.end();
  });
export class SafeFetch {
  constructor(
    private resolver: Resolve = async (host) => lookup(host, { all: true }),
    private transport: Transport = realTransport,
  ) {}
  async request(
    raw: string,
    options: {
      method?: "GET" | "HEAD";
      headers?: Record<string, string>;
      signal?: AbortSignal;
    } = {},
  ): Promise<SafeResponse> {
    let u = remoteUrl(raw);
    const headers = { ...options.headers };
    assert(
      Object.keys(headers).every((k) =>
        ["range", "accept"].includes(k.toLowerCase()),
      ),
      "UNSAFE_HEADERS",
    );
    for (let hop = 0; hop <= 3; hop++) {
      const ips = await this.resolver(u.hostname.replace(/^\[|\]$/g, ""));
      assert(
        ips.length && ips.every((ip) => publicAddress(ip.address)),
        "SSRF_REJECTED",
      );
      const result = await this.transport({
        url: u,
        address: ips[0].address,
        family: ips[0].family as 4 | 6,
        headers,
        method: options.method ?? "GET",
        signal: options.signal,
      });
      if ([301, 302, 303, 307, 308].includes(result.status)) {
        result.abort();
        assert(hop < 3 && result.headers.location, "SOURCE_UNSUPPORTED");
        u = remoteUrl(new URL(result.headers.location, u).href);
        continue;
      }
      return result;
    }
    throw new AppError("SOURCE_UNAVAILABLE", 502);
  }
  async limited(
    raw: string,
    bytes = 2097152,
    signal?: AbortSignal,
    range?: string,
  ) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    let r: SafeResponse | undefined;
    try {
      r = await this.request(raw, {
        headers: { range: range ?? `bytes=0-${bytes - 1}` },
        signal: controller.signal,
      });
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const part of r.body) {
        const chunk = Buffer.from(part);
        size += chunk.length;
        assert(size <= bytes, "INSPECTION_LIMIT");
        chunks.push(chunk);
      }
      return { response: r, bytes: Buffer.concat(chunks) };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      r?.abort();
    }
  }
}

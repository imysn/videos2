import { afterEach, expect, it, vi } from "vitest";
import { loadConfig } from "../../apps/api/src/infrastructure/config.js";

afterEach(() => vi.unstubAllEnvs());
it.each(["development", "test"])("%s rejects a LAN origin", (mode) => {
  vi.stubEnv("APP_ENV", mode);
  vi.stubEnv("PUBLIC_ORIGIN", "http://192.168.1.135:3000");
  expect(loadConfig).toThrow("Development/test must use loopback");
});
it.each([
  ["http://deployment.invalid", "true"],
  ["https://deployment.invalid", "false"],
])("production rejects insecure origin/cookies: %s %s", (origin, secure) => {
  vi.stubEnv("APP_ENV", "production");
  vi.stubEnv("PUBLIC_ORIGIN", origin);
  vi.stubEnv("COOKIE_SECURE", secure);
  expect(loadConfig).toThrow("Production requires HTTPS and secure cookies");
});
it("accepts an external Tailscale HTTPS origin and retains upload defaults", () => {
  vi.stubEnv("APP_ENV", "production");
  vi.stubEnv("PUBLIC_ORIGIN", "https://example.example-tailnet.ts.net");
  vi.stubEnv("COOKIE_SECURE", "true");
  const config = loadConfig();
  expect(config.origin).toBe("https://example.example-tailnet.ts.net");
  expect(config.cookieName).toBe("__Host-rave");
  expect(config.MAX_UPLOAD_BYTES).toBe(21474836480);
  expect(config.UPLOAD_CHUNK_MAX_BYTES).toBe(8388608);
});

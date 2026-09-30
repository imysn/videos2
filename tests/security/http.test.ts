import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { testApp, actor } from "../helpers/context.js";
let a: Awaited<ReturnType<typeof testApp>>,
  owner: Awaited<ReturnType<typeof actor>>;
beforeAll(async () => {
  a = await testApp();
  owner = await actor(a);
});
afterAll(async () => {
  await a.app.close();
});
it("SEC-03 login Origin y media sin sesión", async () => {
  const r = await a.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { origin: "https://evil.example" },
    payload: { username: "jason", password: a.passwords.jason },
  });
  expect(r.statusCode).toBe(403);
  expect(
    (await a.app.inject({ url: `/media/assets/${randomUUID()}` })).statusCode,
  ).toBe(401);
});
it("SEC-05 campos extra no cambian rol ni permisos", async () => {
  const r = await a.app.inject({
    method: "PATCH",
    url: "/api/v1/account",
    headers: owner.headers,
    payload: { displayName: "Jason", role: "PARTNER" },
  });
  expect(r.statusCode).toBe(400);
  expect(r.json().code).toBe("INVALID_PAYLOAD");
});
it("SEC-08 login por IP/cuenta realmente limitado", async () => {
  let status = 0;
  for (let n = 0; n < 6; n++) {
    const r = await a.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: a.config.origin },
      payload: { username: "nonexistent-limit-test", password: "wrong" },
    });
    status = r.statusCode;
  }
  expect(status).toBe(429);
});
it("SEC-06 errores no contienen contraseña, SQL ni stack", async () => {
  const r = await a.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { origin: a.config.origin },
    payload: { username: "missing", password: "private-value-not-to-expose" },
  });
  expect(r.body).not.toContain("private-value-not-to-expose");
  expect(r.body).not.toContain("stack");
  expect(r.body).not.toContain("SELECT");
});

import { expect, type Browser, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
export const origin = "http://127.0.0.1:3001";
export async function credentials() {
  return JSON.parse(
    await readFile(".local/test/credentials.json", "utf8"),
  ) as Record<string, string>;
}
export async function fixtureIds() {
  return JSON.parse(await readFile(".local/test/media.json", "utf8")) as {
    short: string;
    long: string;
    adaptive: string;
  };
}
export async function login(page: Page, name = "jason") {
  const p = await credentials();
  await page.goto("/login");
  await page.getByLabel("Usuario", { exact: true }).fill(name);
  await page.getByLabel("Contraseña", { exact: true }).fill(p[name]);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Biblioteca", exact: true }),
  ).toBeVisible();
}
export async function mutate(
  page: Page,
  path: string,
  body: unknown = {},
  method = "POST",
) {
  return page.evaluate(
    async ({ path, body, method, origin }) => {
      const me = await (await fetch("/api/v1/auth/me")).json();
      const r = await fetch("/api/v1" + path, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": me.csrf,
          "Idempotency-Key": crypto.randomUUID(),
          Origin: origin,
        },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.code);
      return data;
    },
    { path, body, method, origin },
  );
}
export async function videoState(page: Page) {
  return page.locator("video").evaluate((v: HTMLVideoElement) => ({
    time: v.currentTime,
    paused: v.paused,
    ready: v.readyState,
    rate: v.playbackRate,
    duration: v.duration,
    src: v.currentSrc,
  }));
}
export async function twoPlayers(
  browser: Browser,
  mediaId: string,
  initialPosition = 0,
) {
  const ca = await browser.newContext(),
    cb = await browser.newContext();
  const a = await ca.newPage(),
    b = await cb.newPage();
  await login(a);
  await login(b, "pareja");
  await mutate(a, "/account", { preferences: { muted: false } }, "PATCH");
  await mutate(b, "/account", { preferences: { muted: false } }, "PATCH");
  const s = await (await a.request.get(origin + "/api/v1/room")).json();
  if (s.sessionId) {
    const own = await (await a.request.get(origin + "/api/v1/auth/me")).json();
    const host = s.hostUserId === own.id ? a : b;
    await enterRoom(host);
    await host
      .getByRole("button", { name: "Cerrar sesión compartida" })
      .click();
    await host.getByRole("button", { name: "Confirmar", exact: true }).click();
  }
  await mutate(a, "/room/start", {
    mediaId,
    ...(initialPosition === undefined
      ? {}
      : { personalPositionSeconds: initialPosition }),
  });
  await enterRoom(a);
  await enterRoom(b);
  await expect(a.locator("video")).toHaveCount(1);
  await expect(b.locator("video")).toHaveCount(1);
  await expect
    .poll(async () => (await videoState(a)).ready)
    .toBeGreaterThanOrEqual(3);
  await expect
    .poll(async () => (await videoState(b)).ready)
    .toBeGreaterThanOrEqual(3);
  await a
    .getByRole("button", { name: "Pulsa para activar la reproducción" })
    .click();
  await b
    .getByRole("button", { name: "Pulsa para activar la reproducción" })
    .click();
  return { a, b, ca, cb };
}
export async function enterRoom(page: Page) {
  await page.goto("/room");
  const takeover = page.getByRole("button", {
    name: "Usar este dispositivo",
    exact: true,
  });
  await page.getByText("Conectado", { exact: true }).or(takeover).waitFor();
  if (await takeover.isVisible()) await takeover.click();
  await expect(page.getByText("Conectado", { exact: true })).toBeVisible();
}

export async function openSolo(page: Page, id: string) {
  await page.goto(`/watch/${id}`);
  await page
    .locator("video")
    .or(
      page.getByRole("button", { name: "Usar este dispositivo", exact: true }),
    )
    .waitFor();
  const takeover = page.getByRole("button", {
    name: "Usar este dispositivo",
    exact: true,
  });
  if (await takeover.isVisible()) await takeover.click();
  await page.locator("video").waitFor();
}

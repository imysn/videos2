import { expect, type Browser, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
export const origin = "http://127.0.0.1:3001";
const authenticated = new Set<string>();
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
  // These existing scenarios assert ES labels. Use an explicit account preference,
  // preserving the real PARTNER default (PL) tested by i18n.spec.ts.
  const { Database } = await import("../../packages/db/src/index.js");
  const { loadConfig } =
    await import("../../apps/api/src/infrastructure/config.js");
  const savedConfig = process.env.RAVE_CONFIG_FILE;
  process.env.RAVE_CONFIG_FILE = ".local/test/config.json";
  let fixtureConfig;
  try {
    fixtureConfig = loadConfig();
  } finally {
    if (savedConfig === undefined) delete process.env.RAVE_CONFIG_FILE;
    else process.env.RAVE_CONFIG_FILE = savedConfig;
  }
  expect(fixtureConfig.APP_ENV).toBe("test");
  const fixtureDb = new Database(fixtureConfig.databaseUrl);
  try {
    await fixtureDb.query(
      'UPDATE users SET preferences_json=preferences_json || \'{"locale":"es"}\'::jsonb WHERE username=$1',
      [name],
    );
  } finally {
    await fixtureDb.close();
  }
  if (authenticated.has(name)) {
    // Each independent device has its own real session. The HTTP login flow is
    // exercised once per user; further test fixtures preserve production limits.
    const { Database } = await import("../../packages/db/src/index.js");
    const { loadConfig } =
      await import("../../apps/api/src/infrastructure/config.js");
    const { AuthService } =
      await import("../../apps/api/src/modules/auth/service.js");
    const previous = process.env.RAVE_CONFIG_FILE;
    process.env.RAVE_CONFIG_FILE = ".local/test/config.json";
    let config;
    try {
      config = loadConfig();
    } finally {
      if (previous === undefined) delete process.env.RAVE_CONFIG_FILE;
      else process.env.RAVE_CONFIG_FILE = previous;
    }
    expect(config.APP_ENV).toBe("test");
    const db = new Database(config.databaseUrl);
    try {
      const session = await new AuthService(db, config).login(
        name,
        (await credentials())[name],
        "Independent browser test fixture",
      );
      await page.context().addCookies([
        {
          name: config.cookieName,
          value: session.raw,
          url: origin,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
    } finally {
      await db.close();
    }
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Biblioteca", exact: true }),
    ).toBeVisible();
    // Complete library bootstrap requests before starting a playback measurement.
    // Otherwise thumbnails still in flight can occupy the existing stream budget.
    await page.waitForLoadState("networkidle");
    return;
  }
  const p = await credentials();
  await page.goto("/login");
  await page.getByRole("combobox").selectOption("es");
  await page.getByLabel("Usuario", { exact: true }).fill(name);
  await page.getByLabel("Contraseña", { exact: true }).fill(p[name]);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Biblioteca", exact: true }),
  ).toBeVisible();
  await page.waitForLoadState("networkidle");
  authenticated.add(name);
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
    measuredAt: performance.timeOrigin + performance.now(),
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

import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { Database } from "../../packages/db/src/index.js";
import { loadConfig } from "../../apps/api/src/infrastructure/config.js";
import {
  AuthService,
  type User,
} from "../../apps/api/src/modules/auth/service.js";
import {
  createTranslator,
  SUPPORTED_LOCALES,
} from "../../apps/web/src/i18n/index";
import type { Locale } from "../../apps/web/src/i18n/types";
import { credentials, fixtureIds, mutate, origin, videoState } from "./helpers";

async function fixtureAccount(
  name: string,
  locale: Locale | null,
  page?: Page,
) {
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
    const [user] = await db.query<User>(
      "UPDATE users SET preferences_json=(preferences_json-'locale') || $2::jsonb WHERE username=$1 RETURNING *",
      [name, JSON.stringify(locale ? { locale } : {})],
    );
    if (page) {
      const session = await new AuthService(db, config).issue(
        user,
        "I18n browser fixture",
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
    }
  } finally {
    await db.close();
  }
}
async function choose(page: Page, from: Locale, to: Locale, account = false) {
  const select = (
    account ? page.locator("main") : page.locator("header")
  ).getByLabel(createTranslator(from)("locale.label"), { exact: true });
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/v1/account") && r.request().method() === "PATCH",
  );
  await select.selectOption(to);
  expect((await response).status()).toBe(200);
  await expect(page.locator("html")).toHaveAttribute("lang", to);
  await expect(
    (account ? page.locator("main") : page.locator("header")).getByLabel(
      createTranslator(to)("locale.label"),
      { exact: true },
    ),
  ).toBeEnabled();
}
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  // Detect clipped labels inside controls as well as document overflow.
  expect(
    await page.locator("button, nav a, label").evaluateAll((elements) =>
      elements
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return (
            rect.width > 0 &&
            getComputedStyle(element).overflowX === "hidden" &&
            element.scrollWidth > element.clientWidth + 1
          );
        })
        .map((element) => element.textContent),
    ),
  ).toEqual([]);
}

test("I18N-08 pre-auth explicit selection, navigator, reload and safe fallback", async ({
  browser,
}) => {
  for (const [navigatorLocale, expected] of [
    ["pl-PL", "pl"],
    ["en-US", "en"],
    ["de-DE", "es"],
  ] as const) {
    const context = await browser.newContext({ locale: navigatorLocale });
    const page = await context.newPage();
    try {
      await page.goto("/login");
      await expect(page.locator("html")).toHaveAttribute("lang", expected);
      await page
        .getByLabel(createTranslator(expected)("locale.label"), { exact: true })
        .selectOption("es");
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("lang", "es");
      expect(
        await page.evaluate(() => localStorage.getItem("rave-locale")),
      ).toBe("es");
    } finally {
      await context.close();
    }
  }
});

test("I18N-04/05/09 login account defaults override pre-login choice", async ({
  browser,
}) => {
  for (const [name, expected] of [
    ["jason", "es"],
    ["pareja", "pl"],
  ] as const) {
    await fixtureAccount(name, null);
    const context = await browser.newContext({ locale: "en-GB" });
    const page = await context.newPage();
    try {
      await page.goto("/login");
      await page.getByLabel("Username", { exact: true }).fill(name);
      await page
        .getByLabel("Password", { exact: true })
        .fill((await credentials())[name]);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(
        page.getByRole("heading", {
          name: createTranslator(expected)("nav.library"),
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("lang", expected);
    } finally {
      await context.close();
    }
  }
});

test("I18N-06/07/09/10 both accounts choose all languages; server wins on reload and another device", async ({
  browser,
}) => {
  const ownerContext = await browser.newContext(),
    partnerContext = await browser.newContext();
  const owner = await ownerContext.newPage(),
    partner = await partnerContext.newPage();
  try {
    await fixtureAccount("jason", null, owner);
    await fixtureAccount("pareja", null, partner);
    await owner.goto("/account");
    await partner.goto("/account");
    await expect(owner.locator("html")).toHaveAttribute("lang", "es");
    await expect(partner.locator("html")).toHaveAttribute("lang", "pl");
    await choose(owner, "es", "en", true);
    await expect(partner.locator("html")).toHaveAttribute("lang", "pl");
    expect(
      (await (await partner.request.get("/api/v1/auth/me")).json()).preferences
        .locale,
    ).toBe("pl");
    await owner.reload();
    await expect(owner.locator("html")).toHaveAttribute("lang", "en");
    await choose(owner, "en", "pl", true);
    await choose(owner, "pl", "es", true);
    await choose(owner, "es", "en", true);
    await choose(partner, "pl", "en", true);
    await choose(partner, "en", "es", true);
    await choose(partner, "es", "pl", true);
    await expect(owner.locator("html")).toHaveAttribute("lang", "en");
    // A fresh browser uses HTTP login, not a copied preference or localStorage.
    const fresh = await browser.newContext({ locale: "es-ES" });
    try {
      const page = await fresh.newPage();
      await page.goto("/login");
      await page.getByLabel("Usuario", { exact: true }).fill("jason");
      await page
        .getByLabel("Contraseña", { exact: true })
        .fill((await credentials()).jason);
      await page.getByRole("button", { name: "Entrar", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Library", exact: true }),
      ).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
    } finally {
      await fresh.close();
    }
  } finally {
    await ownerContext.close();
    await partnerContext.close();
  }
});

test("locale save failure rolls back UI and remains recoverable", async ({
  page,
}) => {
  await fixtureAccount("jason", "es", page);
  await page.goto("/account");
  await expect(
    page.getByRole("heading", { name: "Mi cuenta", exact: true }),
  ).toBeVisible();
  await page.route("**/api/v1/account", async (route) => {
    if (route.request().method() === "PATCH")
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ code: "INTERNAL_ERROR" }),
      });
    else await route.continue();
  });
  await page
    .locator("main")
    .getByLabel("Idioma de la interfaz", { exact: true })
    .selectOption("pl");
  await expect(page.locator("main").getByRole("alert")).toHaveText(
    createTranslator("es")("error.generic"),
  );
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  expect(
    (await (await page.request.get("/api/v1/auth/me")).json()).preferences
      .locale,
  ).toBe("es");
});

for (const locale of SUPPORTED_LOCALES) {
  test(`I18N-12/14/17/18 admin, library, account and player responsive/axe: ${locale}`, async ({
    page,
  }) => {
    const t = createTranslator(locale);
    await fixtureAccount("jason", locale, page);
    const ids = await fixtureIds();
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const path of [
        "/",
        "/account",
        "/admin",
        "/admin/videos",
        "/admin/videos/new",
        `/admin/videos/${ids.short}`,
        "/admin/accounts",
        "/admin/storage",
        "/admin/system",
        "/admin/integrations",
        "/not-found",
      ]) {
        await page.goto(path);
        await expect(page.locator("html")).toHaveAttribute("lang", locale);
        await expect(page.locator("main h1").first()).toBeVisible();
        await noOverflow(page);
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual(
          [],
        );
        if (path === "/admin/accounts") {
          await page
            .getByRole("button", { name: t("admin.disable"), exact: true })
            .click();
          await expect(
            page.getByRole("dialog", { name: t("admin.accountAccessConfirm") }),
          ).toBeVisible();
          await noOverflow(page);
          expect(
            (
              await new AxeBuilder({ page })
                .include('[role="dialog"]')
                .analyze()
            ).violations,
          ).toEqual([]);
          await page.keyboard.press("Tab");
          expect(
            await page.evaluate(() =>
              Boolean(document.activeElement?.closest('[role="dialog"]')),
            ),
          ).toBe(true);
          await page
            .getByRole("button", { name: t("common.cancel"), exact: true })
            .click();
        }
      }
      await page.goto(`/watch/${ids.short}`);
      const takeover = page.getByRole("button", {
        name: t("room.useDevice"),
        exact: true,
      });
      await page.locator("video").or(takeover).waitFor();
      if (await takeover.isVisible()) await takeover.click();
      await expect
        .poll(async () => (await videoState(page)).ready)
        .toBeGreaterThanOrEqual(3);
      await expect(
        page.getByRole("button", { name: t("player.play"), exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: t("player.settings"), exact: true })
        .click();
      await expect(
        page.getByLabel(t("player.quality"), { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByLabel(t("player.subtitles"), { exact: true }),
      ).toBeVisible();
      await noOverflow(page);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.keyboard.press("Escape");
    }
  });
  test(`I18N-08/15/17/18 login, activation and errors: ${locale}`, async ({
    page,
  }) => {
    const t = createTranslator(locale);
    await page.goto("/login");
    const initial = (await page.locator("html").getAttribute("lang")) as Locale;
    await page
      .getByLabel(createTranslator(initial)("locale.label"), { exact: true })
      .selectOption(locale);
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of ["/login", "/activate"]) {
        await page.goto(path);
        await expect(page.locator("html")).toHaveAttribute("lang", locale);
        await noOverflow(page);
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual(
          [],
        );
      }
    }
    await page.goto("/login");
    await page
      .getByLabel(t("login.username"), { exact: true })
      .fill(`unknown-${locale}`);
    await page.getByLabel(t("login.password"), { exact: true }).fill("invalid");
    await page
      .getByRole("button", { name: t("login.enter"), exact: true })
      .click();
    await expect(page.getByRole("alert")).toHaveText(
      t("error.INVALID_CREDENTIALS"),
    );
    const next = locale === "es" ? "pl" : "es";
    await page
      .getByLabel(t("locale.label"), { exact: true })
      .selectOption(next);
    await expect(page.getByRole("alert")).toHaveText(
      createTranslator(next)("error.INVALID_CREDENTIALS"),
    );
  });
}

test("I18N-11/13/14/17/18/20 language during two real players preserves room, socket, tracks and user chat", async ({
  browser,
}) => {
  const ca = await browser.newContext(),
    cb = await browser.newContext();
  const a = await ca.newPage(),
    b = await cb.newPage();
  let socketsOpened = 0,
    socketsClosed = 0;
  a.on("websocket", (socket) => {
    socketsOpened++;
    socket.on("close", () => socketsClosed++);
  });
  try {
    await fixtureAccount("jason", "es", a);
    await fixtureAccount("pareja", "pl", b);
    await a.goto("/");
    await b.goto("/");
    await expect(a.locator("html")).toHaveAttribute("lang", "es");
    await expect(b.locator("html")).toHaveAttribute("lang", "pl");
    const current = await (await a.request.get("/api/v1/room")).json();
    if (current.sessionId) {
      const own = await (await a.request.get("/api/v1/auth/me")).json();
      const host = current.hostUserId === own.id ? a : b;
      await host.goto("/room");
      const oldLocale = host === a ? "es" : "pl",
        t = createTranslator(oldLocale);
      const takeover = host.getByRole("button", {
        name: t("room.useDevice"),
        exact: true,
      });
      await host
        .getByRole("button", { name: t("room.close") })
        .or(takeover)
        .waitFor();
      if (await takeover.isVisible()) await takeover.click();
      await host.getByRole("button", { name: t("room.close") }).click();
      await host
        .getByRole("button", { name: t("common.confirm"), exact: true })
        .click();
    }
    const mediaId = (await fixtureIds()).short;
    const subtitleBody = "Napisy użytkownika — do not translate";
    const subtitle = await mutate(a, `/admin/videos/${mediaId}/subtitles`, {
      text: `1\n00:00:00,000 --> 00:02:00,000\n${subtitleBody}\n`,
      language: "pl",
      label: "[TEST] Locale-independent captions",
    });
    await mutate(a, "/room/start", {
      mediaId,
      personalPositionSeconds: 20,
    });
    for (const [page, locale] of [
      [a, "es"],
      [b, "pl"],
    ] as const) {
      const t = createTranslator(locale);
      await page.goto("/room");
      await expect
        .poll(async () => (await videoState(page)).ready)
        .toBeGreaterThanOrEqual(3);
      await page
        .getByRole("button", { name: t("room.activate"), exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: t("room.activate"), exact: true }),
      ).not.toBeVisible();
    }
    await a.getByRole("button", { name: "Ajustes", exact: true }).click();
    await a.getByLabel("Subtítulos", { exact: true }).selectOption(subtitle.id);
    await a.keyboard.press("Escape");
    await expect(a.getByText(subtitleBody, { exact: true })).toBeVisible();
    await expect
      .poll(
        async () =>
          (await (await a.request.get("/api/v1/auth/me")).json()).preferences
            .subtitleId,
      )
      .toBe(subtitle.id);
    await a.getByRole("button", { name: "Reproducir", exact: true }).click();
    await expect.poll(async () => (await videoState(a)).paused).toBe(false);
    await expect.poll(async () => (await videoState(b)).paused).toBe(false);
    const body = `Hola, cześć! This is our message — sin traducir. ${crypto.randomUUID()}`;
    await a.getByLabel("Mensaje", { exact: true }).fill(body);
    await a.getByRole("button", { name: "Enviar", exact: true }).click();
    await expect(b.getByText(body, { exact: true })).toBeVisible();
    await a.locator("video").evaluate((video: HTMLVideoElement) => {
      video.volume = 0.37;
      (
        window as unknown as {
          i18nOriginalVideo: HTMLVideoElement;
          i18nLoads: number;
        }
      ).i18nOriginalVideo = video;
      (window as unknown as { i18nLoads: number }).i18nLoads = 0;
      video.addEventListener(
        "loadstart",
        () => (window as unknown as { i18nLoads: number }).i18nLoads++,
      );
    });
    const socketBaseline = { opened: socketsOpened, closed: socketsClosed };
    let locale: Locale = "es";
    for (const next of ["pl", "en", "es"] as const) {
      const roomBefore = await (await a.request.get("/api/v1/room")).json();
      const playbackBefore = await videoState(a);
      const preferencesBefore = (
        await (await a.request.get("/api/v1/auth/me")).json()
      ).preferences;
      await choose(a, locale, next);
      locale = next;
      const roomAfter = await (await a.request.get("/api/v1/room")).json();
      const preferencesAfter = (
        await (await a.request.get("/api/v1/auth/me")).json()
      ).preferences;
      for (const field of [
        "volume",
        "muted",
        "subtitleId",
        "subtitleLanguage",
        "subtitleOffset",
        "subtitleSize",
        "subtitleBackground",
        "quality",
      ])
        expect(preferencesAfter[field]).toEqual(preferencesBefore[field]);
      for (const key of [
        "sessionId",
        "hostUserId",
        "hostEpoch",
        "revision",
        "desiredPlayback",
        "baseRate",
      ])
        expect(roomAfter[key]).toEqual(roomBefore[key]);
      expect(
        roomAfter.participants.map(
          (p: { userId: string; clientInstanceId: string }) => [
            p.userId,
            p.clientInstanceId,
          ],
        ),
      ).toEqual(
        roomBefore.participants.map(
          (p: { userId: string; clientInstanceId: string }) => [
            p.userId,
            p.clientInstanceId,
          ],
        ),
      );
      const after = await videoState(a);
      expect(after.src).toBe(playbackBefore.src);
      expect(after.time).toBeGreaterThanOrEqual(playbackBefore.time - 0.15);
      expect(after.paused).toBe(false);
      expect({ opened: socketsOpened, closed: socketsClosed }).toEqual(
        socketBaseline,
      );
      expect(
        await a.locator("video").evaluate((video: HTMLVideoElement) => ({
          same:
            video ===
            (window as unknown as { i18nOriginalVideo: HTMLVideoElement })
              .i18nOriginalVideo,
          loads: (window as unknown as { i18nLoads: number }).i18nLoads,
          volume: video.volume,
        })),
      ).toEqual({ same: true, loads: 0, volume: 0.37 });
      await expect(a.getByText(body, { exact: true })).toBeVisible();
      await expect(a.getByText(subtitleBody, { exact: true })).toBeVisible();
      await expect(b.getByText(body, { exact: true })).toBeVisible();
      const t = createTranslator(next);
      for (const width of [390, 768, 1440]) {
        await a.setViewportSize({ width, height: 1000 });
        await noOverflow(a);
        await expect(
          a.getByRole("heading", { name: t("nav.room"), exact: true }),
        ).toBeVisible();
        expect(
          (await new AxeBuilder({ page: a }).analyze()).violations,
        ).toEqual([]);
      }
    }
    await a.getByRole("button", { name: "Cerrar sesión compartida" }).click();
    await a.getByRole("button", { name: "Confirmar", exact: true }).click();
  } finally {
    await ca.close();
    await cb.close();
  }
});

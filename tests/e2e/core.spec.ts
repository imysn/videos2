import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  login,
  fixtureIds,
  mutate,
  videoState,
  twoPlayers,
  openSolo,
} from "./helpers";
test("PLAYER-06/09 y SEC-04: subtítulos seguros, desfase, capítulos y sprites reales", async ({
  page,
}) => {
  await login(page);
  const ids = await fixtureIds();
  await mutate(
    page,
    "/account",
    {
      preferences: {
        subtitleId: null,
        subtitleLanguage: null,
        subtitleOffset: 0,
      },
    },
    "PATCH",
  );
  const subtitle = await mutate(page, `/admin/videos/${ids.short}/subtitles`, {
    text: '1\n00:00:01,000 --> 00:00:06,000\nHola <b>José</b> & mundo\n\n2\n00:00:02,000 --> 00:00:08,000\n<img src="https://untrusted.invalid/evil" onerror="window.raveInjected=true">Cue solapado &#x1F44B;\n',
    language: "es",
    label: "[TEST] seguro",
  });
  await mutate(
    page,
    `/admin/videos/${ids.short}/chapters`,
    {
      chapters: [
        { startSeconds: 0, title: "Inicio" },
        { startSeconds: 30, title: "Segundo tramo" },
      ],
    },
    "PUT",
  );
  const unwanted: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("untrusted.invalid")) unwanted.push(r.url());
  });
  await openSolo(page, ids.short);
  await expect
    .poll(async () => (await videoState(page)).ready)
    .toBeGreaterThanOrEqual(3);
  await page.getByRole("button", { name: "Ajustes", exact: true }).click();
  await page
    .getByLabel("Subtítulos", { exact: true })
    .selectOption(subtitle.id);
  await page.keyboard.press("Escape");
  await page.locator("video").evaluate((v: HTMLVideoElement) => {
    v.currentTime = 3;
  });
  await expect(
    page.getByText("Hola José & mundo\nCue solapado 👋", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Ajustes", exact: true }).click();
  await page.getByLabel("Desfase (segundos)", { exact: true }).fill("2");
  await page.keyboard.press("Escape");
  await expect(
    page.getByText("Hola José & mundo", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { raveInjected?: boolean }).raveInjected,
    ),
  ).toBeUndefined();
  expect(unwanted).toHaveLength(0);
  const player = page.getByLabel("Reproductor de vídeo", { exact: true });
  await player.focus();
  await page.keyboard.press("c");
  await expect(
    page.getByText("Hola José & mundo", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Ajustes", exact: true }).click();
  await page.getByLabel("Ir al capítulo", { exact: true }).selectOption("30");
  await page.keyboard.press("Escape");
  await expect
    .poll(async () => (await videoState(page)).time)
    .toBeGreaterThanOrEqual(30);
  const timeline = page.getByLabel("Posición del vídeo", { exact: true }),
    box = await timeline.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  const thumbnail = page.locator('[style*="background-image"]');
  await expect(thumbnail).toBeVisible();
  const preview = await thumbnail.evaluate((element: HTMLElement) => ({
    image: element.style.backgroundImage,
    position: element.style.backgroundPosition,
  }));
  expect(preview.image).toContain("/media/assets/");
  expect(preview.position).toMatch(/px/);
  await timeline.dispatchEvent("pointercancel", {
    pointerId: 1,
    pointerType: "mouse",
  });
  await page.mouse.up();
  await page.waitForTimeout(750);
  const preferences = (await (await page.request.get("/api/v1/auth/me")).json())
    .preferences;
  expect(preferences.subtitleId).toBeNull();
  expect(preferences.subtitleLanguage).toBeNull();
  expect(preferences.subtitleOffset).toBe(2);
  await mutate(
    page,
    "/account",
    { preferences: { subtitleOffset: 0 } },
    "PATCH",
  );
});
test("PLAYER-08: fullscreen/PiP reales según capacidad y ausencia explícita", async ({
  page,
}) => {
  await login(page);
  const ids = await fixtureIds();
  await openSolo(page, ids.short);
  await expect
    .poll(async () => (await videoState(page)).ready)
    .toBeGreaterThanOrEqual(3);
  const capabilities = await page.evaluate(() => ({
    fullscreen: document.fullscreenEnabled,
    pip: document.pictureInPictureEnabled,
  }));
  if (capabilities.fullscreen) {
    await page
      .getByRole("button", { name: "Pantalla completa", exact: true })
      .click();
    await expect
      .poll(async () =>
        page.evaluate(() => Boolean(document.fullscreenElement)),
      )
      .toBe(true);
    await page
      .getByRole("button", { name: "Pantalla completa", exact: true })
      .click();
    await expect
      .poll(async () =>
        page.evaluate(() => Boolean(document.fullscreenElement)),
      )
      .toBe(false);
  }
  if (capabilities.pip) {
    await page.getByRole("button", { name: "PiP", exact: true }).click();
    await expect
      .poll(async () =>
        page.evaluate(() => Boolean(document.pictureInPictureElement)),
      )
      .toBe(true);
    await page.getByRole("button", { name: "PiP", exact: true }).click();
    await expect
      .poll(async () =>
        page.evaluate(() => Boolean(document.pictureInPictureElement)),
      )
      .toBe(false);
  }
  await page.goto("/");
  await page.addInitScript(() => {
    Object.defineProperty(document, "fullscreenEnabled", { get: () => false });
    Object.defineProperty(document, "pictureInPictureEnabled", {
      get: () => false,
    });
  });
  await openSolo(page, ids.short);
  await expect(
    page.getByRole("button", { name: "Pantalla completa", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "PiP", exact: true }),
  ).toHaveCount(0);
  await mkdir("artifacts/verification", { recursive: true });
  await writeFile(
    "artifacts/verification/player-capabilities.json",
    JSON.stringify(
      {
        status: "PASS",
        browser: "Chromium",
        physicalDevice: false,
        capabilities,
        unavailableControlsHidden: true,
      },
      null,
      2,
    ),
  );
});
test("LIB-02: volver desde la ficha conserva búsqueda, scroll y foco", async ({
  page,
}) => {
  await login(page);
  await page.getByLabel("Buscar", { exact: true }).fill("[TEST]");
  await expect
    .poll(() => new URL(page.url()).searchParams.get("search"))
    .toBe("[TEST]");
  const card = page.locator("[data-media-id]").first();
  await expect(card).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  const scroll = await page.evaluate(() => window.scrollY),
    id = await card.getAttribute("data-media-id");
  await card.click();
  await page.getByRole("link", { name: "← Biblioteca", exact: true }).click();
  await expect(page.getByLabel("Buscar", { exact: true })).toHaveValue(
    "[TEST]",
  );
  await expect
    .poll(async () =>
      page.evaluate(() =>
        document.activeElement?.getAttribute("data-media-id"),
      ),
    )
    .toBe(id);
  expect(
    Math.abs((await page.evaluate(() => window.scrollY)) - scroll),
  ).toBeLessThanOrEqual(2);
});
test("PLAYER-01: MP4 real, pausa, seek y progreso; teclado no secuestra formularios", async ({
  page,
}) => {
  await login(page);
  const ids = await fixtureIds();
  await openSolo(page, ids.short);
  await expect(page.locator("video")).toBeVisible();
  await expect
    .poll(async () => (await videoState(page)).ready)
    .toBeGreaterThanOrEqual(3);
  await page.getByRole("button", { name: "Reproducir", exact: true }).click();
  await expect
    .poll(async () => (await videoState(page)).time)
    .toBeGreaterThan(1);
  await page.getByRole("button", { name: "Pausar", exact: true }).click();
  const paused = await videoState(page);
  await page.waitForTimeout(800);
  expect(Math.abs((await videoState(page)).time - paused.time)).toBeLessThan(
    0.1,
  );
  await page.getByRole("button", { name: "Avanzar 10 segundos" }).click();
  await expect
    .poll(async () => (await videoState(page)).time)
    .toBeGreaterThan(paused.time + 9);
  await page.getByRole("button", { name: "Ajustes", exact: true }).click();
  await page.getByLabel("Velocidad", { exact: true }).selectOption("1.5");
  expect((await videoState(page)).rate).toBe(1.5);
  await page.keyboard.press("Escape");
  await mkdir("artifacts/visual", { recursive: true });
  await page.screenshot({ path: "artifacts/visual/solo.png" });
  await page.goto("/");
  await page.getByLabel("Buscar", { exact: true }).fill("jklmf");
  expect(await page.getByLabel("Buscar", { exact: true }).inputValue()).toBe(
    "jklmf",
  );
});
test("SYNC-01/02/03/06/17: dos vídeos reales, play, pausa, seek y transferencia", async ({
  browser,
}) => {
  const ids = await fixtureIds(),
    { a, b, ca, cb } = await twoPlayers(browser, ids.short);
  try {
    await a.getByRole("button", { name: "Reproducir", exact: true }).click();
    await expect
      .poll(async () => (await videoState(a)).time)
      .toBeGreaterThan(1);
    await expect
      .poll(async () => (await videoState(b)).time)
      .toBeGreaterThan(1);
    const samples = [];
    for (let i = 0; i < 8; i++) {
      const [x, y] = await Promise.all([videoState(a), videoState(b)]);
      samples.push({ a: x.time, b: y.time, error: Math.abs(x.time - y.time) });
      await a.waitForTimeout(500);
    }
    expect(Math.max(...samples.map((v) => v.error))).toBeLessThan(0.75);
    await a.getByRole("button", { name: "Pausar", exact: true }).click();
    await expect.poll(async () => (await videoState(b)).paused).toBe(true);
    await a.getByRole("button", { name: "Avanzar 10 segundos" }).click();
    const after = await videoState(a);
    await expect
      .poll(async () => Math.abs((await videoState(b)).time - after.time))
      .toBeLessThan(0.25);
    expect((await videoState(b)).paused).toBe(true);
    const mute = b.getByRole("button", { name: "Silenciar", exact: true });
    if (!(await mute.isVisible()))
      await b
        .getByRole("button", { name: "Activar sonido", exact: true })
        .click();
    await mute.click();
    expect(
      await b.locator("video").evaluate((v: HTMLVideoElement) => v.muted),
    ).toBe(true);
    expect(
      await a.locator("video").evaluate((v: HTMLVideoElement) => v.muted),
    ).toBe(false);
    await a.getByRole("button", { name: "Reproducir", exact: true }).click();
    await expect.poll(async () => (await videoState(b)).paused).toBe(false);
    await a
      .getByRole("button", { name: "Pasar el control", exact: true })
      .click();
    await expect(b.getByText("Tú controlas", { exact: true })).toBeVisible();
    await expect(
      a.getByRole("button", { name: "Pausar", exact: true }),
    ).toBeDisabled();
    await b.getByRole("button", { name: "Pausar", exact: true }).click();
    await expect.poll(async () => (await videoState(a)).paused).toBe(true);
    const message = `Hola 👋 <script>seguro</script> ${crypto.randomUUID()}`;
    await a.getByLabel("Mensaje", { exact: true }).fill(message);
    await a.getByRole("button", { name: "Enviar", exact: true }).click();
    await expect(b.getByText(message, { exact: true })).toBeVisible();
    await a.getByLabel("Mensaje", { exact: true }).fill("Escribiendo");
    await expect(
      b.getByText("Tu acompañante está escribiendo…", { exact: true }),
    ).toBeVisible();
    await expect(
      b.getByText("Tu acompañante está escribiendo…", { exact: true }),
    ).toHaveCount(0, { timeout: 5000 });
    for (const page of [a, b]) {
      const storage = await page.evaluate(() => ({
        local: { ...localStorage },
        session: { ...sessionStorage },
        cookies: document.cookie,
      }));
      expect(Object.keys(storage.local)).not.toContain("token");
      expect(JSON.stringify(storage)).not.toMatch(
        /refresh_token|access_token|rave=/,
      );
    }
    await mkdir("artifacts/sync", { recursive: true });
    await writeFile(
      "artifacts/sync/core-samples.json",
      JSON.stringify(samples, null, 2),
    );
    await b.screenshot({ path: "artifacts/visual/room-transfer.png" });
    await b.getByRole("button", { name: "Cerrar sesión compartida" }).click();
    await b.getByRole("button", { name: "Confirmar", exact: true }).click();
  } finally {
    await ca.close();
    await cb.close();
  }
});
test("PLAYER-02: HLS real de dos variantes con Shaka core", async ({
  page,
}) => {
  await login(page);
  const ids = await fixtureIds();
  await openSolo(page, ids.adaptive);
  await expect
    .poll(async () => (await videoState(page)).ready, { timeout: 20000 })
    .toBeGreaterThanOrEqual(3);
  await page.getByRole("button", { name: "Reproducir", exact: true }).click();
  await expect
    .poll(async () => (await videoState(page)).time)
    .toBeGreaterThan(1);
  await page.getByRole("button", { name: "Ajustes", exact: true }).click();
  await expect(
    page.getByLabel("Calidad", { exact: true }).locator("option"),
  ).toHaveCount(3);
  await page.getByLabel("Calidad", { exact: true }).selectOption({ index: 2 });
  await expect
    .poll(async () => (await videoState(page)).time)
    .toBeGreaterThan(2);
  expect(await page.locator("iframe").count()).toBe(0);
});
test("UX-01/02/SEC-04: rutas, móvil emulado y axe", async ({
  page,
  browser,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mkdir("artifacts/visual", { recursive: true });
  await login(page);
  const ids = await fixtureIds();
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of [
      "/",
      `/video/${ids.short}`,
      "/account",
      "/room",
      "/admin/videos",
      "/admin/integrations",
    ]) {
      await page.goto(route);
      await expect(page.locator("h1").first()).toBeVisible();
      await page.waitForTimeout(200);
      const dimensions = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        width: innerWidth,
      }));
      expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
      const axe = await new AxeBuilder({ page }).analyze();
      expect(
        axe.violations.filter(
          (v) => v.impact === "critical" || v.impact === "serious",
        ),
      ).toEqual([]);
      await page.screenshot({
        path: `artifacts/visual/${width}-${route.replace(/\W/g, "_") || "library"}.png`,
      });
    }
  }
  const unauthenticated = await browser.newContext({
    baseURL: "http://127.0.0.1:3001",
  });
  try {
    const loginPage = await unauthenticated.newPage();
    for (const width of [390, 768, 1440]) {
      await loginPage.setViewportSize({ width, height: 900 });
      await loginPage.goto("/login");
      await loginPage.getByLabel("Usuario", { exact: true }).focus();
      await loginPage.keyboard.press("Tab");
      await expect(
        loginPage.getByLabel("Contraseña", { exact: true }),
      ).toBeFocused();
      const result = await new AxeBuilder({ page: loginPage }).analyze();
      expect(
        result.violations.filter(
          (v) => v.impact === "critical" || v.impact === "serious",
        ),
      ).toEqual([]);
      await loginPage.screenshot({
        path: `artifacts/visual/${width}-login.png`,
      });
    }
  } finally {
    await unauthenticated.close();
  }
  const status = await page.request.get("/api/v1/admin/drive/status");
  expect((await status.json()).configured).toBe(false);
  await mutate(page, `/watchlist/${ids.short}`, { watched: false }, "PUT");
});
test("PLAYER-02: DASH VOD real de dos calidades en el mismo motor propio", async ({
  page,
}) => {
  await login(page);
  const ids = await fixtureIds();
  // Only the browser test substitutes a descriptor with a controlled media fixture.
  // Production keeps the real provider resolution and SSRF checks.
  await page.route(
    `**/api/v1/playback/${ids.adaptive}/resolve`,
    async (route) => {
      const response = await route.fetch(),
        descriptor = await response.json();
      await route.fulfill({
        response,
        json: {
          ...descriptor,
          kind: "dash",
          url: "/__fixtures/dash/master.mpd",
          mimeType: "application/dash+xml",
          approvedOrigins: ["http://127.0.0.1:3001"],
        },
      });
    },
  );
  await page.route("**/__fixtures/dash/*", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1)!;
    expect(/^(master\.mpd|(?:init|chunk)-[A-Za-z0-9-]+\.m4s)$/.test(name)).toBe(
      true,
    );
    await route.fulfill({
      status: 200,
      contentType: name.endsWith(".mpd") ? "application/dash+xml" : "video/mp4",
      body: await readFile(resolve(".local/fixtures/dash", name)),
    });
  });
  await openSolo(page, ids.adaptive);
  await expect
    .poll(async () => (await videoState(page)).ready, { timeout: 20000 })
    .toBeGreaterThanOrEqual(3);
  await page.getByRole("button", { name: "Reproducir", exact: true }).click();
  await expect
    .poll(async () => (await videoState(page)).time)
    .toBeGreaterThan(1);
  await page.getByRole("button", { name: "Ajustes", exact: true }).click();
  await expect(
    page.getByLabel("Calidad", { exact: true }).locator("option"),
  ).toHaveCount(3);
  await page.getByLabel("Calidad", { exact: true }).selectOption({ index: 2 });
  const audio = page.getByLabel("Pista de audio", { exact: true });
  await expect(audio.locator("option")).toHaveCount(3);
  await audio.selectOption({ index: 2 });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Avanzar 10 segundos" }).click();
  await expect
    .poll(async () => (await videoState(page)).time)
    .toBeGreaterThan(10);
  expect(await page.locator("iframe").count()).toBe(0);
});
test("PLAYER-10: veinte ciclos SPA y diez cambios liberan vídeo y memoria", async ({
  page,
}) => {
  await login(page);
  const ids = await fixtureIds();
  const navigate = async (url: string) => {
    await page.evaluate((path) => {
      history.pushState({}, "", path);
      dispatchEvent(new PopStateEvent("popstate"));
    }, url);
  };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const metrics = async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    const report = await cdp.send("Performance.getMetrics");
    return Object.fromEntries(report.metrics.map((v) => [v.name, v.value]));
  };
  let baseline: Record<string, number> | undefined;
  for (let i = 0; i < 22; i++) {
    await navigate(`/watch/${i % 2 ? ids.adaptive : ids.short}`);
    await page
      .locator("video")
      .or(
        page.getByRole("button", {
          name: "Usar este dispositivo",
          exact: true,
        }),
      )
      .waitFor();
    const takeover = page.getByRole("button", {
      name: "Usar este dispositivo",
      exact: true,
    });
    if (await takeover.isVisible()) await takeover.click();
    await expect
      .poll(async () => (await videoState(page)).ready, { timeout: 20000 })
      .toBeGreaterThanOrEqual(3);
    expect(await page.locator("video").count()).toBe(1);
    await navigate("/account");
    await expect(
      page.getByRole("heading", { name: "Mi cuenta", exact: true }),
    ).toBeVisible();
    await expect(page.locator("video")).toHaveCount(0);
    await page.waitForTimeout(80);
    if (i === 1) baseline = await metrics();
  }
  const after = await metrics(),
    growth = after.JSHeapUsedSize - baseline!.JSHeapUsedSize;
  await mkdir("artifacts/performance", { recursive: true });
  await writeFile(
    "artifacts/performance/player-lifecycle.json",
    JSON.stringify(
      {
        spaNavigation: true,
        cyclesMeasured: 20,
        mediaChanges: 10,
        garbageCollection: "CDP explicit at baseline/end",
        heapGrowthBytes: growth,
        nodesBefore: baseline!.Nodes,
        nodesAfter: after.Nodes,
        physicalDevice: false,
      },
      null,
      2,
    ),
  );
  expect(growth).toBeLessThan(16 * 1024 * 1024);
  expect(after.Nodes - baseline!.Nodes).toBeLessThan(2000);
});

test("LIB-09: ambas cuentas comparten pendientes y visto manual sin completar vídeo corto al empezar", async ({
  browser,
}) => {
  const aContext = await browser.newContext(),
    bContext = await browser.newContext(),
    a = await aContext.newPage(),
    b = await bContext.newPage();
  try {
    await login(a);
    await login(b, "pareja");
    const ids = await fixtureIds();
    await a.goto(`/video/${ids.short}`);
    await b.goto(`/video/${ids.short}`);
    const mark = a.getByRole("button", {
      name: "Marcar como visto",
      exact: true,
    });
    if (!(await mark.isVisible()))
      await a
        .getByRole("button", { name: "Marcar como no visto", exact: true })
        .click();
    await a
      .getByRole("button", { name: "Marcar como visto", exact: true })
      .click();
    await b.reload();
    await expect(
      b.getByRole("button", { name: "Marcar como no visto", exact: true }),
    ).toBeVisible();
    await b
      .getByRole("button", { name: "Marcar como no visto", exact: true })
      .click();
    await a.reload();
    await expect(
      a.getByRole("button", { name: "Marcar como visto", exact: true }),
    ).toBeVisible();
  } finally {
    await aContext.close();
    await bContext.close();
  }
});

test("PLAYER-11: archivo FFV1 incompatible da error accionable; copia preparada reproduce", async ({
  page,
}) => {
  const { execFileSync } = await import("node:child_process");
  const file = resolve(".local/fixtures/incompatible.mkv");
  execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x90:rate=10",
    "-t",
    "2",
    "-c:v",
    "ffv1",
    file,
  ]);
  const bytes = await readFile(file);
  await login(page);
  const ids = await fixtureIds();
  await page.route("**/media/*/file", (route) =>
    route.fulfill({
      status: 200,
      contentType: "video/x-matroska",
      body: bytes,
    }),
  );
  await openSolo(page, ids.short);
  await expect(
    page.getByText(
      "No se puede reproducir este formato aquí. Revisa la fuente o prepara una copia compatible.",
      { exact: true },
    ),
  ).toBeVisible();
  await page.unroute("**/media/*/file");
  await page.getByRole("link", { name: "Biblioteca", exact: true }).click();
  await openSolo(page, ids.short);
  await expect
    .poll(async () => (await videoState(page)).ready)
    .toBeGreaterThanOrEqual(3);
  await page.getByRole("button", { name: "Reproducir", exact: true }).click();
  await expect
    .poll(async () => (await videoState(page)).time)
    .toBeGreaterThan(1);
});

test("SEC-04: título/nombre de archivo son texto y portada SVG activa es rechazada", async ({
  page,
}) => {
  await login(page);
  const title =
      '<img src="https://untrusted.invalid/x" onerror="window.raveInjected=true"> [TEST] filename',
    requests: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("untrusted.invalid")) requests.push(r.url());
  });
  const uploaded = await mutate(page, "/admin/uploads", {
    title,
    description: "<script>window.raveInjected=true</script>",
    originalName: title,
    expectedBytes: 10,
  });
  try {
    await page.goto(`/admin/videos/${uploaded.mediaId}`);
    await expect(page.getByLabel("Título", { exact: true })).toHaveValue(title);
    const me = await (await page.request.get("/api/v1/auth/me")).json();
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>window.raveInjected=true</script><image href="https://untrusted.invalid/cover"/></svg>';
    const response = await page.request.post(
      `/api/v1/admin/videos/${uploaded.mediaId}/poster`,
      {
        headers: {
          Origin: "http://127.0.0.1:3001",
          "X-CSRF-Token": me.csrf,
          "Idempotency-Key": crypto.randomUUID(),
        },
        data: { imageBase64: Buffer.from(svg).toString("base64") },
      },
    );
    expect(response.status()).toBe(400);
    expect(
      await page.evaluate(
        () => (window as unknown as { raveInjected?: boolean }).raveInjected,
      ),
    ).toBeUndefined();
    expect(requests).toHaveLength(0);
  } finally {
    await mutate(page, `/admin/uploads/${uploaded.id}`, {}, "DELETE");
  }
});

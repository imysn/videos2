import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdir, writeFile } from "node:fs/promises";
import {
  login,
  fixtureIds,
  mutate,
  videoState,
  twoPlayers,
  openSolo,
} from "./helpers";
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
test("UX-01/02/SEC-04: rutas, móvil emulado y axe", async ({ page }) => {
  await mkdir("artifacts/visual", { recursive: true });
  await login(page);
  const ids = await fixtureIds();
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of [
      "/",
      `/video/${ids.short}`,
      "/account",
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
  const status = await page.request.get("/api/v1/admin/drive/status");
  expect((await status.json()).configured).toBe(false);
  await mutate(page, `/watchlist/${ids.short}`, { watched: false }, "PUT");
});

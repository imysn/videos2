import { beforeAll, afterAll, it, expect } from "vitest";
import {
  chromium,
  expect as browserExpect,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { testApp, actor, syntheticVideo } from "../helpers/context.js";
let app: Awaited<ReturnType<typeof testApp>>,
  browser: Browser,
  media: Awaited<ReturnType<typeof syntheticVideo>>;
beforeAll(async () => {
  app = await testApp();
  const owner = await actor(app);
  await app.db.query("UPDATE rooms SET active_session_id=NULL");
  await app.db.query(
    "UPDATE viewing_sessions SET ended_at=now() WHERE ended_at IS NULL",
  );
  media = await syntheticVideo(app, owner.identity);
  const root = resolve(process.env.RAVE_VALIDATION_WEB_ROOT ?? "dist/web");
  const { createApp } = await import("../../apps/api/src/server.js");
  await app.app.close();
  app = {
    ...app,
    ...(await createApp(app.config, { logger: false, webRoot: root })),
  };
  await app.app.listen({ host: "127.0.0.1", port: app.config.PORT });
  browser = await chromium.launch({
    executablePath: "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
});
afterAll(async () => {
  await browser?.close();
  await app?.app.close();
});
async function participant(name: string) {
  const auth = await actor(app, name),
    context = await browser.newContext({ baseURL: app.config.origin });
  await context.addCookies([
    {
      name: app.config.cookieName,
      value: auth.cookie.split("=")[1],
      url: app.config.origin,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  return { context, page: await context.newPage(), auth };
}
async function state(page: Page) {
  return page.locator("video").evaluate((video: HTMLVideoElement) => ({
    time: video.currentTime,
    paused: video.paused,
    ready: video.readyState,
  }));
}
async function prepared(page: Page) {
  await page.goto("/room");
  await browserExpect
    .poll(async () => (await state(page)).ready, { timeout: 15000 })
    .toBeGreaterThanOrEqual(3);
  await page
    .getByRole("button", { name: "Pulsa para activar la reproducción" })
    .click();
}
async function finish(page: Page, contexts: BrowserContext[]) {
  try {
    const button = page.getByRole("button", {
      name: "Cerrar sesión compartida",
    });
    if (await button.isVisible()) {
      await button.click();
      await page
        .getByRole("button", { name: "Confirmar", exact: true })
        .click();
    }
  } finally {
    for (const context of contexts) await context.close();
  }
}
it("SYNC-14/23: corte real de WebSocket, sin órdenes offline; recuperación con RTT/jitter", async () => {
  const a = await participant("jason"),
    b = await participant("pareja");
  let cut = false;
  const frames: Record<string, number> = {};
  const sockets: {
    close: (options?: { code?: number; reason?: string }) => void;
  }[] = [];
  await b.context.routeWebSocket("**/socket.io/**", (socket) => {
    if (cut) {
      socket.close({ code: 1001, reason: "Fault injection: unavailable link" });
      return;
    }
    sockets.push(socket);
    const server = socket.connectToServer();
    sockets.push(server);
    let upstream = Promise.resolve(),
      downstream = Promise.resolve();
    const delay = () =>
      new Promise<void>((done) => setTimeout(done, 25 + Math.random() * 50));
    socket.onMessage((message) => {
      const event = String(message).match(/^42\d*\["([^"]+)"/);
      if (event) frames["up:" + event[1]] = (frames["up:" + event[1]] ?? 0) + 1;
      upstream = upstream.then(delay).then(() => server.send(message));
    });
    server.onMessage((message) => {
      const event = String(message).match(/^42\d*\["([^"]+)"/);
      if (event)
        frames["down:" + event[1]] = (frames["down:" + event[1]] ?? 0) + 1;
      downstream = downstream.then(delay).then(() => socket.send(message));
    });
  });
  try {
    await app.room.start(a.auth.identity, media.id);
    await prepared(a.page);
    await prepared(b.page);
    await a.page
      .getByRole("button", { name: "Reproducir", exact: true })
      .click();
    await browserExpect
      .poll(async () => (await state(a.page)).paused)
      .toBe(false);
    await browserExpect
      .poll(async () => (await state(b.page)).paused)
      .toBe(false);
    await a.page.waitForTimeout(2000);
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    cut = true;
    for (const socket of app.transport.io.sockets.sockets.values())
      if (socket.data.identity?.user.id === b.auth.identity.user.id)
        socket.conn.close(true);
    await a.page.waitForTimeout(1000);
    await browserExpect
      .poll(async () => (await state(a.page)).paused, { timeout: 5000 })
      .toBe(true);
    await browserExpect(
      b.page.getByRole("button", { name: "Pausar", exact: true }),
    ).toBeDisabled();
    await b.page.waitForTimeout(3000);
    const before = await app.room.snapshot();
    cut = false;
    const recoveryStarted = performance.now();
    await browserExpect(
      b.page.getByText("Conectado", { exact: true }),
    ).toBeVisible({ timeout: 15000 });
    await browserExpect
      .poll(async () => (await state(a.page)).paused, { timeout: 3000 })
      .toBe(false);
    await browserExpect
      .poll(async () => (await state(b.page)).paused, { timeout: 3000 })
      .toBe(false);
    await b.page.waitForTimeout(1200);
    const first = await state(a.page),
      second = await state(b.page);
    expect(Math.abs(first.time - second.time)).toBeLessThanOrEqual(0.75);
    expect(frames["down:room:snapshot"]).toBeLessThan(30);
    expect((await app.room.snapshot()).sessionId).toBe(before.sessionId);
    await mkdir("artifacts/network", { recursive: true });
    await writeFile(
      "artifacts/network/reconnect.json",
      JSON.stringify(
        {
          actualWebSocketFault: true,
          actualVideoElements: 2,
          extraRttMs: 100,
          jitterMs: 50,
          cutSeconds: 3,
          recoveryMs: performance.now() - recoveryStarted,
          snapshotsReceived: frames["down:room:snapshot"],
          finalErrorSeconds: Math.abs(first.time - second.time),
          queuedCommands: false,
        },
        null,
        2,
      ),
    );
  } finally {
    cut = false;
    await finish(a.page, [a.context, b.context]);
  }
});
it("PLAYER-07 / SYNC-11: pausa externa del acompañante requiere activación; pausa del host se conserva", async () => {
  const a = await participant("jason"),
    b = await participant("pareja");
  try {
    await app.room.start(a.auth.identity, media.id);
    await prepared(a.page);
    await prepared(b.page);
    await a.page
      .getByRole("button", { name: "Reproducir", exact: true })
      .click();
    await browserExpect
      .poll(async () => (await state(b.page)).paused)
      .toBe(false);
    await b.page
      .locator("video")
      .evaluate((video: HTMLVideoElement) => video.pause());
    await browserExpect(
      b.page.getByRole("button", {
        name: "Pulsa para activar la reproducción",
      }),
    ).toBeVisible();
    await browserExpect
      .poll(async () => (await state(a.page)).paused)
      .toBe(true);
    await a.page.getByRole("button", { name: "Pausar", exact: true }).click();
    await b.page
      .getByRole("button", { name: "Pulsa para activar la reproducción" })
      .click();
    await b.page.waitForTimeout(1000);
    expect((await state(a.page)).paused).toBe(true);
    expect((await state(b.page)).paused).toBe(true);
    expect((await app.room.snapshot()).desiredPlayback).toBe("paused");
  } finally {
    await finish(a.page, [a.context, b.context]);
  }
});

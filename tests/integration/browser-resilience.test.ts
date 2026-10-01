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
import { Worker } from "../../apps/worker/src/worker.js";
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
  const hls = await app.jobs.enqueue(
      "hls",
      media.id,
      `browser-hls:${media.id}`,
      {},
    ),
    worker = new Worker(app.db, app.config);
  while (
    (await app.db.query("SELECT state FROM jobs WHERE id=$1", [hls.id]))[0]
      .state === "queued"
  )
    await worker.runNext();
  expect(
    (await app.db.query("SELECT state FROM jobs WHERE id=$1", [hls.id]))[0]
      .state,
  ).toBe("succeeded");
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
    measuredAt: performance.timeOrigin + performance.now(),
    rate: video.playbackRate,
  }));
}
async function drift(a: Page, b: Page) {
  const [first, second] = await Promise.all([state(a), state(b)]);
  const common = Math.max(first.measuredAt, second.measuredAt);
  const position = (s: typeof first) =>
    s.time + (s.paused ? 0 : ((common - s.measuredAt) * s.rate) / 1000);
  return Math.abs(position(first) - position(second));
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
    await app.room.start(a.auth.identity, media.id, 0);
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
    await app.room.start(a.auth.identity, media.id, 0);
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
it("PLAYER-04: cincuenta movimientos generan un solo SEEK; pointercancel conserva posición", async () => {
  const a = await participant("jason"),
    b = await participant("pareja");
  try {
    await app.room.start(a.auth.identity, media.id, 0);
    await prepared(a.page);
    await prepared(b.page);
    const session = (await app.room.snapshot()).sessionId;
    const count = async () =>
      Number(
        (
          await app.db.query<{ count: string }>(
            "SELECT count(*) FROM command_receipts WHERE session_id=$1",
            [session],
          )
        )[0].count,
      );
    const before = await count(),
      timeline = a.page.getByLabel("Posición del vídeo", { exact: true }),
      box = await timeline.boundingBox();
    expect(box).not.toBeNull();
    await a.page.mouse.move(box!.x + 8, box!.y + box!.height / 2);
    await a.page.mouse.down();
    for (let i = 0; i < 50; i++)
      await a.page.mouse.move(
        box!.x + box!.width * (0.05 + (0.5 * i) / 49),
        box!.y + box!.height / 2,
      );
    expect(await count()).toBe(before);
    await a.page.mouse.up();
    await browserExpect.poll(count).toBe(before + 1);
    await browserExpect
      .poll(async () => drift(a.page, b.page))
      .toBeLessThan(0.25);
    const position = (await state(a.page)).time;
    await a.page.mouse.move(
      box!.x + box!.width * 0.55,
      box!.y + box!.height / 2,
    );
    await a.page.mouse.down();
    await a.page.mouse.move(
      box!.x + box!.width * 0.8,
      box!.y + box!.height / 2,
    );
    await timeline.dispatchEvent("pointercancel", {
      pointerId: 1,
      pointerType: "mouse",
    });
    await a.page.mouse.up();
    await a.page.waitForTimeout(500);
    expect(await count()).toBe(before + 1);
    expect(Math.abs((await state(a.page)).time - position)).toBeLessThan(0.25);
  } finally {
    await finish(a.page, [a.context, b.context]);
  }
});
it("SYNC-09/12: empezar sin acompañante espera; continuar y entrar tarde conserva tiempo", async () => {
  const a = await participant("jason"),
    b = await participant("pareja");
  try {
    await app.room.start(a.auth.identity, media.id, 0);
    await prepared(a.page);
    await a.page
      .getByRole("button", { name: "Reproducir", exact: true })
      .click();
    await a.page.waitForTimeout(600);
    expect((await state(a.page)).paused).toBe(true);
    await a.page
      .getByRole("button", { name: "Continuar sin esperar", exact: true })
      .click();
    await browserExpect
      .poll(async () => (await state(a.page)).time)
      .toBeGreaterThan(1);
    await a.page.waitForTimeout(2500);
    const before = (await state(a.page)).time;
    await prepared(b.page);
    await browserExpect
      .poll(async () => drift(a.page, b.page), { timeout: 5000 })
      .toBeLessThan(0.25);
    expect((await state(b.page)).time).toBeGreaterThan(before - 1);
  } finally {
    await finish(a.page, [a.context, b.context]);
  }
});
it("SYNC-18/21: relojes desfasados y deriva real convergen sin emitir una orden desde el motor", async () => {
  const a = await participant("jason"),
    b = await participant("pareja");
  await a.context.addInitScript(() => {
    const now = Date.now;
    Date.now = () => now() + 300000;
  });
  await b.context.addInitScript(() => {
    const now = Date.now;
    Date.now = () => now() - 180000;
  });
  try {
    await app.room.start(a.auth.identity, media.id, 0);
    await prepared(a.page);
    await prepared(b.page);
    await a.page.getByRole("button", { name: "Ajustes", exact: true }).click();
    await a.page.getByLabel("Velocidad", { exact: true }).selectOption("1.5");
    await a.page.keyboard.press("Escape");
    await a.page
      .getByRole("button", { name: "Reproducir", exact: true })
      .click();
    await browserExpect
      .poll(async () => (await state(b.page)).paused)
      .toBe(false);
    // Activation may briefly play before the barrier's future anchor. Introduce
    // drift only once both engines are actually following the shared timeline.
    await browserExpect
      .poll(async () =>
        Math.min((await state(a.page)).time, (await state(b.page)).time),
      )
      .toBeGreaterThan(2);
    await browserExpect
      .poll(async () => drift(a.page, b.page))
      .toBeLessThan(0.15);
    const revision = (await app.room.snapshot()).revision;
    await b.page.locator("video").evaluate((v: HTMLVideoElement) => {
      v.currentTime += 1.5;
    });
    await browserExpect
      .poll(async () => drift(a.page, b.page), { timeout: 4000 })
      .toBeLessThan(0.25);
    expect((await app.room.snapshot()).revision).toBe(revision);
    const actualRate = await a.page
      .locator("video")
      .evaluate((v: HTMLVideoElement) => v.playbackRate);
    expect(Math.abs(actualRate / 1.5 - 1)).toBeLessThanOrEqual(
      0.05 + Number.EPSILON,
    );
    expect((await app.room.snapshot()).baseRate).toBe(1.5);
  } finally {
    await finish(a.page, [a.context, b.context]);
  }
});
it("SYNC-15: reinicio real recupera checkpoint pausado sin avanzar durante la caída", async () => {
  const a = await participant("jason"),
    b = await participant("pareja");
  try {
    await app.room.start(a.auth.identity, media.id, 0);
    await prepared(a.page);
    await prepared(b.page);
    await a.page
      .getByRole("button", { name: "Reproducir", exact: true })
      .click();
    await browserExpect
      .poll(async () => (await state(b.page)).time, { timeout: 10000 })
      .toBeGreaterThan(6);
    const prior = await app.room.snapshot(),
      config = app.config,
      passwords = app.passwords;
    await app.app.close();
    await a.page.waitForTimeout(1500);
    const { createApp } = await import("../../apps/api/src/server.js");
    app = {
      ...(await createApp(config, {
        logger: false,
        webRoot: resolve(process.env.RAVE_VALIDATION_WEB_ROOT ?? "dist/web"),
      })),
      passwords,
    };
    await app.app.listen({ host: "127.0.0.1", port: config.PORT });
    await browserExpect(
      a.page.getByText("Conectado", { exact: true }),
    ).toBeVisible({ timeout: 15000 });
    await browserExpect(
      b.page.getByText("Conectado", { exact: true }),
    ).toBeVisible({ timeout: 15000 });
    const recovered = await app.room.snapshot();
    expect(recovered.serverInstanceId).not.toBe(prior.serverInstanceId);
    expect(recovered.sessionId).toBe(prior.sessionId);
    expect(recovered.phase).toBe("paused");
    await browserExpect
      .poll(async () =>
        Math.abs((await state(a.page)).time - recovered.anchorPositionSeconds),
      )
      .toBeLessThan(0.25);
    expect((await state(a.page)).paused).toBe(true);
    expect((await state(b.page)).paused).toBe(true);
    const time = (await state(a.page)).time;
    await a.page.waitForTimeout(1000);
    expect(Math.abs((await state(a.page)).time - time)).toBeLessThan(0.1);
  } finally {
    await finish(a.page, [a.context, b.context]);
  }
});
it.each([false, true])(
  "SYNC-10/11: buffering multimedia real; pausa voluntaria=%s",
  async (manualPause) => {
    const a = await participant("jason"),
      b = await participant("pareja");
    let cut = false,
      release: () => void = () => {};
    const blocked = new Promise<void>((done) => {
      release = done;
    });
    await b.context.route("**/media/local-hls/**", async (route) => {
      if (cut && route.request().url().endsWith(".m4s")) await blocked;
      await route.continue().catch(() => {});
    });
    try {
      await app.room.start(a.auth.identity, media.id, 0);
      await prepared(a.page);
      await prepared(b.page);
      await a.page
        .getByRole("button", { name: "Reproducir", exact: true })
        .click();
      await browserExpect
        .poll(async () =>
          Math.min((await state(a.page)).time, (await state(b.page)).time),
        )
        .toBeGreaterThan(2);
      await b.page.locator("video").evaluate((v: HTMLVideoElement) => {
        (window as unknown as { bufferingStarted?: number }).bufferingStarted =
          undefined;
        v.addEventListener(
          "waiting",
          () => {
            (
              window as unknown as { bufferingStarted?: number }
            ).bufferingStarted ??= performance.timeOrigin + performance.now();
          },
          { once: true },
        );
      });
      await a.page.locator("video").evaluate((v: HTMLVideoElement) => {
        v.addEventListener(
          "pause",
          () => {
            (window as unknown as { hostPausedAt?: number }).hostPausedAt =
              performance.timeOrigin + performance.now();
          },
          { once: true },
        );
      });
      cut = true;
      await browserExpect
        .poll(async () => (await app.room.snapshot()).blockReason, {
          timeout: 25000,
        })
        .toBe("BUFFERING");
      await browserExpect
        .poll(async () => (await state(a.page)).paused, { timeout: 1500 })
        .toBe(true);
      const bufferingAt = await b.page.evaluate(
        () =>
          (window as unknown as { bufferingStarted?: number }).bufferingStarted,
      );
      const pausedAt = await a.page.evaluate(
        () => (window as unknown as { hostPausedAt?: number }).hostPausedAt,
      );
      expect(bufferingAt).toBeDefined();
      expect(pausedAt).toBeDefined();
      const latency = pausedAt! - bufferingAt!;
      expect(latency).toBeGreaterThanOrEqual(0);
      expect(latency).toBeLessThan(1500);
      await a.page.waitForTimeout(3000);
      if (manualPause)
        await a.page
          .getByRole("button", { name: "Pausar", exact: true })
          .click();
      release();
      cut = false;
      if (manualPause) {
        await a.page.waitForTimeout(2500);
        expect((await app.room.snapshot()).desiredPlayback).toBe("paused");
        expect((await state(a.page)).paused).toBe(true);
        expect((await state(b.page)).paused).toBe(true);
      } else {
        await browserExpect
          .poll(async () => (await state(b.page)).paused, { timeout: 15000 })
          .toBe(false);
        await browserExpect
          .poll(
            async () =>
              Math.abs((await state(a.page)).time - (await state(b.page)).time),
            { timeout: 3000 },
          )
          .toBeLessThan(0.25);
      }
      await mkdir("artifacts/network", { recursive: true });
      await writeFile(
        `artifacts/network/buffering-${manualPause ? "manual" : "resume"}.json`,
        JSON.stringify(
          {
            status: "PASS",
            realHls: true,
            heldAfterBufferingMs: 3000,
            manualPause,
            hostPauseAfterWaitingMs: latency,
            physicalDevice: false,
          },
          null,
          2,
        ),
      );
    } finally {
      release();
      await finish(a.page, [a.context, b.context]);
    }
  },
);
it("SYNC-16: tres contextos y transferencia de dispositivo dejan un solo lease", async () => {
  const a = await participant("jason"),
    b = await participant("pareja"),
    replacement = await participant("jason");
  try {
    await app.room.start(a.auth.identity, media.id, 0);
    await prepared(a.page);
    await prepared(b.page);
    await replacement.page.goto("/room");
    await replacement.page
      .getByRole("button", { name: "Usar este dispositivo", exact: true })
      .click();
    await browserExpect(
      replacement.page.getByText("Conectado", { exact: true }),
    ).toBeVisible();
    await browserExpect(
      a.page.getByRole("button", { name: "Reproducir", exact: true }),
    ).toBeDisabled();
    expect(
      await app.db.query(
        "SELECT user_id FROM playback_leases WHERE user_id=$1 AND revoked_at IS NULL",
        [a.auth.identity.user.id],
      ),
    ).toHaveLength(1);
    const snapshot = await app.room.snapshot();
    expect(
      snapshot.participants.filter((p) => p.userId === a.auth.identity.user.id),
    ).toHaveLength(1);
  } finally {
    await finish(replacement.page, [a.context, b.context, replacement.context]);
  }
});
it("SYNC-13: sin Esperarnos el host continúa durante buffering real y el otro recupera tiempo", async () => {
  const a = await participant("jason"),
    b = await participant("pareja");
  let cut = false,
    release: () => void = () => {};
  const held = new Promise<void>((done) => (release = done));
  await b.context.route("**/media/local-hls/**", async (route) => {
    if (cut && route.request().url().endsWith(".m4s")) await held;
    await route.continue().catch(() => {});
  });
  try {
    await app.room.start(a.auth.identity, media.id, 0);
    await prepared(a.page);
    await prepared(b.page);
    await a.page.getByLabel("Esperarnos", { exact: true }).click();
    await browserExpect(
      a.page.getByLabel("Esperarnos", { exact: true }),
    ).not.toBeChecked();
    await a.page
      .getByRole("button", { name: "Reproducir", exact: true })
      .click();
    await browserExpect
      .poll(async () =>
        Math.min((await state(a.page)).time, (await state(b.page)).time),
      )
      .toBeGreaterThan(2);
    cut = true;
    await browserExpect
      .poll(async () => (await state(b.page)).ready, { timeout: 25000 })
      .toBeLessThan(3);
    const before = (await state(a.page)).time;
    await a.page.waitForTimeout(3000);
    expect((await state(a.page)).paused).toBe(false);
    expect((await state(a.page)).time - before).toBeGreaterThan(2.5);
    release();
    cut = false;
    await browserExpect
      .poll(async () => (await state(b.page)).ready, { timeout: 15000 })
      .toBeGreaterThanOrEqual(3);
    await browserExpect
      .poll(
        async () =>
          Math.abs((await state(a.page)).time - (await state(b.page)).time),
        { timeout: 3000 },
      )
      .toBeLessThan(0.25);
  } finally {
    release();
    await finish(a.page, [a.context, b.context]);
  }
});
it("SYNC-08/14: anfitrión offline no acumula órdenes; reclamación tras quince segundos", async () => {
  const a = await participant("jason"),
    b = await participant("pareja");
  let cut = false;
  await a.context.routeWebSocket("**/socket.io/**", (socket) => {
    if (cut) socket.close({ code: 1001, reason: "Test link down" });
    else socket.connectToServer();
  });
  try {
    await app.room.start(a.auth.identity, media.id, 0);
    await prepared(a.page);
    await prepared(b.page);
    cut = true;
    for (const socket of app.transport.io.sockets.sockets.values())
      if (socket.data.identity?.user.id === a.auth.identity.user.id)
        socket.conn.close(true);
    await browserExpect(
      a.page.getByRole("button", { name: "Reproducir", exact: true }),
    ).toBeDisabled();
    const before = await app.room.snapshot();
    await b.page.getByRole("button", { name: /Tomar el control/ }).click();
    await b.page.waitForTimeout(500);
    expect((await app.room.snapshot()).hostUserId).toBe(
      a.auth.identity.user.id,
    );
    await b.page.waitForTimeout(15500);
    await b.page.getByRole("button", { name: /Tomar el control/ }).click();
    await browserExpect(
      b.page.getByText("Tú controlas", { exact: true }),
    ).toBeVisible();
    expect((await app.room.snapshot()).hostEpoch).toBe(before.hostEpoch + 1);
    cut = false;
    await browserExpect(
      a.page.getByText("Conectado", { exact: true }),
    ).toBeVisible({ timeout: 15000 });
    await browserExpect(
      a.page.getByRole("button", { name: "Reproducir", exact: true }),
    ).toBeDisabled();
    expect((await app.room.snapshot()).desiredPlayback).toBe("paused");
  } finally {
    cut = false;
    await finish(b.page, [a.context, b.context]);
  }
});
it("SYNC-24: final real persiste progreso y volver conserva pausa hasta intención de replay", async () => {
  const a = await participant("jason"),
    b = await participant("pareja");
  try {
    await app.room.start(a.auth.identity, media.id, 118);
    await prepared(a.page);
    await prepared(b.page);
    await a.page
      .getByRole("button", { name: "Reproducir", exact: true })
      .click();
    await browserExpect
      .poll(async () => (await app.room.snapshot()).phase, { timeout: 10000 })
      .toBe("ended");
    await browserExpect
      .poll(async () => (await state(a.page)).paused)
      .toBe(true);
    await browserExpect
      .poll(async () => (await state(b.page)).paused)
      .toBe(true);
    const progress = (
      await app.db.query(
        "SELECT position_seconds FROM shared_progress WHERE media_id=$1 AND content_generation=$2",
        [media.id, media.content_generation],
      )
    )[0];
    expect(progress.position_seconds).toBe(120);
    await a.page
      .getByRole("button", { name: "Cerrar sesión compartida" })
      .click();
    await a.page
      .getByRole("button", { name: "Confirmar", exact: true })
      .click();
    await app.room.start(a.auth.identity, media.id);
    await prepared(a.page);
    await prepared(b.page);
    expect((await app.room.snapshot()).phase).toBe("ended");
    expect((await state(b.page)).paused).toBe(true);
    await a.page
      .getByRole("button", { name: "Reproducir", exact: true })
      .click();
    await browserExpect
      .poll(
        async () => {
          const value = await state(b.page);
          return !value.paused && value.time > 1 && value.time < 10;
        },
        { timeout: 10000 },
      )
      .toBe(true);
    expect((await state(b.page)).time).toBeLessThan(10);
  } finally {
    await finish(a.page, [a.context, b.context]);
  }
});
it("SYNC-19: cambiar vídeo durante resolve demorado descarta la carga antigua en ambos motores", async () => {
  const a = await participant("jason"),
    b = await participant("pareja"),
    next = await syntheticVideo(app, a.auth.identity, "adaptive.mp4");
  let release!: () => void,
    blocked = false;
  const wait = new Promise<void>((done) => (release = done));
  await b.context.route("**/api/v1/room/playback/resolve", async (route) => {
    const response = await route.fetch(),
      body = await response.json();
    if (body.mediaId === media.id && !blocked) {
      blocked = true;
      await wait;
    }
    await route.fulfill({ response });
  });
  try {
    await app.room.start(a.auth.identity, media.id, 0);
    await prepared(a.page);
    await b.page.goto("/room");
    await browserExpect.poll(() => blocked).toBe(true);
    await a.page
      .getByLabel("Cambiar vídeo", { exact: true })
      .selectOption(next.id);
    await a.page
      .getByRole("button", { name: "Cambiar vídeo", exact: true })
      .click();
    await a.page
      .getByRole("button", { name: "Confirmar", exact: true })
      .click();
    await browserExpect
      .poll(async () => (await app.room.snapshot()).media?.mediaId)
      .toBe(next.id);
    await browserExpect
      .poll(async () => (await state(b.page)).ready)
      .toBeGreaterThanOrEqual(3);
    release();
    await b.page.waitForTimeout(1000);
    for (const page of [a.page, b.page]) {
      const current = await page
        .locator("video")
        .evaluate((v: HTMLVideoElement) => v.currentSrc);
      expect(current).toContain(next.primary_source_id!);
      expect(current).not.toContain(media.primary_source_id!);
    }
  } finally {
    release();
    await finish(a.page, [a.context, b.context]);
  }
});
it("SRC-09: dos motores con versiones de distinta duración bloquean la sala", async () => {
  const a = await participant("jason"),
    b = await participant("pareja"),
    other = await syntheticVideo(app, a.auth.identity, "adaptive.mp4");
  await b.context.route("**/api/v1/room/playback/resolve", async (route) => {
    const response = await route.fetch(),
      body = await response.json();
    await route.fulfill({
      response,
      json: {
        ...body,
        kind: "file",
        delivery: "relay",
        url: `/media/${other.primary_source_id}/file`,
      },
    });
  });
  try {
    await app.room.start(a.auth.identity, media.id, 0);
    await prepared(a.page);
    await prepared(b.page);
    expect(
      await b.page
        .locator("video")
        .evaluate((v: HTMLVideoElement) => v.duration),
    ).toBeCloseTo(20, 0);
    await a.page
      .getByRole("button", { name: "Reproducir", exact: true })
      .click();
    await browserExpect
      .poll(async () => (await app.room.snapshot()).blockReason)
      .toBe("SOURCE_UNSUPPORTED");
    for (const page of [a.page, b.page])
      await browserExpect
        .poll(async () => (await state(page)).paused)
        .toBe(true);
    expect((await app.room.snapshot()).desiredPlayback).toBe("paused");
  } finally {
    await finish(a.page, [a.context, b.context]);
  }
});

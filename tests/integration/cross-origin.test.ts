import { beforeAll, afterAll, it, expect } from "vitest";
import {
  chromium,
  expect as browserExpect,
  type Browser,
} from "@playwright/test";
import { createServer, type Server } from "node:https";
import { readFile, mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { testApp, actor, syntheticVideo } from "../helpers/context.js";
import { Worker } from "../../apps/worker/src/worker.js";
let app: Awaited<ReturnType<typeof testApp>>,
  server: Server,
  browser: Browser,
  directory: string,
  hlsRoot: string;
const origin = "https://127.0.0.1:3024";
const results: Record<string, unknown>[] = [];
beforeAll(async () => {
  app = await testApp();
  const owner = await actor(app),
    media = await syntheticVideo(app, owner.identity);
  const job = await app.jobs.enqueue(
      "hls",
      media.id,
      `cross-origin:${media.id}`,
      {},
    ),
    worker = new Worker(app.db, app.config);
  while (
    (await app.db.query("SELECT state FROM jobs WHERE id=$1", [job.id]))[0]
      .state === "queued"
  )
    await worker.runNext();
  expect(
    (await app.db.query("SELECT state FROM jobs WHERE id=$1", [job.id]))[0]
      .state,
  ).toBe("succeeded");
  const [asset] = await app.db.query(
    "SELECT storage_key FROM assets WHERE media_id=$1 AND kind='hls'",
    [media.id],
  );
  hlsRoot = dirname(resolve(app.config.DATA_ROOT, asset.storage_key));
  directory = await mkdtemp(resolve(".local/validation/tls-"));
  const key = resolve(directory, "key.pem"),
    cert = resolve(directory, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  server = createServer(
    { key: await readFile(key), cert: await readFile(cert) },
    async (req, res) => {
      const path = new URL(req.url ?? "/", origin).pathname,
        parts = path.split("/").filter(Boolean),
        mode = parts.shift() ?? "",
        name = parts.join("/");
      if (!/^[A-Za-z0-9_./-]+$/.test(name) || name.includes("..")) {
        res.writeHead(400).end();
        return;
      }
      if (!mode.endsWith("nocors"))
        res.setHeader("Access-Control-Allow-Origin", app.config.origin);
      if (mode.endsWith("missing") && /\.(ts|m4s)$/.test(name)) {
        res.writeHead(404).end();
        return;
      }
      try {
        const bytes = await readFile(
          resolve(
            mode.startsWith("hls") ? hlsRoot : ".local/fixtures/dash",
            name,
          ),
        );
        const type = name.endsWith(".m3u8")
          ? "application/vnd.apple.mpegurl"
          : name.endsWith(".mpd")
            ? "application/dash+xml"
            : name.endsWith(".ts")
              ? "video/mp2t"
              : "video/mp4";
        res.writeHead(200, {
          "Content-Type": type,
          "Content-Length": bytes.length,
        });
        res.end(bytes);
      } catch {
        res.writeHead(404).end();
      }
    },
  );
  await new Promise<void>((done) => server.listen(3024, "127.0.0.1", done));
  await app.app.listen({ host: "127.0.0.1", port: app.config.PORT });
  browser = await chromium.launch({
    executablePath: "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
});
afterAll(async () => {
  await browser?.close();
  await app?.app.close();
  await new Promise<void>((done) => server?.close(() => done()));
  await rm(directory, { recursive: true, force: true });
  await mkdir("artifacts/providers", { recursive: true });
  await writeFile(
    "artifacts/providers/cross-origin.json",
    JSON.stringify(
      {
        status:
          results.length === 6 && results.every((r) => r.status === "PASS")
            ? "PASS"
            : "FAIL",
        controlledHttpsOrigins: 2,
        physicalDevice: false,
        productionSafeFetchStillRejectsLoopback: true,
        results,
      },
      null,
      2,
    ),
  );
});
it.each(["hls", "dash"] as const)(
  "SRC-03: %s en origen HTTPS separado reproduce con CORS y falla sin él o con segmento ausente",
  async (kind) => {
    for (const mode of ["ok", "nocors", "missing"]) {
      const owner = await actor(app),
        id = await app.library.create(owner.identity, {
          title: `[TEST] ${kind}-${mode}`,
          description: "",
        }),
        duration = kind === "hls" ? 120 : 20;
      await app.library.addSource(
        id,
        kind,
        {
          url: `${origin}/${kind}-${mode}/master.${kind === "hls" ? "m3u8" : "mpd"}`,
          domain: "127.0.0.1",
          durationSeconds: duration,
          bytes: 1,
          mimeType:
            kind === "hls"
              ? "application/vnd.apple.mpegurl"
              : "application/dash+xml",
        },
        undefined,
        "direct",
        "READY",
        undefined,
        [origin],
      );
      await app.db.query(
        "UPDATE media SET duration_seconds=$1,publication_state='PUBLISHED' WHERE id=$2",
        [duration, id],
      );
      // Only the isolated TLS fixture's certificate is accepted by these contexts.
      const context = await browser.newContext({
        baseURL: app.config.origin,
        ignoreHTTPSErrors: true,
      });
      try {
        await context.addCookies([
          {
            name: app.config.cookieName,
            value: owner.cookie.split("=")[1],
            url: app.config.origin,
            httpOnly: true,
            sameSite: "Lax",
          },
        ]);
        const page = await context.newPage();
        await page.goto(`/watch/${id}`);
        const takeover = page.getByRole("button", {
          name: "Usar este dispositivo",
          exact: true,
        });
        await browserExpect(page.locator("video").or(takeover)).toBeVisible();
        if (await takeover.isVisible()) await takeover.click();
        if (mode === "ok") {
          await browserExpect
            .poll(
              () =>
                page
                  .locator("video")
                  .evaluate((v: HTMLVideoElement) => v.readyState),
              { timeout: 20000 },
            )
            .toBeGreaterThanOrEqual(3);
          await page
            .getByRole("button", { name: "Reproducir", exact: true })
            .click();
          await browserExpect
            .poll(
              () =>
                page
                  .locator("video")
                  .evaluate((v: HTMLVideoElement) => v.currentTime),
              { timeout: 10000 },
            )
            .toBeGreaterThan(1);
        } else {
          await browserExpect(page.getByRole("alert")).toBeVisible({
            timeout: 25000,
          });
          expect(
            await page
              .locator("video")
              .evaluate((v: HTMLVideoElement) => v.currentTime),
          ).toBe(0);
        }
        expect(await page.locator("iframe").count()).toBe(0);
        results.push({
          kind,
          mode,
          status: "PASS",
          observed:
            mode === "ok"
              ? "real playback"
              : "actionable error; no video progress",
        });
      } finally {
        await context.close();
      }
    }
  },
);

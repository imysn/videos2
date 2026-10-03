import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { largeUploadFixture } from "../helpers/large-upload.js";
import { login, mutate } from "./helpers.js";
import { loadConfig } from "../../apps/api/src/infrastructure/config.js";
import { Database } from "../../packages/db/src/index.js";
import { Worker } from "../../apps/worker/src/worker.js";
import {
  checksum,
  storagePath,
} from "../../apps/api/src/modules/media/storage.js";
import {
  createTranslator,
  SUPPORTED_LOCALES,
} from "../../apps/web/src/i18n/index";

function fixtureConfig() {
  const previous = process.env.RAVE_CONFIG_FILE;
  process.env.RAVE_CONFIG_FILE = ".local/test/config.json";
  try {
    const cfg = loadConfig();
    expect(cfg.APP_ENV).toBe("test");
    return cfg;
  } finally {
    if (previous === undefined) delete process.env.RAVE_CONFIG_FILE;
    else process.env.RAVE_CONFIG_FILE = previous;
  }
}
async function start(
  page: Page,
  file: string,
  title: string,
  locale: "es" | "pl" | "en" = "es",
) {
  await page.goto("/admin/videos/new");
  await expect(page.locator("html")).toHaveAttribute("lang", locale);
  const t = createTranslator(locale);
  await expect(
    page.getByRole("heading", { name: t("admin.addVideo"), exact: true }),
  ).toBeVisible();
  await page.getByLabel(t("source.local"), { exact: true }).setInputFiles(file);
  await page.getByLabel(t("media.title"), { exact: true }).fill(title);
  await page
    .getByRole("button", { name: t("admin.createDraft"), exact: true })
    .click();
}

test("completed file stays visible as a queued draft after navigation and reload", async ({
  page,
}) => {
  await mkdir(".local/upload-work", { recursive: true });
  const file = await largeUploadFixture(
    `.local/upload-work/${randomUUID()}.mp4`,
    34 * 1024 ** 2,
  );
  try {
    await login(page);
    await page.goto("/admin/videos/new");
    await page
      .getByLabel("Archivo propio", { exact: true })
      .setInputFiles(file);
    const title = `[TEST] completed queued ${randomUUID()}`;
    await page.getByLabel("Título", { exact: true }).fill(title);
    const completed = page.waitForResponse(
      (r) => r.url().endsWith("/complete") && r.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Crear borrador", exact: true })
      .click();
    expect((await completed).status()).toBe(200);
    await expect(
      page.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Subida completada", { exact: true }),
    ).toBeVisible({ timeout: 5000 });
    await expect(
      page.getByText("En cola para procesamiento", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByText("En cola para procesamiento", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Publicar", exact: true }),
    ).toBeDisabled();
  } finally {
    await rm(file, { force: true });
  }
});

for (const locale of SUPPORTED_LOCALES) {
  test(`persistent queue, real stored progress, failure, retry and READY in ${locale}; responsive and axe`, async ({
    page,
  }) => {
    await mkdir(".local/upload-work", { recursive: true });
    const file = await largeUploadFixture(
      `.local/upload-work/${randomUUID()}.mp4`,
    );
    const cfg = fixtureConfig(),
      db = new Database(cfg.databaseUrl),
      t = createTranslator(locale);
    try {
      await login(page);
      await mutate(page, "/account", { preferences: { locale } }, "PATCH");
      const title = `[TEST] pipeline ${locale} ${randomUUID()}`;
      await start(page, file, title, locale);
      await expect(page.getByTestId("upload-preparation")).toContainText(
        t("upload.completed"),
      );
      await expect(page.getByTestId("upload-preparation")).toContainText(
        t("upload.phase.queued"),
      );
      const id = page.url().split("/").at(-1)!;
      const [job] = await db.query<{ id: string }>(
        "SELECT id FROM jobs WHERE media_id=$1 AND kind='ingest'",
        [id],
      );
      const [asset] = await db.query<{ storage_key: string; checksum: string }>(
        "SELECT storage_key,checksum FROM assets WHERE media_id=$1 AND kind='original'",
        [id],
      );
      await page.reload();
      await expect(
        page.getByRole("button", { name: t("admin.publish"), exact: true }),
      ).toBeDisabled();
      await page.goto("/admin/videos?publication=preparing");
      const card = page.locator(`[data-media-id="${id}"]`);
      await expect(card).toContainText(title);
      await expect(card).toContainText(t("upload.phase.queued"));
      await card.click();
      // Explicit fixture states exercise presentation of persisted job data.
      // The transition after Retry below uses the real FFmpeg worker.
      await db.query(
        "UPDATE jobs SET state='running',progress=0.139,attempt=1 WHERE id=$1",
        [job.id],
      );
      await expect(
        page.getByRole("progressbar", { name: t("upload.processingProgress") }),
      ).toHaveAttribute("value", "0.139");
      await page.reload();
      await expect(
        page.getByRole("progressbar", { name: t("upload.processingProgress") }),
      ).toHaveAttribute("value", "0.139");
      for (const width of [390, 768, 1440]) {
        await page.setViewportSize({ width, height: 960 });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        ).toBe(true);
        expect(
          await page
            .locator("button, nav a, label")
            .evaluateAll((elements) =>
              elements
                .filter(
                  (e) =>
                    e.getBoundingClientRect().width > 0 &&
                    getComputedStyle(e).overflowX === "hidden" &&
                    e.scrollWidth > e.clientWidth + 1,
                )
                .map((e) => e.textContent),
            ),
        ).toEqual([]);
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual(
          [],
        );
      }
      await db.query(
        "UPDATE jobs SET state='failed',safe_error_code='PROCESSING_ERROR',lease_until=NULL WHERE id=$1",
        [job.id],
      );
      await expect(page.getByTestId("upload-preparation")).toContainText(
        t("error.PROCESSING_ERROR"),
      );
      await page.reload();
      await page
        .getByTestId("upload-preparation")
        .getByRole("button", { name: t("common.retry"), exact: true })
        .click();
      await expect(page.getByTestId("upload-preparation")).toContainText(
        t("upload.phase.queued"),
      );
      await db.query(
        "UPDATE jobs SET state='cancelled',lease_until=NULL WHERE id<>$1 AND state IN ('queued','running')",
        [job.id],
      );
      expect(await new Worker(db, cfg).runNext()).toBe(true);
      await expect(page.getByTestId("upload-preparation")).toContainText(
        t("upload.phase.ready"),
        { timeout: 10000 },
      );
      await expect(
        page.getByRole("button", { name: t("admin.publish"), exact: true }),
      ).toBeEnabled();
      expect(
        await checksum(storagePath(cfg.DATA_ROOT, asset.storage_key)),
      ).toBe(asset.checksum);
      expect(
        await db.query(
          "SELECT id FROM jobs WHERE media_id=$1 AND kind='ingest'",
          [id],
        ),
      ).toHaveLength(1);
      expect(
        await db.query("SELECT id FROM media WHERE title=$1", [title]),
      ).toHaveLength(1);
    } finally {
      await db.close();
      await rm(file, { force: true });
    }
  });
}

test("lost creation and chunk acknowledgements reuse the same draft and confirmed offset", async ({
  page,
}) => {
  await login(page);
  const title = `[TEST] lost ack ${randomUUID()}`;
  let lostCreate = false,
    lostChunk = false;
  await page.route("**/api/v1/admin/uploads", async (route) => {
    if (route.request().method() !== "POST" || lostCreate)
      return route.continue();
    lostCreate = true;
    expect((await route.fetch()).status()).toBe(200);
    await route.abort("failed");
  });
  await page.route("**/api/v1/admin/uploads/*", async (route) => {
    if (route.request().method() !== "PATCH" || lostChunk)
      return route.continue();
    lostChunk = true;
    expect((await route.fetch()).status()).toBe(204);
    await route.abort("failed");
  });
  await start(page, ".local/fixtures/short.mp4", title);
  const create = page.getByRole("button", {
    name: "Crear borrador",
    exact: true,
  });
  await expect(create).toBeEnabled();
  await create.click();
  await expect(page.getByTestId("upload-preparation")).toContainText(
    "En cola para procesamiento",
  );
  const cfg = fixtureConfig(),
    db = new Database(cfg.databaseUrl);
  try {
    const rows = await db.query<{ id: string }>(
      "SELECT id FROM media WHERE title=$1",
      [title],
    );
    expect(rows).toHaveLength(1);
    expect(lostCreate && lostChunk).toBe(true);
    expect(
      await db.query(
        "SELECT id FROM jobs WHERE media_id=$1 AND kind='ingest'",
        [rows[0].id],
      ),
    ).toHaveLength(1);
    const [a] = await db.query<{ storage_key: string }>(
      "SELECT storage_key FROM assets WHERE media_id=$1 AND kind='original'",
      [rows[0].id],
    );
    expect(await checksum(storagePath(cfg.DATA_ROOT, a.storage_key))).toBe(
      await checksum(".local/fixtures/short.mp4"),
    );
  } finally {
    await db.close();
  }
});

test("lost completion response survives reload; cancellation retains the stored original", async ({
  page,
}) => {
  await login(page);
  let completed = false;
  await page.route("**/api/v1/admin/uploads/*/complete", async (route) => {
    if (completed) return route.continue();
    completed = true;
    expect((await route.fetch()).status()).toBe(200);
    await route.abort("failed");
  });
  const title = `[TEST] completion lost ${randomUUID()}`;
  await start(page, ".local/fixtures/short.mp4", title);
  await expect.poll(() => completed).toBe(true);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("upload-preparation")).toContainText(
    "En cola para procesamiento",
  );
  await page
    .getByRole("button", {
      name: createTranslator("es")("upload.cancelJob"),
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "Confirmar", exact: true }).click();
  await expect(page.getByTestId("upload-preparation")).toContainText(
    createTranslator("es")("upload.phase.cancelled"),
  );
  await page.reload();
  await expect(page.getByTestId("upload-preparation")).toContainText(
    createTranslator("es")("upload.originalKept"),
  );
  await expect(
    page.getByRole("button", { name: "Reintentar", exact: true }),
  ).toHaveCount(0);
  const cfg = fixtureConfig(),
    db = new Database(cfg.databaseUrl);
  try {
    const [a] = await db.query<{ storage_key: string }>(
      "SELECT a.storage_key FROM assets a JOIN media m ON m.id=a.media_id WHERE m.title=$1 AND a.kind='original'",
      [title],
    );
    expect(await checksum(storagePath(cfg.DATA_ROOT, a.storage_key))).toBe(
      await checksum(".local/fixtures/short.mp4"),
    );
  } finally {
    await db.close();
  }
});

test("pause and reload resume the same upload from durable bytes, without duplicate media", async ({
  page,
}) => {
  await login(page);
  let patches = 0,
    pending!: () => void,
    release!: () => void;
  const entered = new Promise<void>((done) => {
      pending = done;
    }),
    gate = new Promise<void>((done) => {
      release = done;
    });
  await page.route("**/api/v1/admin/uploads/*", async (route) => {
    if (route.request().method() !== "PATCH" || ++patches !== 2)
      return route.continue();
    pending();
    await gate;
    await route.abort("failed");
  });
  const title = `[TEST] resumed browser ${randomUUID()}`;
  try {
    await start(page, ".local/fixtures/short.mp4", title);
    await entered;
    await page
      .getByRole("button", {
        name: createTranslator("es")("upload.pause"),
        exact: true,
      })
      .click();
    release();
    await expect(
      page.getByText(createTranslator("es")("upload.paused"), { exact: true }),
    ).toBeVisible();
    await page.reload();
    const saved = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("rave-upload")!),
    );
    const record = await (
      await page.request.get(`/api/v1/admin/uploads/${saved.id}`)
    ).json();
    expect(record.offset).toBe(8388608);
    expect(record.state).toBe("uploading");
    await page.unroute("**/api/v1/admin/uploads/*");
    await page
      .getByLabel("Archivo propio", { exact: true })
      .setInputFiles(".local/fixtures/short.mp4");
    await page
      .getByRole("button", { name: "Reanudar subida", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("upload-preparation")).toContainText(
      "En cola para procesamiento",
    );
    expect(page.url()).toContain(saved.mediaId);
    const cfg = fixtureConfig(),
      db = new Database(cfg.databaseUrl);
    try {
      expect(
        await db.query("SELECT id FROM media WHERE title=$1", [title]),
      ).toHaveLength(1);
      expect(
        await db.query(
          "SELECT id FROM jobs WHERE media_id=$1 AND kind='ingest'",
          [saved.mediaId],
        ),
      ).toHaveLength(1);
    } finally {
      await db.close();
    }
  } finally {
    release();
  }
});

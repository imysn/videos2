import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { login, mutate } from "./helpers.js";
import { largeUploadFixture } from "../helpers/large-upload.js";
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
import type { Locale } from "../../apps/web/src/i18n/types";
import type { UserUpload } from "../../packages/contracts/src/upload-pipeline.js";

function fixtureConfig() {
  const saved = process.env.RAVE_CONFIG_FILE;
  process.env.RAVE_CONFIG_FILE = ".local/test/config.json";
  try {
    const cfg = loadConfig();
    expect(cfg.APP_ENV).toBe("test");
    return cfg;
  } finally {
    if (saved === undefined) delete process.env.RAVE_CONFIG_FILE;
    else process.env.RAVE_CONFIG_FILE = saved;
  }
}
async function own(page: Page, id: string) {
  const r = await page.request.get(`/api/v1/uploads/${id}`);
  expect(r.status()).toBe(200);
  return (await r.json()) as UserUpload;
}
async function begin(
  page: Page,
  file: string,
  title: string,
  locale: Locale = "es",
) {
  const t = createTranslator(locale);
  await page.goto("/upload");
  await expect(page.locator("html")).toHaveAttribute("lang", locale);
  await page.getByLabel(t("source.local"), { exact: true }).setInputFiles(file);
  await page.getByLabel(t("media.title"), { exact: true }).fill(title);
  await page
    .getByLabel(t("media.description"), { exact: true })
    .fill("[TEST] partner description");
  await page
    .getByRole("button", { name: t("uploads.upload"), exact: true })
    .click();
}
async function accessibleResponsive(page: Page) {
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
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  }
}

for (const locale of SUPPORTED_LOCALES) {
  test(`PERM-UPLOAD-16..19/23..25: two accounts, own queue/reload/processing/retry/READY, OWNER publishes; ${locale}, responsive and axe`, async ({
    browser,
  }) => {
    const ca = await browser.newContext(),
      cb = await browser.newContext();
    const a = await ca.newPage(),
      b = await cb.newPage();
    const cfg = fixtureConfig(),
      db = new Database(cfg.databaseUrl),
      t = createTranslator(locale);
    await mkdir(".local/upload-work", { recursive: true });
    const file = await largeUploadFixture(
      `.local/upload-work/${randomUUID()}.mp4`,
    );
    let u: UserUpload | undefined;
    try {
      await login(a);
      await login(b, "pareja");
      await mutate(b, "/account", { preferences: { locale } }, "PATCH");
      const ownerName = (await (await a.request.get("/api/v1/auth/me")).json())
        .displayName;
      await a.goto("/");
      await b.goto("/upload");
      await expect(
        b
          .getByRole("navigation", { name: t("nav.main"), exact: true })
          .getByRole("link", { name: t("uploads.upload"), exact: true }),
      ).toBeVisible();
      await expect(
        b.getByRole("link", { name: t("nav.admin"), exact: true }),
      ).toHaveCount(0);
      await expect(
        b.getByLabel(t("admin.httpsLink"), { exact: true }),
      ).toHaveCount(0);
      await expect(
        b.getByRole("link", { name: t("admin.addDrive"), exact: true }),
      ).toHaveCount(0);
      await accessibleResponsive(b);
      const title = `[TEST] partner browser ${locale} ${randomUUID()}`;
      await begin(b, file, title, locale);
      await expect(b).toHaveURL(/\/my-uploads\/[a-f0-9-]+$/);
      await expect(
        b.getByRole("heading", { name: title, exact: true }),
      ).toBeVisible();
      await expect(b.getByTestId("upload-preparation")).toContainText(
        t("upload.completed"),
      );
      await expect(b.getByTestId("upload-preparation")).toContainText(
        t("upload.phase.queued"),
      );
      const id = b.url().split("/").at(-1)!;
      u = await own(b, id);
      expect(u.state).toBe("completed");
      expect(u.offset).toBe(34 * 1024 ** 2);
      const partnerMe = await (await b.request.get("/api/v1/auth/me")).json();
      expect(partnerMe.role).toBe("PARTNER");
      expect(
        await b.evaluate(() =>
          Object.keys(localStorage).filter((key) =>
            key.startsWith("rave-upload"),
          ),
        ),
      ).toEqual([]);
      // OWNER kept using the normal application while the other account transferred.
      await expect(
        a.getByRole("heading", { name: "Biblioteca", exact: true }),
      ).toBeVisible();
      await a.goto("/admin/videos?publication=preparing");
      const card = a.locator(`[data-media-id="${u.mediaId}"]`);
      await expect(card).toContainText(title);
      await expect(card).toContainText(
        createTranslator("es")("uploads.uploadedBy", {
          name: partnerMe.displayName,
        }),
      );
      await card.click();
      await expect(
        a.getByRole("button", { name: "Publicar", exact: true }),
      ).toBeDisabled();
      await b.reload();
      await expect(b.getByTestId("upload-preparation")).toContainText(
        t("upload.phase.queued"),
      );
      const otherDevice = await browser.newContext();
      try {
        const c = await otherDevice.newPage();
        await login(c, "pareja");
        await mutate(c, "/account", { preferences: { locale } }, "PATCH");
        await c.goto("/my-uploads");
        await expect(c.locator(`[data-upload-id="${id}"]`)).toContainText(
          title,
        );
        await c
          .locator(`[data-upload-id="${id}"]`)
          .getByRole("link", { name: title, exact: true })
          .click();
        await expect(c.getByTestId("upload-preparation")).toContainText(
          t("upload.phase.queued"),
        );
      } finally {
        await otherDevice.close();
      }
      await db.query(
        "UPDATE jobs SET state='running',attempt=1,progress=0.37 WHERE id=$1",
        [u.preparation.job!.id],
      );
      await expect(
        b.getByRole("progressbar", { name: t("upload.processingProgress") }),
      ).toHaveAttribute("value", "0.37");
      await b.reload();
      await expect(
        b.getByRole("progressbar", { name: t("upload.processingProgress") }),
      ).toHaveAttribute("value", "0.37");
      await accessibleResponsive(b);
      await db.query(
        "UPDATE jobs SET state='failed',safe_error_code='PROCESSING_ERROR',lease_until=NULL WHERE id=$1",
        [u.preparation.job!.id],
      );
      await expect(
        b.getByRole("button", { name: t("common.retry"), exact: true }),
      ).toBeVisible();
      await expect(b.getByRole("alert")).toContainText(
        t("error.PROCESSING_ERROR"),
      );
      await b
        .getByRole("button", { name: t("common.retry"), exact: true })
        .click();
      await expect(b.getByTestId("upload-preparation")).toContainText(
        t("upload.phase.queued"),
      );
      // Only this synthetic fixture is left eligible; actual FFmpeg, not a READY stub.
      await db.query(
        "UPDATE jobs SET state='cancelled',lease_until=NULL WHERE state IN ('queued','running') AND id<>$1",
        [u.preparation.job!.id],
      );
      const [original] = await db.query<{
        storage_key: string;
        checksum: string;
      }>(
        "SELECT storage_key,checksum FROM assets WHERE media_id=$1 AND kind='original'",
        [u.mediaId],
      );
      await new Worker(db, cfg).runNext();
      await expect(
        b.getByText(t("uploads.waitingPublication"), { exact: true }),
      ).toBeVisible();
      await expect(
        b.getByText(t("uploads.ownerPublishHelp", { name: ownerName }), {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        b.getByRole("button", { name: t("admin.publish"), exact: true }),
      ).toHaveCount(0);
      expect(
        await checksum(storagePath(cfg.DATA_ROOT, original.storage_key)),
      ).toBe(original.checksum);
      await b.goto("/my-uploads");
      await expect(b.locator(`[data-upload-id="${id}"]`)).toContainText(
        t("uploads.waitingPublication"),
      );
      await accessibleResponsive(b);
      await b
        .locator(`[data-upload-id="${id}"]`)
        .getByRole("link", { name: title, exact: true })
        .click();
      await expect(
        a.getByRole("button", { name: "Publicar", exact: true }),
      ).toBeEnabled();
      await a.getByRole("button", { name: "Publicar", exact: true }).click();
      await b.reload();
      await expect(b.getByTestId("upload-preparation")).toContainText(
        t("upload.phase.published"),
      );
      for (const page of [a, b]) {
        await page.goto(`/?search=${encodeURIComponent(title)}`);
        await expect(
          page.locator(`[data-media-id="${u.mediaId}"]`),
        ).toContainText(title);
      }
      await b.goto("/admin");
      await expect(b).toHaveURL("/");
      expect(
        (await (await a.request.get(`/api/v1/media/${u.mediaId}`)).json())
          .createdBy.id,
      ).toBe(partnerMe.id);
    } finally {
      if (u) {
        await db.query(
          "UPDATE media SET publication_state='WITHDRAWN',deleted_at=now() WHERE id=$1",
          [u.mediaId],
        );
        await db.query(
          "UPDATE jobs SET state='cancelled',lease_until=NULL WHERE media_id=$1 AND state IN ('queued','running')",
          [u.mediaId],
        );
      }
      await db.close();
      await ca.close();
      await cb.close();
      await rm(file, { force: true });
    }
  });
}

test("PARTNER pauses/resumes the same transfer after reload; a cancelled own transfer stays explicit", async ({
  page,
}) => {
  const cfg = fixtureConfig(),
    db = new Database(cfg.databaseUrl),
    t = createTranslator("es");
  await mkdir(".local/upload-work", { recursive: true });
  const file = await largeUploadFixture(
    `.local/upload-work/${randomUUID()}.mp4`,
  );
  let uploadId: string | undefined;
  try {
    await login(page, "pareja");
    let chunks = 0;
    await page.route("**/api/v1/uploads/*", async (route) => {
      if (route.request().method() === "PATCH" && ++chunks === 2) {
        await new Promise((done) => setTimeout(done, 1500));
      }
      await route.continue();
    });
    const title = `[TEST] partner pause ${randomUUID()}`;
    await begin(page, file, title);
    await expect(
      page.getByText(
        t("upload.confirmed", {
          bytes: new Intl.NumberFormat("es-ES").format(8 * 1024 ** 2),
        }),
        { exact: true },
      ),
    ).toBeVisible();
    await page
      .getByRole("button", { name: t("upload.pause"), exact: true })
      .click();
    await expect(
      page.getByText(t("upload.paused"), { exact: true }),
    ).toBeVisible();
    uploadId = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((k) =>
        k.startsWith("rave-upload:"),
      );
      return JSON.parse(localStorage.getItem(key!)!).id as string;
    });
    const head = await page.request.head(`/api/v1/uploads/${uploadId}`);
    const confirmed = Number(head.headers()["upload-offset"]);
    expect(confirmed).toBeGreaterThanOrEqual(8 * 1024 ** 2);
    await page.unrouteAll({ behavior: "wait" });
    await page.reload();
    await expect(
      page.getByRole("button", { name: t("admin.resumeUpload"), exact: true }),
    ).toBeEnabled();
    await page
      .getByLabel(t("source.local"), { exact: true })
      .setInputFiles(file);
    await page
      .getByRole("button", { name: t("admin.resumeUpload"), exact: true })
      .click();
    await expect(page).toHaveURL(`/my-uploads/${uploadId}`);
    const u = await own(page, uploadId);
    expect(u.preparation.phase).toBe("queued");
    expect(
      (
        await db.query(
          "SELECT id FROM jobs WHERE media_id=$1 AND kind='ingest'",
          [u.mediaId],
        )
      ).length,
    ).toBe(1);
    await page
      .getByRole("button", { name: t("upload.cancelJob"), exact: true })
      .click();
    await page
      .getByRole("button", { name: t("common.confirm"), exact: true })
      .click();
    await expect(page.getByTestId("upload-preparation")).toContainText(
      t("upload.phase.cancelled"),
    );
    await expect(page.getByTestId("upload-preparation")).toContainText(
      t("upload.originalKept"),
    );
    await page.reload();
    await expect(page.getByTestId("upload-preparation")).toContainText(
      t("upload.phase.cancelled"),
    );
  } finally {
    await db.close();
    await rm(file, { force: true });
  }
});

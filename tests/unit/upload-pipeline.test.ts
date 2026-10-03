import { describe, expect, it } from "vitest";
import { UploadRates } from "../../apps/web/src/features/admin/upload-client";
import {
  preparationPhase,
  type IngestStatus,
  type UploadPreparation,
} from "../../packages/contracts/src/upload-pipeline";
import {
  catalogs,
  catalogIssues,
  createTranslator,
  errorText,
  SUPPORTED_LOCALES,
} from "../../apps/web/src/i18n/index";

const uploaded: UploadPreparation["upload"] = {
  id: "upload",
  state: "completed",
  offset: 776138448,
  expectedBytes: 776138448,
  name: "video.mp4",
};
const job: IngestStatus = {
  id: "ingest",
  state: "queued",
  progress: 0,
  safeErrorCode: null,
  cancelRequested: false,
  retryable: false,
};
describe("Upload and preparation are separate product phases", () => {
  it("a housekeeping-expired transfer is unavailable, never completed or ready", () => {
    expect(
      preparationPhase(
        { ...uploaded, state: "expired", offset: 8 },
        null,
        false,
        false,
      ),
    ).toBe("error");
  });
  it("100% transferred is queued, not ready or published", () => {
    expect(preparationPhase(uploaded, job, false, false)).toBe("queued");
    expect(preparationPhase(uploaded, null, false, false)).toBe("completed");
    expect(
      preparationPhase(uploaded, { ...job, state: "succeeded" }, false, false),
    ).toBe("completed");
  });
  it("running, failed, cancelled and READY retain their distinct meanings", () => {
    expect(
      preparationPhase(
        uploaded,
        { ...job, state: "running", progress: 0.139 },
        false,
        false,
      ),
    ).toBe("processing");
    expect(
      preparationPhase(uploaded, { ...job, state: "failed" }, false, false),
    ).toBe("error");
    expect(
      preparationPhase(uploaded, { ...job, state: "cancelled" }, false, false),
    ).toBe("cancelled");
    expect(
      preparationPhase(uploaded, { ...job, state: "succeeded" }, true, false),
    ).toBe("ready");
    expect(
      preparationPhase(uploaded, { ...job, state: "succeeded" }, true, true),
    ).toBe("published");
    expect(
      preparationPhase({ ...uploaded, state: "failed" }, null, false, false),
    ).toBe("error");
    expect(
      preparationPhase(
        { ...uploaded, state: "uploading", offset: 8 },
        null,
        false,
        false,
      ),
    ).toBe("uploading");
  });
  it.each(SUPPORTED_LOCALES)(
    "pipeline and safe errors are covered in %s",
    (locale) => {
      const t = createTranslator(locale);
      expect(catalogIssues(catalogs[locale])).toEqual([]);
      for (const code of [
        "UPLOAD_CORRUPT",
        "UPLOAD_INCOMPLETE",
        "UPLOAD_UNAVAILABLE",
        "UPLOAD_LIMIT",
        "INSUFFICIENT_STORAGE",
        "PROCESSING_ERROR",
        "CONTENT_GENERATION_MISMATCH",
        "JOB_CANCELLED",
        "UPLOAD_CONNECTION_LOST",
        "UPLOAD_PAUSED",
        "UPLOAD_OFFSET_INVALID",
      ])
        expect(errorText(t, { code })).not.toBe(t("error.generic"));
      expect(t("upload.processingPercent", { percent: "14%" })).toContain(
        "14%",
      );
      expect(
        t("upload.bytes", { sent: "8", total: "20", percent: "40%" }),
      ).toContain("40%");
    },
  );
});
describe("Measured transfer rate and stable ETA", () => {
  it("does not invent speed or ETA before sufficient samples", () => {
    const rates = new UploadRates(10000, 0, 0);
    expect(rates.update(0, 0)).toEqual({
      currentBytesPerSecond: null,
      averageBytesPerSecond: null,
      remainingSeconds: null,
    });
    expect(rates.update(300, 300).remainingSeconds).toBeNull();
    expect(rates.update(1000, 1000).averageBytesPerSecond).toBe(1000);
    expect(rates.update(2000, 2000).remainingSeconds).toBeNull();
  });
  it("stable samples estimate remaining time from measured bytes, excluding resumed bytes", () => {
    const rates = new UploadRates(20000, 10000, 1000);
    for (let s = 1; s <= 5; s++)
      rates.update(10000 + s * 1000, 1000 + s * 1000);
    expect(rates.update(16000, 7000)).toEqual({
      currentBytesPerSecond: 1000,
      averageBytesPerSecond: 1000,
      remainingSeconds: 4,
    });
  });
  it("suppresses an erratic/stalled estimate and survives offset recovery", () => {
    const rates = new UploadRates(100000, 0, 0);
    for (let s = 1; s <= 6; s++)
      rates.update(s % 2 ? s * 100 : s * 1000, s * 1000);
    expect(rates.update(6000, 7000).remainingSeconds).toBeNull();
    expect(rates.update(0, 8000).currentBytesPerSecond).toBeGreaterThanOrEqual(
      0,
    );
    expect(rates.update(0, 18000).remainingSeconds).toBeNull();
  });
});

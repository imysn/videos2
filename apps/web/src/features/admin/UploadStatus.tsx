import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { UploadPreparation } from "../../../../../packages/contracts/src/upload-pipeline";
import { api } from "../../app/api";
import { Confirm, Notice } from "../../components/common";
import { useI18n } from "../../i18n/provider";
import { classes } from "../../styles/classes";

export function preparationActive(preparation?: UploadPreparation | null) {
  return (
    !!preparation &&
    ["uploading", "queued", "processing"].includes(preparation.phase)
  );
}
export function PreparationSummary({
  preparation,
}: {
  preparation: UploadPreparation;
}) {
  const { t, label, number } = useI18n();
  return (
    <small>
      {preparation.phase === "processing"
        ? t("upload.processingPercent", {
            percent: number(preparation.job?.progress ?? 0, {
              style: "percent",
              maximumFractionDigits: 0,
            }),
          })
        : label("upload.phase", preparation.phase)}
    </small>
  );
}
export function PreparationStatus({
  preparation,
  mediaId,
  withdrawn,
}: {
  preparation: UploadPreparation;
  mediaId: string;
  withdrawn: boolean;
}) {
  const { t, number } = useI18n(),
    cache = useQueryClient(),
    heading = useId();
  const [error, setError] = useState<unknown>(),
    [busy, setBusy] = useState(false);
  const { upload, job, phase } = preparation;
  const active = job && ["queued", "running"].includes(job.state);
  const refresh = async () => {
    await Promise.all([
      cache.invalidateQueries({ queryKey: ["admin-media", mediaId] }),
      cache.invalidateQueries({ queryKey: ["library"] }),
      cache.invalidateQueries({ queryKey: ["jobs"] }),
    ]);
  };
  const action = async (path: string, method = "POST") => {
    setBusy(true);
    setError(undefined);
    try {
      await api(path, method);
      await refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className={classes("panel")}
      aria-labelledby={heading}
      data-testid="upload-preparation"
    >
      <h2 id={heading}>{t("upload.preparation")}</h2>
      {upload.state === "completed" && (
        <>
          <p>
            <strong>{t("upload.completed")}</strong>
          </p>
          <p>{t("upload.originalStored")}</p>
        </>
      )}
      <p>{t("upload.confirmed", { bytes: number(upload.offset) })}</p>
      <p role="status">
        <PreparationSummary preparation={preparation} />
      </p>
      {phase === "processing" && job && (
        <progress
          aria-label={t("upload.processingProgress")}
          max={1}
          value={job.progress}
        />
      )}
      {phase === "queued" && <p>{t("upload.queuedHelp")}</p>}
      {active && (
        <>
          <p>{t("upload.serverContinues")}</p>
          <p>
            {t(
              withdrawn
                ? "upload.processingWithdrawn"
                : "upload.withdrawKeepsProcessing",
            )}
          </p>
        </>
      )}
      <Notice
        error={
          preparation.safeErrorCode ? { code: preparation.safeErrorCode } : null
        }
      />
      <Notice error={error} />
      {job?.cancelRequested && active && (
        <p role="status">{t("upload.cancelling")}</p>
      )}
      <div className={classes("actions")}>
        {phase === "uploading" && (
          <Link to={`/admin/videos/new?upload=${upload.id}`}>
            {t("admin.resumeUpload")}
          </Link>
        )}
        {upload.state === "failed" && (
          <Confirm
            label={t("admin.cancelUpload")}
            title={t("admin.cancelUploadConfirm")}
            onConfirm={() => action(`/admin/uploads/${upload.id}`, "DELETE")}
          />
        )}
        {job?.retryable && (
          <button
            disabled={busy}
            onClick={() =>
              void action(`/admin/jobs/${job.id}/retry`).catch(setError)
            }
          >
            {t("common.retry")}
          </button>
        )}
        {active && !job.cancelRequested && (
          <Confirm
            label={t("upload.cancelJob")}
            title={t("upload.cancelJobConfirm")}
            onConfirm={() => action(`/admin/jobs/${job.id}/cancel`)}
          >
            {t("upload.cancelJobHelp")}
          </Confirm>
        )}
      </div>
      {phase === "error" && job && !job.retryable && (
        <p>{t("upload.notRetryable")}</p>
      )}
      {upload.state === "completed" &&
        ["error", "cancelled"].includes(phase) && (
          <p>{t("upload.originalKept")}</p>
        )}
    </section>
  );
}

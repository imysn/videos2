import type { Database } from "../../../../../packages/db/src/index.js";
import type { MediaRow } from "../library/service.js";
import { retryableJobSql } from "../../jobs/service.js";
import {
  preparationPhase,
  type UploadPreparation,
} from "../../../../../packages/contracts/src/upload-pipeline.js";

// Projection only: uploads/jobs/source health remain the sole persisted truth.
export async function preparations(db: Database, media: MediaRow[]) {
  const result = new Map<string, UploadPreparation>();
  if (!media.length) return result;
  const rows = await db.query<{
    media_id: string;
    upload_id: string;
    upload_state: UploadPreparation["upload"]["state"];
    expected_bytes: string;
    committed_offset: string;
    original_name: string;
    job_id: string | null;
    job_state: NonNullable<UploadPreparation["job"]>["state"];
    progress: number;
    safe_error_code: string | null;
    cancel_requested: boolean;
    retryable: boolean;
  }>(
    `SELECT m.id AS media_id,u.id AS upload_id,u.state AS upload_state,u.expected_bytes,u.committed_offset,u.original_name,j.id AS job_id,j.state AS job_state,j.progress,j.safe_error_code,j.cancel_requested,(${retryableJobSql}) AS retryable
      FROM media m JOIN LATERAL (SELECT * FROM uploads WHERE media_id=m.id ORDER BY expires_at DESC,id DESC LIMIT 1) u ON true
      LEFT JOIN LATERAL (SELECT * FROM jobs WHERE media_id=m.id AND kind='ingest' ORDER BY created_at DESC,id DESC LIMIT 1) j ON true
      WHERE m.id=ANY($1::uuid[]) AND m.deleted_at IS NULL`,
    [media.map((m) => m.id)],
  );
  for (const row of rows) {
    const m = media.find((m) => m.id === row.media_id)!;
    const upload = {
      id: row.upload_id,
      state: row.upload_state,
      offset: Number(row.committed_offset),
      expectedBytes: Number(row.expected_bytes),
      name: row.original_name,
    };
    const job = row.job_id
      ? {
          id: row.job_id,
          state: row.job_state,
          progress: row.progress,
          safeErrorCode: row.safe_error_code,
          cancelRequested: row.cancel_requested,
          retryable: row.retryable,
        }
      : null;
    const phase = preparationPhase(
      upload,
      job,
      m.health === "READY" && m.duration_seconds > 0,
      m.publication_state === "PUBLISHED",
    );
    result.set(m.id, {
      phase,
      upload,
      job,
      safeErrorCode:
        upload.state === "expired"
          ? "UPLOAD_UNAVAILABLE"
          : upload.state === "failed"
            ? "UPLOAD_CORRUPT"
            : phase === "error"
              ? (job?.safeErrorCode ?? "PROCESSING_ERROR")
              : null,
    });
  }
  return result;
}

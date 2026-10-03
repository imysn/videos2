export interface UploadRecord {
  id: string;
  mediaId: string;
  offset: number;
  expectedBytes: number;
  name: string;
  state: "uploading" | "completed" | "failed" | "cancelled" | "expired";
  chunkMaxBytes: number;
  title: string;
  description: string;
  category: string | null;
}
export interface IngestStatus {
  id: string;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  progress: number;
  safeErrorCode: string | null;
  cancelRequested: boolean;
  retryable: boolean;
}
export interface UploadPreparation {
  canManagePreparation?: boolean;
  phase:
    | "uploading"
    | "completed"
    | "queued"
    | "processing"
    | "ready"
    | "published"
    | "error"
    | "cancelled";
  upload: Pick<
    UploadRecord,
    "id" | "state" | "offset" | "expectedBytes" | "name"
  >;
  job: IngestStatus | null;
  safeErrorCode: string | null;
}
export interface UserUpload extends UploadRecord {
  createdAt: string;
  durationSeconds: number;
  publicationState: "DRAFT" | "PUBLISHED" | "WITHDRAWN";
  ownerDisplayName: string;
  preparation: UploadPreparation;
}
export function preparationPhase(
  upload: UploadPreparation["upload"],
  job: IngestStatus | null,
  ready: boolean,
  published: boolean,
): UploadPreparation["phase"] {
  if (upload.state === "failed" || upload.state === "expired") return "error";
  if (upload.state === "cancelled") return "cancelled";
  if (upload.state === "uploading") return "uploading";
  if (job?.state === "queued") return "queued";
  if (job?.state === "running") return "processing";
  if (ready) return published ? "published" : "ready";
  if (job?.state === "failed") return "error";
  if (job?.state === "cancelled") return "cancelled";
  return "completed";
}

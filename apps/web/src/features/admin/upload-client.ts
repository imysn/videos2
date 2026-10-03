import type { UploadRecord } from "../../../../../packages/contracts/src/upload-pipeline";
import { api, ApiError, csrfToken } from "../../app/api";

export interface TransferStatus {
  phase: "sending" | "finalizing" | "paused";
  sentBytes: number;
  confirmedBytes: number;
  currentBytesPerSecond: number | null;
  averageBytesPerSecond: number | null;
  remainingSeconds: number | null;
}
export class UploadRates {
  private samples: { time: number; bytes: number }[];
  constructor(
    private total: number,
    private initial: number,
    private started: number,
  ) {
    this.samples = [{ time: started, bytes: initial }];
  }
  update(bytes: number, now: number) {
    const previous = this.samples.at(-1)!;
    if (now - previous.time >= 500) this.samples.push({ time: now, bytes });
    while (this.samples.length > 2 && this.samples[1].time < now - 8000)
      this.samples.shift();
    const elapsed = (now - this.started) / 1000,
      first = this.samples[0];
    const span = (now - first.time) / 1000;
    const average =
      elapsed >= 1 ? Math.max(0, (bytes - this.initial) / elapsed) : null;
    const current =
      span >= 1 && this.samples.length >= 2
        ? Math.max(0, (bytes - first.bytes) / span)
        : null;
    const rates = this.samples
      .slice(1)
      .map((sample, index) =>
        Math.max(
          0,
          (sample.bytes - this.samples[index].bytes) /
            ((sample.time - this.samples[index].time) / 1000),
        ),
      );
    const mean =
      rates.reduce((sum, n) => sum + n, 0) / Math.max(1, rates.length);
    const variation =
      mean > 0
        ? Math.sqrt(
            rates.reduce((sum, n) => sum + (n - mean) ** 2, 0) /
              Math.max(1, rates.length),
          ) / mean
        : Infinity;
    const stable =
      elapsed >= 5 &&
      rates.length >= 3 &&
      variation <= 0.6 &&
      current &&
      average &&
      current / average >= 0.6 &&
      current / average <= 1.6;
    return {
      currentBytesPerSecond: current,
      averageBytesPerSecond: average,
      remainingSeconds: stable
        ? Math.max(0, (this.total - bytes) / current)
        : null,
    };
  }
}
function sendChunk(
  id: string,
  offset: number,
  chunk: Blob,
  signal: AbortSignal,
  progress: (sent: number) => void,
) {
  return new Promise<number>((done, fail) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const cleanup = () => signal.removeEventListener("abort", abort);
    xhr.open("PATCH", `/api/v1/admin/uploads/${id}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("x-csrf-token", csrfToken());
    xhr.setRequestHeader("Upload-Offset", String(offset));
    xhr.upload.onprogress = (event) =>
      progress(offset + Math.min(chunk.size, event.loaded));
    xhr.onload = () => {
      cleanup();
      if (xhr.status !== 204) {
        let code = "INTERNAL_ERROR";
        try {
          code = JSON.parse(xhr.responseText).code ?? code;
        } catch {
          /* Non-JSON proxy error. */
        }
        fail(new ApiError(code));
        return;
      }
      const next = Number(xhr.getResponseHeader("Upload-Offset"));
      if (!Number.isSafeInteger(next) || next !== offset + chunk.size)
        fail(new ApiError("UPLOAD_OFFSET_INVALID"));
      else done(next);
    };
    xhr.onerror = () => {
      cleanup();
      fail(new ApiError("UPLOAD_CONNECTION_LOST"));
    };
    xhr.onabort = () => {
      cleanup();
      fail(new ApiError("UPLOAD_PAUSED"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      cleanup();
      fail(new ApiError("UPLOAD_PAUSED"));
      return;
    }
    xhr.send(chunk);
  });
}
export async function uploadFileChunks(
  upload: Pick<UploadRecord, "id">,
  file: File,
  signal: AbortSignal,
  onStatus: (status: TransferStatus) => void,
) {
  let remote = await api<UploadRecord>(`/admin/uploads/${upload.id}`);
  if (remote.expectedBytes !== file.size)
    throw new ApiError("UPLOAD_SIZE_MISMATCH");
  let offset = remote.offset;
  const validateOffset = () => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > file.size)
      throw new ApiError("UPLOAD_OFFSET_INVALID");
  };
  validateOffset();
  const rates = new UploadRates(file.size, offset, performance.now());
  const update = (sent: number, phase: TransferStatus["phase"] = "sending") =>
    onStatus({
      phase,
      sentBytes: sent,
      confirmedBytes: offset,
      ...rates.update(sent, performance.now()),
    });
  update(offset);
  const paused = () => {
    update(offset, "paused");
    throw new ApiError("UPLOAD_PAUSED");
  };
  let retries = 0;
  while (offset < file.size && remote.state !== "completed") {
    if (signal.aborted) paused();
    if (remote.state !== "uploading") throw new ApiError("UPLOAD_UNAVAILABLE");
    const maximum = Math.min(8 * 1024 ** 2, remote.chunkMaxBytes);
    if (
      !Number.isSafeInteger(maximum) ||
      maximum < 1 ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > file.size
    )
      throw new ApiError("UPLOAD_OFFSET_INVALID");
    try {
      offset = await sendChunk(
        upload.id,
        offset,
        file.slice(offset, Math.min(file.size, offset + maximum)),
        signal,
        (sent) => update(sent),
      );
      retries = 0;
      update(offset);
    } catch (error) {
      if (error instanceof ApiError && error.code === "UPLOAD_PAUSED") paused();
      if (
        !(error instanceof ApiError) ||
        !["UPLOAD_CONNECTION_LOST", "UPLOAD_OFFSET_MISMATCH"].includes(
          error.code,
        ) ||
        retries >= 2
      )
        throw error;
      retries++;
      await new Promise((done) => setTimeout(done, 500 * retries));
      if (signal.aborted) paused();
      remote = await api<UploadRecord>(`/admin/uploads/${upload.id}`);
      offset = remote.offset;
      validateOffset();
      update(offset);
    }
  }
  if (signal.aborted) paused();
  update(file.size, "finalizing");
  try {
    return await api<{ mediaId: string; jobId: string }>(
      `/admin/uploads/${upload.id}/complete`,
      "POST",
    );
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("UPLOAD_CONNECTION_LOST");
  }
}

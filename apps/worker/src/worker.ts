import { randomUUID } from "node:crypto";
import { resolve, relative } from "node:path";
import {
  mkdir,
  writeFile,
  rename,
  rm,
  stat,
  readFile,
  readdir,
} from "node:fs/promises";
import type { Database } from "../../../packages/db/src/index.js";
import type { Config } from "../../api/src/infrastructure/config.js";
import { Jobs, type Job } from "../../api/src/jobs/service.js";
import {
  LibraryService,
  baseCapabilities,
  type LocalReference,
} from "../../api/src/modules/library/service.js";
import {
  checksum,
  storagePath,
  preparePath,
} from "../../api/src/modules/media/storage.js";
import { reserveSpace } from "../../api/src/modules/media/uploads.js";
import {
  parseSubtitles,
  toVtt,
} from "../../api/src/modules/media/subtitles.js";
import { prepareVideo, prepareHls } from "./media/process.js";
import { assert, AppError } from "../../api/src/infrastructure/errors.js";
export class Worker {
  readonly id = randomUUID();
  readonly jobs: Jobs;
  readonly library: LibraryService;
  stopping = false;
  constructor(
    public db: Database,
    public config: Config,
  ) {
    this.jobs = new Jobs(db);
    this.library = new LibraryService(db, config);
  }
  async asset(
    mediaId: string,
    kind: string,
    key: string,
    mime: string,
    meta: Record<string, unknown> = {},
  ) {
    const p = storagePath(this.config.DATA_ROOT, key),
      s = await stat(p),
      id = randomUUID();
    const [row] = await this.db.query<{ id: string }>(
      "INSERT INTO assets(id,media_id,kind,storage_key,mime_type,bytes,checksum,metadata_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(storage_key) DO UPDATE SET state='READY',bytes=excluded.bytes,checksum=excluded.checksum,metadata_json=excluded.metadata_json RETURNING id",
      [id, mediaId, kind, key, mime, s.size, await checksum(p), meta],
    );
    return row.id;
  }
  async runNext() {
    const maintenance = await this.db.query(
      "SELECT 1 FROM settings WHERE key='maintenance' AND value_json='true'::jsonb",
    );
    if (maintenance.length) return false;
    const job = await this.jobs.claim(this.id);
    if (!job) return false;
    const controller = new AbortController();
    const folder = await preparePath(
      this.config.DATA_ROOT,
      `temp/${job.id}/${job.attempt}-${this.id}/marker`,
    );
    const out = resolve(folder, "..");
    const heartbeat = setInterval(() => {
      void this.db
        .query<{ cancel_requested: boolean }>(
          "UPDATE jobs SET lease_until=now()+interval '30 seconds' WHERE id=$1 AND lease_owner=$2 AND attempt=$3 AND state='running' RETURNING cancel_requested",
          [job.id, this.id, job.attempt],
        )
        .then((rows) => {
          if (!rows.length || rows[0].cancel_requested || this.stopping)
            controller.abort();
        })
        .catch(() => controller.abort());
    }, 1000);
    const progress = (n: number) => {
      if (!Number.isFinite(n)) return;
      void this.db
        .query(
          "UPDATE jobs SET progress=$1 WHERE id=$2 AND lease_owner=$3 AND attempt=$4 AND state='running'",
          [Math.max(0, Math.min(0.99, n)), job.id, this.id, job.attempt],
        )
        .catch(() => controller.abort());
    };
    try {
      if (job.cancel_requested) throw new AppError("JOB_CANCELLED");
      await mkdir(out, { recursive: true, mode: 0o700 });
      if (job.kind === "ingest")
        await this.ingest(job, out, controller.signal, progress);
      else if (job.kind === "prepare-copy")
        await this.prepareCopy(job, out, controller.signal, progress);
      else if (job.kind === "hls")
        await this.hls(job, out, controller.signal, progress);
      else if (job.kind === "delete-media") await this.removeMedia(job);
      else if (job.kind === "housekeeping") await this.housekeeping();
      else throw new AppError("UNSUPPORTED_JOB");
      await this.db.query(
        "UPDATE jobs SET state='succeeded',progress=1,lease_until=NULL WHERE id=$1 AND lease_owner=$2 AND attempt=$3",
        [job.id, this.id, job.attempt],
      );
    } catch (e) {
      const code =
        e instanceof AppError
          ? e.code
          : controller.signal.aborted
            ? "JOB_CANCELLED"
            : (e as NodeJS.ErrnoException).code === "ENOSPC"
              ? "INSUFFICIENT_STORAGE"
              : "PROCESSING_ERROR";
      const state = code === "JOB_CANCELLED" ? "cancelled" : "failed";
      await this.db.query(
        "UPDATE jobs SET state=$1,safe_error_code=$2,lease_until=NULL WHERE id=$3 AND lease_owner=$4 AND attempt=$5",
        [state, code, job.id, this.id, job.attempt],
      );
      if (job.media_id && job.kind === "ingest")
        await this.db.query(
          "UPDATE sources SET health='ERROR',safe_error_code=$1 WHERE media_id=$2 AND kind='local' AND health='PREPARING' AND EXISTS(SELECT 1 FROM jobs WHERE id=$3 AND lease_owner=$4)",
          [code, job.media_id, job.id, this.id],
        );
    } finally {
      clearInterval(heartbeat);
      await rm(out, { recursive: true, force: true });
    }
    return true;
  }
  async publish(
    job: Job,
    signal: AbortSignal,
    operation: () => Promise<void>,
    complete = true,
  ) {
    await this.db.transaction(async (client) => {
      const [current] = await this.db.query<Job>(
        "SELECT * FROM jobs WHERE id=$1 FOR UPDATE",
        [job.id],
        client,
      );
      assert(
        current?.state === "running" &&
          current.lease_owner === this.id &&
          current.attempt === job.attempt &&
          current.lease_until !== null &&
          new Date(current.lease_until).getTime() > Date.now() &&
          !current.cancel_requested &&
          !signal.aborted,
        "JOB_CANCELLED",
      );
      if (
        job.media_id &&
        ["ingest", "prepare-copy", "hls"].includes(job.kind)
      ) {
        const [media] = await this.db.query<{ content_generation: string }>(
          "SELECT content_generation FROM media WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
          [job.media_id],
          client,
        );
        assert(
          media &&
            media.content_generation === job.payload_json.contentGeneration,
          "CONTENT_GENERATION_MISMATCH",
        );
      }
      await operation();
      // Publication and success commit together; a crash cannot enqueue it twice.
      if (complete)
        await client.query(
          "UPDATE jobs SET state='succeeded',progress=1,lease_until=NULL WHERE id=$1",
          [job.id],
        );
    });
  }
  async ingest(
    job: Job,
    out: string,
    signal: AbortSignal,
    progress: (n: number) => void,
  ) {
    assert(job.media_id, "INVALID_JOB");
    const [asset] = await this.db.query<{ storage_key: string; bytes: string }>(
      "SELECT storage_key,bytes FROM assets WHERE id=$1 AND media_id=$2 AND kind='original'",
      [job.payload_json.assetId, job.media_id],
    );
    assert(asset, "INVALID_JOB");
    await reserveSpace(this.config.DATA_ROOT, Number(asset.bytes) * 2);
    const result = await prepareVideo(
      storagePath(this.config.DATA_ROOT, asset.storage_key),
      out,
      this.config.FFMPEG_THREADS,
      signal,
      progress,
    );
    await this.publish(job, signal, async () => {
      const key = `derived/${job.media_id}/${job.id}`,
        target = await preparePath(this.config.DATA_ROOT, `${key}/marker`);
      await rm(resolve(target, ".."), { recursive: true, force: true });
      await rename(out, resolve(target, ".."));
      const compatible = await this.asset(
        job.media_id!,
        "compatible",
        `${key}/compatible.mp4`,
        "video/mp4",
        { probe: result.info },
      );
      const poster = await this.asset(
        job.media_id!,
        "poster",
        `${key}/poster.jpg`,
        "image/jpeg",
      );
      const sprite = await this.asset(
        job.media_id!,
        "sprite",
        `${key}/sprite.jpg`,
        "image/jpeg",
        {
          columns: result.columns,
          interval: result.interval,
          count: result.count,
          width: 160,
          height: 90,
        },
      );
      for (const sub of result.subtitles) {
        const subKey = `${key}/${relative(out, sub.path)}`;
        const file = storagePath(this.config.DATA_ROOT, subKey);
        const cues = parseSubtitles(await readFile(file, "utf8"));
        await writeFile(file, toVtt(cues));
        const id = await this.asset(
          job.media_id!,
          "subtitle",
          subKey,
          "text/vtt",
        );
        await this.db.query(
          "INSERT INTO subtitles(id,media_id,asset_id,language_tag,label) SELECT $1,$2,$3,$4,$5 WHERE NOT EXISTS(SELECT 1 FROM subtitles WHERE asset_id=$3)",
          [randomUUID(), job.media_id, id, sub.language, sub.label],
        );
      }
      await this.db.transaction(async (c) => {
        await this.db.query(
          "UPDATE media SET duration_seconds=$1,poster_asset_id=coalesce(poster_asset_id,$2),updated_at=now() WHERE id=$3",
          [result.duration, poster, job.media_id],
          c,
        );
        await this.library.addSource(
          job.media_id!,
          "local",
          { assetId: compatible },
          {
            ...baseCapabilities,
            subtitles: !!result.subtitles.length,
            thumbnails: !!sprite,
          },
          "relay",
          "READY",
          null,
          [],
          c,
        );
        for (const [n, ch] of (result.info.chapters ?? []).entries())
          await c.query(
            "INSERT INTO chapters(id,media_id,start_seconds,title,sort_order) VALUES($1,$2,$3,$4,$5) ON CONFLICT(media_id,sort_order) DO NOTHING",
            [
              randomUUID(),
              job.media_id,
              Number(ch.start_time),
              ch.tags?.title ?? `Capítulo ${n + 1}`,
              n,
            ],
          );
      });
    });
  }
  async hls(
    job: Job,
    out: string,
    signal: AbortSignal,
    progress: (n: number) => void,
  ) {
    assert(job.media_id, "INVALID_JOB");
    const [m] = await this.db.query<{ primary_source_id: string }>(
      "SELECT primary_source_id FROM media WHERE id=$1",
      [job.media_id],
    );
    const source = await this.library.source(m.primary_source_id);
    assert(source.kind === "local", "LOCAL_SOURCE_REQUIRED");
    const ref = this.library.reference<LocalReference>(source);
    const [file] = await this.db.query<{ storage_key: string; bytes: string }>(
      "SELECT storage_key,bytes FROM assets WHERE id=$1",
      [ref.assetId],
    );
    await reserveSpace(this.config.DATA_ROOT, Number(file.bytes) * 3);
    const result = await prepareHls(
      storagePath(this.config.DATA_ROOT, file.storage_key),
      out,
      this.config.FFMPEG_THREADS,
      signal,
      progress,
    );
    await writeFile(resolve(out, "master.m3u8"), result.master);
    result.files["master.m3u8"] = Buffer.byteLength(result.master);
    await this.publish(job, signal, async () => {
      const key = `derived/${job.media_id}/${job.id}/hls`,
        target = await preparePath(this.config.DATA_ROOT, `${key}/marker`);
      await rm(resolve(target, ".."), { recursive: true, force: true });
      await rename(out, resolve(target, ".."));
      const hlsId = await this.asset(
        job.media_id!,
        "hls",
        `${key}/master.m3u8`,
        "application/vnd.apple.mpegurl",
        { files: result.files },
      );
      const { seal } = await import("../../api/src/infrastructure/secrets.js");
      await this.db.query(
        "UPDATE sources SET encrypted_reference=$1,capabilities_json=capabilities_json || $2::jsonb WHERE id=$3",
        [
          seal(
            { ...ref, hlsAssetId: hlsId },
            this.config.masterKey,
            "source",
            source.id,
          ),
          JSON.stringify({ qualitySelection: true }),
          source.id,
        ],
      );
    });
  }
  async prepareCopy(
    job: Job,
    out: string,
    signal: AbortSignal,
    progress: (n: number) => void,
  ) {
    assert(
      job.media_id && typeof job.payload_json.sourceId === "string",
      "INVALID_JOB",
    );
    if (typeof job.payload_json.assetId === "string") {
      await this.ingest(job, out, signal, progress);
      return;
    }
    const source = await this.library.source(job.payload_json.sourceId),
      ref = this.library.reference<{
        url?: string;
        fileId?: string;
        bytes: number;
        version?: string;
      }>(source);
    assert(
      Number.isSafeInteger(ref.bytes) &&
        ref.bytes > 0 &&
        ref.bytes <= this.config.MAX_UPLOAD_BYTES,
      "COPY_TOO_LARGE",
    );
    await reserveSpace(this.config.DATA_ROOT, ref.bytes * 3);
    let body: import("node:stream").Readable;
    if (source.kind === "drive") {
      const { Drive } = await import("../../api/src/modules/drive/service.js"),
        { Streams } = await import("../../api/src/modules/media/streams.js"),
        { AuthService } = await import("../../api/src/modules/auth/service.js");
      const drive = new Drive(
        this.db,
        this.config,
        this.library,
        new Streams(new AuthService(this.db, this.config)),
      );
      const { gateway } = await drive.gateway();
      const file = await drive.metadata(gateway, ref.fileId!);
      assert(
        (file.version ?? file.modifiedTime ?? "") === ref.version,
        "CONTENT_IDENTITY_MISMATCH",
      );
      body = (
        await drive.bounded(() => gateway.bytes(ref.fileId!, undefined, signal))
      ).body;
    } else {
      assert(source.kind === "http_file" && ref.url, "FILE_SOURCE_REQUIRED");
      const { SafeFetch } =
        await import("../../api/src/infrastructure/safe-fetch/index.js");
      const response = await new SafeFetch().request(ref.url, { signal });
      assert(response.status === 200, "SOURCE_UNAVAILABLE");
      assert(
        !source.content_fingerprint ||
          response.headers.etag === source.content_fingerprint,
        "CONTENT_IDENTITY_MISMATCH",
      );
      body = response.body;
    }
    const { createWriteStream } = await import("node:fs"),
      { pipeline } = await import("node:stream/promises"),
      { Transform } = await import("node:stream");
    // A lost lease may finish its download later. It must never write or unlink
    // the replacement attempt's durable original.
    const key = `originals/${job.media_id}/${job.id}-${job.attempt}-${this.id}.bin`,
      file = resolve(out, "download.bin");
    let bytes = 0;
    const bound = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        bytes += chunk.length;
        if (bytes > ref.bytes) callback(new AppError("COPY_SIZE_MISMATCH"));
        else {
          progress((bytes / ref.bytes) * 0.2);
          callback(null, chunk);
        }
      },
    });
    try {
      await pipeline(
        body,
        bound,
        createWriteStream(file, { mode: 0o600, flags: "wx" }),
        { signal },
      );
      assert(bytes === ref.bytes, "COPY_SIZE_MISMATCH");
    } catch (error) {
      body.destroy();
      await rm(file, { force: true });
      throw error;
    }
    let id!: string;
    await this.publish(
      job,
      signal,
      async () => {
        await rename(file, await preparePath(this.config.DATA_ROOT, key));
        id = await this.asset(
          job.media_id!,
          "original",
          key,
          "application/octet-stream",
        );
        // Keep the durable asset reference for safe recovery after download.
        await this.db.query(
          "UPDATE jobs SET payload_json=payload_json || $1::jsonb WHERE id=$2",
          [JSON.stringify({ assetId: id }), job.id],
        );
      },
      false,
    );
    await this.ingest(
      { ...job, payload_json: { ...job.payload_json, assetId: id } },
      out,
      signal,
      (n) => progress(0.2 + n * 0.8),
    );
  }
  async removeMedia(job: Job) {
    assert(job.media_id, "INVALID_JOB");
    const files = await this.db.query<{
      id: string;
      storage_key: string;
      metadata_json: { files?: Record<string, number> };
    }>("SELECT id,storage_key,metadata_json FROM assets WHERE media_id=$1", [
      job.media_id,
    ]);
    for (const file of files) {
      if (file.metadata_json.files)
        for (const name of Object.keys(file.metadata_json.files)) {
          const { dirname } = await import("node:path");
          await rm(
            storagePath(
              this.config.DATA_ROOT,
              dirname(file.storage_key) + "/" + name,
            ),
            { force: true },
          );
        }
      else
        await rm(storagePath(this.config.DATA_ROOT, file.storage_key), {
          force: true,
        });
    }
    await this.db.transaction(async (c) => {
      await c.query("UPDATE media SET poster_asset_id=NULL WHERE id=$1", [
        job.media_id,
      ]);
      await c.query("DELETE FROM subtitles WHERE media_id=$1", [job.media_id]);
      await c.query("DELETE FROM chapters WHERE media_id=$1", [job.media_id]);
      await c.query("DELETE FROM assets WHERE media_id=$1", [job.media_id]);
    });
  }
  async housekeeping() {
    const [retention] = await this.db.query<{ value_json: number }>(
      "SELECT value_json FROM settings WHERE key='chatRetentionDays'",
    );
    await this.db.query(
      "DELETE FROM chat_messages WHERE created_at<now()-($1*interval '1 day')",
      [retention?.value_json ?? this.config.CHAT_RETENTION_DAYS],
    );
    await this.db.query(
      "DELETE FROM command_receipts WHERE created_at<now()-interval '24 hours'",
    );
    await this.db.query(
      "DELETE FROM http_receipts WHERE created_at<now()-interval '24 hours'",
    );
    await this.db.query(
      "DELETE FROM audit_events WHERE created_at<now()-($1*interval '1 day')",
      [this.config.AUDIT_RETENTION_DAYS],
    );
    const uploads = await this.db.query<{ id: string; temporary_key: string }>(
      "UPDATE uploads SET state='expired' WHERE state='uploading' AND expires_at<now() RETURNING id,temporary_key",
    );
    for (const u of uploads)
      await rm(storagePath(this.config.DATA_ROOT, u.temporary_key), {
        force: true,
      });
    const logs = resolve(".local/logs");
    try {
      for (const name of await readdir(logs)) {
        if (!/^(api|worker)-\d+\.log$/.test(name)) continue;
        const f = resolve(logs, name);
        if (
          Date.now() - (await stat(f)).mtimeMs >
          this.config.LOG_RETENTION_DAYS * 86400000
        )
          await rm(f);
      }
    } catch {
      /* No logs created yet. */
    }
  }
}

import { signedExpiry } from "../sources/duration.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import sharp from "sharp";
import {
  uuid,
  metadataSchema,
  chaptersSchema,
  position,
} from "../../../../../packages/contracts/src/index.js";
import type { Identity } from "../auth/service.js";
import { Http } from "../../infrastructure/http.js";
import { assert, AppError } from "../../infrastructure/errors.js";
import { Limiter } from "../../infrastructure/limits.js";
import { Jobs } from "../../jobs/service.js";
import { preparations } from "../media/preparation.js";
import {
  LibraryService,
  type LocalReference,
  type UrlReference,
} from "./service.js";
import { UrlAdapter, type Inspection } from "../sources/service.js";
import { Streams } from "../media/streams.js";
import { preparePath, checksum } from "../media/storage.js";
import { parseSubtitles, toVtt } from "../media/subtitles.js";
import { seal } from "../../infrastructure/secrets.js";
export function libraryRoutes(
  h: Http,
  library: LibraryService,
  jobs: Jobs,
  urls: UrlAdapter,
  streams: Streams,
  driveResolve: (m: string, i: Identity) => Promise<unknown>,
  driveStream: (
    s: string,
    i: Identity,
    r: Parameters<Streams["asset"]>[2],
    p: Parameters<Streams["asset"]>[3],
  ) => Promise<unknown>,
) {
  const db = library.db,
    empty = z.strictObject({}),
    id = (r: { params: unknown }) =>
      uuid.parse((r.params as { id: string }).id),
    limits = new Limiter();
  const list = z.strictObject({
    publication: z.enum(["all", "preparing", "published"]).optional(),
    search: z.string().max(200).optional(),
    category: z.string().max(80).optional(),
    pending: z
      .enum(["true", "false"])
      .transform((x) => x === "true")
      .optional(),
    sort: z.enum(["recent", "title"]).optional(),
    cursor: z.string().max(1000).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  });
  h.route("GET", "/api/v1/library", list, "user", async (b, i) =>
    library.list(i, b),
  );
  h.route("GET", "/api/v1/admin/videos", list, "owner", async (b, i) =>
    library.list(i, b, true),
  );
  h.route("GET", "/api/v1/media/:id", empty, "user", async (_b, i, r) => {
    const m = await library.get(id(r), i);
    const subtitles = await db.query<{
      id: string;
      asset_id: string;
      label: string;
      language_tag: string;
    }>(
      "SELECT id,asset_id,label,language_tag FROM subtitles WHERE media_id=$1",
      [m.id],
    );
    const chapters = await db.query<{ start_seconds: number; title: string }>(
      "SELECT start_seconds,title FROM chapters WHERE media_id=$1 ORDER BY sort_order",
      [m.id],
    );
    const [sprite] = await db.query<{
      id: string;
      metadata_json: Record<string, unknown>;
    }>(
      "SELECT id,metadata_json FROM assets WHERE media_id=$1 AND kind='sprite' LIMIT 1",
      [m.id],
    );
    return {
      ...library.view(m),
      ...(i.user.role === "OWNER"
        ? { preparation: (await preparations(db, [m])).get(m.id) ?? null }
        : {}),
      subtitles: subtitles.map((s) => ({
        id: s.id,
        url: `/media/assets/${s.asset_id}`,
        label: s.label,
        language: s.language_tag,
      })),
      chapters: chapters.map((c) => ({
        startSeconds: c.start_seconds,
        title: c.title,
      })),
      sprite: sprite
        ? { url: `/media/assets/${sprite.id}`, ...sprite.metadata_json }
        : null,
    };
  });
  h.route(
    "POST",
    "/api/v1/admin/videos",
    metadataSchema,
    "owner",
    async (b, i) => ({ id: await library.create(i, b) }),
  );
  h.route(
    "PATCH",
    "/api/v1/admin/videos/:id",
    metadataSchema
      .partial()
      .extend({ posterAssetId: uuid.nullable().optional() }),
    "owner",
    async (b, i, r) => {
      const m = await library.get(id(r), i);
      let cat = m.category_id;
      if (b.category !== undefined) {
        if (b.category) {
          const [v] = await db.query<{ id: string }>(
            "INSERT INTO categories(id,name,normalized_name) VALUES($1,$2,$3) ON CONFLICT(normalized_name) DO UPDATE SET name=excluded.name RETURNING id",
            [randomUUID(), b.category, b.category.toLowerCase()],
          );
          cat = v.id;
        } else cat = null;
      }
      if (b.posterAssetId)
        assert(
          (
            await db.query(
              "SELECT 1 FROM assets WHERE id=$1 AND media_id=$2 AND kind='poster'",
              [b.posterAssetId, m.id],
            )
          ).length,
          "INVALID_ASSET",
          400,
        );
      await db.query(
        "UPDATE media SET title=coalesce($1,title),description=coalesce($2,description),category_id=$3,poster_asset_id=CASE WHEN $4 THEN $5::uuid ELSE poster_asset_id END,updated_at=now() WHERE id=$6",
        [
          b.title ?? null,
          b.description ?? null,
          cat,
          b.posterAssetId !== undefined,
          b.posterAssetId ?? null,
          m.id,
        ],
      );
      return library.view(await library.get(m.id, i));
    },
  );
  h.route(
    "POST",
    "/api/v1/admin/videos/:id/publish",
    empty,
    "owner",
    async (_b, i, r) => {
      const m = await library.get(id(r), i);
      assert(
        m.primary_source_id && m.duration_seconds > 0,
        "MEDIA_NOT_READY",
        409,
      );
      const s = await library.source(m.primary_source_id);
      assert(
        s.media_id === m.id && s.health === "READY",
        "MEDIA_NOT_READY",
        409,
      );
      await db.query(
        "UPDATE media SET publication_state='PUBLISHED',updated_at=now() WHERE id=$1",
        [m.id],
      );
      return { ok: true };
    },
  );
  h.route(
    "POST",
    "/api/v1/admin/videos/:id/withdraw",
    empty,
    "owner",
    async (_b, i, r) => {
      const m = await library.get(id(r), i);
      await db.query(
        "UPDATE media SET publication_state='WITHDRAWN',updated_at=now() WHERE id=$1",
        [m.id],
      );
      await library.onUnavailable(m.id);
      return { ok: true };
    },
  );
  h.route(
    "DELETE",
    "/api/v1/admin/videos/:id",
    empty,
    "owner-recent",
    async (_b, i, r) => {
      const m = await library.get(id(r), i);
      await db.query(
        "UPDATE media SET publication_state='WITHDRAWN',deleted_at=now(),updated_at=now() WHERE id=$1",
        [m.id],
      );
      await library.onUnavailable(m.id);
      await db.query(
        "UPDATE jobs SET cancel_requested=true,state=CASE WHEN state='queued' THEN 'cancelled' ELSE state END,safe_error_code=CASE WHEN state='queued' THEN 'JOB_CANCELLED' ELSE safe_error_code END WHERE media_id=$1 AND kind IN ('ingest','prepare-copy','hls') AND state IN ('queued','running')",
        [m.id],
      );
      await jobs.enqueue("delete-media", m.id, `delete:${m.id}`, {});
      return { ok: true };
    },
  );
  h.route(
    "PUT",
    "/api/v1/watchlist/:mediaId",
    z.strictObject({ watched: z.boolean().default(false) }),
    "user",
    async (b, i, r) => {
      const mediaId = uuid.parse((r.params as { mediaId: string }).mediaId);
      await library.get(mediaId, i);
      await db.query(
        "INSERT INTO watchlist(media_id,added_by,marked_watched_at) VALUES($1,$2,CASE WHEN $3 THEN now() ELSE NULL END) ON CONFLICT(media_id) DO UPDATE SET marked_watched_at=excluded.marked_watched_at",
        [mediaId, i.user.id, b.watched],
      );
      return { ok: true };
    },
  );
  h.route(
    "DELETE",
    "/api/v1/watchlist/:mediaId",
    empty,
    "user",
    async (_b, i, r) => {
      const mediaId = uuid.parse((r.params as { mediaId: string }).mediaId);
      await library.get(mediaId, i);
      await db.query("DELETE FROM watchlist WHERE media_id=$1", [mediaId]);
      return { ok: true };
    },
  );
  h.route(
    "POST",
    "/api/v1/playback/:mediaId/resolve",
    empty,
    "user",
    async (_b, i, r) => {
      const mediaId = uuid.parse((r.params as { mediaId: string }).mediaId),
        m = await library.get(mediaId, i);
      assert(
        m.primary_source_id && m.duration_seconds > 0,
        "MEDIA_UNAVAILABLE",
        409,
      );
      const s = await library.source(m.primary_source_id);
      assert(s.health === "READY", "MEDIA_UNAVAILABLE", 409);
      return s.kind === "local"
        ? library.localDescriptor(m, s)
        : s.kind === "drive"
          ? driveResolve(mediaId, i)
          : urls.resolvePlayback(m, s);
    },
  );
  h.route(
    "POST",
    "/api/v1/solo-sessions",
    z.strictObject({
      mediaId: uuid,
      clientInstanceId: uuid,
      takeover: z.boolean().default(false),
    }),
    "user",
    async (b, i) => {
      const m = await library.published(b.mediaId);
      return db.transaction(async (c) => {
        await c.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
          i.user.id,
        ]);
        const [old] = await db.query<{
          id: string;
          client_instance_id: string;
        }>(
          "SELECT id,client_instance_id FROM solo_sessions WHERE user_id=$1 AND media_id=$2 AND ended_at IS NULL",
          [i.user.id, m.id],
          c,
        );
        assert(
          !old || old.client_instance_id === b.clientInstanceId || b.takeover,
          "SOLO_DEVICE_ACTIVE",
          409,
        );
        if (old && old.client_instance_id === b.clientInstanceId) {
          const [p] = await db.query<{
            position_seconds: number;
            write_revision: string;
          }>(
            "SELECT position_seconds,write_revision FROM user_progress WHERE user_id=$1 AND media_id=$2 AND content_generation=$3",
            [i.user.id, m.id, m.content_generation],
            c,
          );
          return {
            id: old.id,
            positionSeconds: p?.position_seconds ?? 0,
            writeRevision: Number(p?.write_revision ?? 0),
            contentGeneration: m.content_generation,
          };
        }
        await c.query(
          "UPDATE solo_sessions SET ended_at=now() WHERE user_id=$1 AND media_id=$2 AND ended_at IS NULL",
          [i.user.id, m.id],
        );
        const solo = randomUUID();
        await c.query(
          "INSERT INTO solo_sessions(id,user_id,media_id,content_generation,client_instance_id) VALUES($1,$2,$3,$4,$5)",
          [solo, i.user.id, m.id, m.content_generation, b.clientInstanceId],
        );
        const [p] = await db.query<{ position_seconds: number }>(
          "SELECT position_seconds FROM user_progress WHERE user_id=$1 AND media_id=$2 AND content_generation=$3",
          [i.user.id, m.id, m.content_generation],
          c,
        );
        return {
          id: solo,
          positionSeconds: p?.position_seconds ?? 0,
          writeRevision: 0,
          contentGeneration: m.content_generation,
        };
      });
    },
  );
  const progress = z.strictObject({
    positionSeconds: position,
    writeRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    contentGeneration: uuid,
  });
  const save = async (
    b: z.infer<typeof progress>,
    i: Identity,
    soloId: string,
    end = false,
  ) =>
    db.transaction(async (c) => {
      const [s] = await db.query<{
        user_id: string;
        media_id: string;
        content_generation: string;
        write_revision: string;
        duration_seconds: number;
      }>(
        "SELECT s.*,m.duration_seconds FROM solo_sessions s JOIN media m ON m.id=s.media_id WHERE s.id=$1 AND s.user_id=$2 AND s.ended_at IS NULL FOR UPDATE OF s",
        [soloId, i.user.id],
        c,
      );
      assert(
        s &&
          s.content_generation === b.contentGeneration &&
          b.writeRevision > Number(s.write_revision),
        "STALE_SOLO_SESSION",
        409,
      );
      assert(
        b.positionSeconds <= s.duration_seconds + 0.25,
        "INVALID_POSITION",
      );
      await c.query(
        "UPDATE solo_sessions SET write_revision=$1,ended_at=CASE WHEN $2 THEN now() ELSE NULL END WHERE id=$3",
        [b.writeRevision, end, soloId],
      );
      await c.query(
        "INSERT INTO user_progress(user_id,media_id,content_generation,position_seconds,solo_session_id,write_revision,completed_at) VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $7 THEN now() ELSE NULL END) ON CONFLICT(user_id,media_id,content_generation) DO UPDATE SET position_seconds=excluded.position_seconds,solo_session_id=excluded.solo_session_id,write_revision=excluded.write_revision,completed_at=coalesce(user_progress.completed_at,excluded.completed_at),updated_at=now()",
        [
          i.user.id,
          s.media_id,
          b.contentGeneration,
          Math.min(b.positionSeconds, s.duration_seconds),
          soloId,
          b.writeRevision,
          s.duration_seconds > 0 && b.positionSeconds >= s.duration_seconds,
        ],
      );
      return { ok: true };
    });
  h.route(
    "PUT",
    "/api/v1/solo-sessions/:id/progress",
    progress,
    "user",
    async (b, i, r) => save(b, i, id(r)),
  );
  h.route(
    "POST",
    "/api/v1/solo-sessions/:id/end",
    progress,
    "user",
    async (b, i, r) => save(b, i, id(r), true),
  );
  h.route(
    "POST",
    "/api/v1/admin/sources/inspect",
    z.strictObject({ url: z.string().max(8192) }),
    "owner",
    async (b, i) => {
      limits.check(`inspect:${i.user.id}`, 10, 60000);
      return urls.inspect(b.url);
    },
  );
  const refSchema = z.strictObject({
    url: z.string().max(8192),
    sameContent: z.boolean().default(false),
  });
  h.route(
    "POST",
    "/api/v1/admin/videos/:id/sources",
    refSchema,
    "owner",
    async (b, i, r, _p, prepared) => {
      const m = await library.get(id(r), i),
        inspection = prepared as Inspection;
      assert(inspection.durationSeconds > 0, "SOURCE_DURATION_UNKNOWN", 409);
      const ref: UrlReference = {
        url: b.url,
        domain: new URL(b.url).hostname,
        durationSeconds: inspection.durationSeconds,
        bytes: inspection.bytes,
        mimeType: inspection.mimeType,
        expiresAt: signedExpiry(b.url),
      };
      const s = await library.addSource(
        m.id,
        inspection.kind,
        ref,
        undefined,
        inspection.delivery,
        "READY",
        null,
        inspection.approvedOrigins,
      );
      await db.query("UPDATE media SET duration_seconds=$1 WHERE id=$2", [
        inspection.durationSeconds,
        m.id,
      ]);
      await db.query("UPDATE sources SET content_fingerprint=$1 WHERE id=$2", [
        inspection.fingerprint,
        s,
      ]);
      return { sourceId: s, ...inspection };
    },
    { prepare: (b) => urls.inspect(b.url) },
  );
  h.route(
    "PATCH",
    "/api/v1/admin/sources/:id",
    refSchema,
    "owner",
    async (b, i, r, _p, prepared) => {
      const s = await library.source(id(r)),
        m = await library.get(s.media_id, i);
      assert(s.kind !== "local" && s.kind !== "drive", "URL_SOURCE_REQUIRED");
      const inspection = prepared as Inspection;
      const same =
        b.sameContent &&
        Math.abs(m.duration_seconds - inspection.durationSeconds) <= 1 &&
        library.reference<UrlReference>(s).bytes === inspection.bytes &&
        (!s.content_fingerprint ||
          s.content_fingerprint === inspection.fingerprint);
      assert(!b.sameContent || same, "CONTENT_IDENTITY_MISMATCH", 409);
      await library.onUnavailable(m.id);
      await db.query(
        "UPDATE sources SET encrypted_reference=$1,kind=$2,delivery_strategy=$3,health=$4,content_fingerprint=$5,approved_origins_json=$6,last_checked_at=now() WHERE id=$7",
        [
          seal(
            {
              url: b.url,
              domain: new URL(b.url).hostname,
              durationSeconds: inspection.durationSeconds,
              bytes: inspection.bytes,
              mimeType: inspection.mimeType,
              expiresAt: signedExpiry(b.url),
            },
            library.config.masterKey,
            "source",
            s.id,
          ),
          inspection.kind,
          inspection.delivery,
          "READY",
          inspection.fingerprint,
          JSON.stringify(inspection.approvedOrigins),
          s.id,
        ],
      );
      await db.query(
        "UPDATE media SET content_generation=CASE WHEN $1 THEN content_generation ELSE $2::uuid END,duration_seconds=$3,updated_at=now() WHERE id=$4",
        [same, randomUUID(), inspection.durationSeconds, m.id],
      );
      return { sameContent: same };
    },
    { prepare: (b) => urls.inspect(b.url) },
  );
  h.route(
    "POST",
    "/api/v1/admin/sources/:id/recheck",
    empty,
    "owner",
    async (_b, i, r) => {
      const s = await library.source(id(r));
      await library.get(s.media_id, i);
      if (s.kind === "drive") {
        const descriptor = await driveResolve(s.media_id, i);
        await db.query(
          "UPDATE sources SET health='READY',safe_error_code=NULL,last_checked_at=now() WHERE id=$1",
          [s.id],
        );
        return descriptor;
      }
      assert(s.kind !== "local", "URL_SOURCE_REQUIRED");
      const ref = library.reference<UrlReference>(s);
      try {
        const inspection = await urls.inspect(ref.url);
        assert(
          Math.abs(inspection.durationSeconds - ref.durationSeconds) <= 1 &&
            inspection.bytes === ref.bytes &&
            (!s.content_fingerprint ||
              inspection.fingerprint === s.content_fingerprint),
          "CONTENT_IDENTITY_MISMATCH",
          409,
        );
        await db.query(
          "UPDATE sources SET health='READY',safe_error_code=NULL,last_checked_at=now() WHERE id=$1",
          [s.id],
        );
        return inspection;
      } catch (e) {
        await db.query(
          "UPDATE sources SET health=$1,safe_error_code=$2,last_checked_at=now() WHERE id=$3",
          [
            e instanceof AppError && e.code === "CONTENT_IDENTITY_MISMATCH"
              ? "ERROR"
              : "UNAVAILABLE",
            e instanceof AppError ? e.code : "SOURCE_UNAVAILABLE",
            s.id,
          ],
        );
        await library.onUnavailable(s.media_id);
        throw e;
      }
    },
  );
  h.route(
    "POST",
    "/api/v1/admin/sources/:id/prepare-copy",
    z.strictObject({ authorized: z.literal(true) }),
    "owner",
    async (_b, i, r) => {
      const s = await library.source(id(r));
      await library.get(s.media_id, i);
      assert(["http_file", "drive"].includes(s.kind), "FILE_SOURCE_REQUIRED");
      return jobs.enqueue("prepare-copy", s.media_id, `copy:${s.id}`, {
        sourceId: s.id,
      });
    },
  );
  h.route(
    "POST",
    "/api/v1/admin/videos/:id/hls",
    empty,
    "owner",
    async (_b, i, r) => {
      const m = await library.get(id(r), i);
      assert(
        m.primary_source_id &&
          (await library.source(m.primary_source_id)).kind === "local",
        "LOCAL_SOURCE_REQUIRED",
      );
      return jobs.enqueue(
        "hls",
        m.id,
        `hls:${m.id}:${m.content_generation}`,
        {},
      );
    },
  );
  h.route(
    "POST",
    "/api/v1/admin/videos/:id/subtitles",
    z.strictObject({
      text: z.string().max(5242880),
      language: z.string().regex(/^[a-zA-Z0-9-]{2,35}$/),
      label: z.string().trim().min(1).max(100),
    }),
    "owner",
    async (b, i, r) => {
      const m = await library.get(id(r), i),
        text = toVtt(parseSubtitles(b.text)),
        sid = randomUUID(),
        aid = randomUUID(),
        key = `subtitles/${m.id}/${aid}.vtt`,
        file = await preparePath(library.config.DATA_ROOT, key);
      await writeFile(file, text, { mode: 0o600 });
      await db.query(
        "INSERT INTO assets(id,media_id,kind,storage_key,mime_type,bytes,checksum) VALUES($1,$2,'subtitle',$3,'text/vtt',$4,$5)",
        [aid, m.id, key, Buffer.byteLength(text), await checksum(file)],
      );
      await db.query(
        "INSERT INTO subtitles(id,media_id,asset_id,language_tag,label) VALUES($1,$2,$3,$4,$5)",
        [sid, m.id, aid, b.language, b.label],
      );
      return { id: sid };
    },
  );
  h.route(
    "PUT",
    "/api/v1/admin/videos/:id/chapters",
    z.strictObject({ chapters: chaptersSchema }),
    "owner",
    async (b, i, r) => {
      const m = await library.get(id(r), i);
      assert(
        b.chapters.every(
          (ch, n) =>
            ch.startSeconds < m.duration_seconds &&
            (!n || ch.startSeconds > b.chapters[n - 1].startSeconds),
        ),
        "INVALID_CHAPTERS",
      );
      await db.transaction(async (c) => {
        await c.query("DELETE FROM chapters WHERE media_id=$1", [m.id]);
        for (const [n, ch] of b.chapters.entries())
          await c.query(
            "INSERT INTO chapters(id,media_id,start_seconds,title,sort_order) VALUES($1,$2,$3,$4,$5)",
            [randomUUID(), m.id, ch.startSeconds, ch.title, n],
          );
      });
      return { ok: true };
    },
  );
  const image = z.strictObject({
    imageBase64: z.string().max(3 * 1024 * 1024),
  });
  const storeImage = async (
    b: z.infer<typeof image>,
    i: Identity,
    mediaId: string | null,
  ) => {
    const input = Buffer.from(b.imageBase64, "base64");
    assert(input.length <= 2 * 1024 * 1024, "IMAGE_TOO_LARGE");
    const s = sharp(input, { limitInputPixels: 16000000 }),
      meta = await s.metadata();
    assert(
      ["jpeg", "png", "webp"].includes(meta.format ?? ""),
      "UNSUPPORTED_IMAGE",
    );
    const output = await s
      .rotate()
      .resize(640, 640, { fit: "inside", withoutEnlargement: true })
      .jpeg()
      .toBuffer();
    const aid = randomUUID(),
      key = `images/${aid}.jpg`,
      file = await preparePath(library.config.DATA_ROOT, key);
    await writeFile(file, output, { mode: 0o600 });
    await db.query(
      "INSERT INTO assets(id,media_id,kind,storage_key,mime_type,bytes,checksum,metadata_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        aid,
        mediaId,
        mediaId ? "poster" : "avatar",
        key,
        "image/jpeg",
        output.length,
        await checksum(file),
        { ownerId: i.user.id },
      ],
    );
    return { assetId: aid };
  };
  h.route("POST", "/api/v1/account/avatar", image, "user", async (b, i) =>
    storeImage(b, i, null),
  );
  h.route(
    "POST",
    "/api/v1/admin/videos/:id/poster",
    image,
    "owner",
    async (b, i, r) => {
      const m = await library.get(id(r), i);
      return storeImage(b, i, m.id);
    },
  );
  for (const method of ["GET", "HEAD"] as const) {
    h.route(method, "/media/assets/:id", empty, "user", async (_b, i, r, p) =>
      streams.asset(id(r), i, r, p),
    );
    h.route(method, "/media/:id/file", empty, "user", async (_b, i, r, p) => {
      const s = await library.source(id(r)),
        m = await library.get(s.media_id, i);
      assert(
        m.primary_source_id === s.id && s.health === "READY",
        "MEDIA_UNAVAILABLE",
        409,
      );
      if (s.kind === "local") {
        const ref = library.reference<LocalReference>(s);
        return streams.asset(ref.assetId, i, r, p);
      }
      if (s.kind === "drive") return driveStream(s.id, i, r, p);
      assert(
        s.kind === "http_file" && s.delivery_strategy === "relay",
        "MEDIA_UNAVAILABLE",
        409,
      );
      const ref = library.reference<UrlReference>(s),
        c = streams.register(i, r, p);
      await urls.resolvePlayback(m, s);
      let result;
      try {
        result = await urls.openByteRange(ref.url, r.headers.range, c.signal, {
          bytes: ref.bytes,
          fingerprint: s.content_fingerprint,
          method: r.method === "HEAD" ? "HEAD" : "GET",
        });
      } catch (error) {
        if (error instanceof AppError && error.code === "INVALID_RANGE")
          p.header("Content-Range", `bytes */${ref.bytes}`);
        if (
          error instanceof AppError &&
          [
            "CONTENT_IDENTITY_MISMATCH",
            "SOURCE_NOT_SEEKABLE",
            "SOURCE_UNAVAILABLE",
          ].includes(error.code)
        ) {
          await db.query(
            "UPDATE sources SET health=$1,safe_error_code=$2 WHERE id=$3",
            [
              error.code === "CONTENT_IDENTITY_MISMATCH"
                ? "ERROR"
                : "UNAVAILABLE",
              error.code,
              s.id,
            ],
          );
          await library.onUnavailable(m.id);
        }
        throw error;
      }
      p.code(result.status);
      for (const name of [
        "content-type",
        "content-length",
        "content-range",
        "accept-ranges",
      ])
        if (result.headers[name]) p.header(name, result.headers[name]);
      p.header("Cache-Control", "private, no-store");
      if (r.method === "HEAD") {
        result.abort();
        return p.send();
      }
      return p.send(result.body);
    });
    h.route(
      method,
      "/media/local-hls/:id/*",
      empty,
      "user",
      async (_b, i, r, p) => {
        const s = await library.source(id(r)),
          m = await library.get(s.media_id, i);
        assert(
          m.primary_source_id === s.id &&
            s.kind === "local" &&
            s.health === "READY",
          "MEDIA_UNAVAILABLE",
          409,
        );
        const ref = library.reference<LocalReference>(s);
        assert(ref.hlsAssetId, "NOT_FOUND", 404);
        const name = (r.params as { "*": string })["*"];
        return streams.playlist(ref.hlsAssetId, name, i, r, p);
      },
    );
  }
}

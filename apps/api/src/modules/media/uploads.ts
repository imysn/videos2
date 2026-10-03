import { z } from "zod";
import { randomUUID } from "node:crypto";
import { open, stat, rename, unlink, statfs } from "node:fs/promises";
import {
  uuid,
  metadataSchema,
} from "../../../../../packages/contracts/src/index.js";
import { Http } from "../../infrastructure/http.js";
import { assert, AppError } from "../../infrastructure/errors.js";
import { preparePath, storagePath, checksum, syncParents } from "./storage.js";
import type { LibraryService } from "../library/service.js";
import { Jobs } from "../../jobs/service.js";
import { UploadAccess } from "./upload-access.js";
export async function reserveSpace(root: string, bytes: number) {
  const fs = await statfs(root);
  const total = Number(fs.blocks) * Number(fs.bsize),
    free = Number(fs.bavail) * Number(fs.bsize);
  assert(
    free - bytes >= Math.max(5 * 1024 ** 3, total * 0.15),
    "INSUFFICIENT_STORAGE",
    507,
  );
}
export function uploadRoutes(h: Http, library: LibraryService, jobs: Jobs) {
  const db = library.db,
    cfg = library.config,
    empty = z.strictObject({});
  // At most two bounded chunk bodies per API process. Bytes are received before
  // taking database/file locks, so slow links do not hold an idle transaction.
  const receiving = new Set<string>();
  h.app.addContentTypeParser(
    "application/octet-stream",
    (request, payload, done) => done(null, payload),
  );
  const register = (prefix: string, admin: boolean) => {
    const access = admin ? "owner" : "uploader";
    const uploads = new UploadAccess(db, admin);
    const get = uploads.get.bind(uploads);
    h.route(
      "POST",
      prefix,
      metadataSchema.extend({
        originalName: z.string().min(1).max(255),
        expectedBytes: z.number().int().positive().max(cfg.MAX_UPLOAD_BYTES),
      }),
      access,
      async (b, i) => {
        await reserveSpace(cfg.DATA_ROOT, b.expectedBytes * 3);
        return db.transaction(async (c) => {
          await c.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
            i.user.id,
          ]);
          const [{ count }] = await db.query<{ count: string }>(
            "SELECT count(*) FROM uploads WHERE owner_id=$1 AND state='uploading' AND expires_at>now()",
            [i.user.id],
            c,
          );
          assert(Number(count) < 2, "UPLOAD_LIMIT", 409);
          const mediaId = await library.create(i, b, c),
            id = randomUUID(),
            key = `uploads/${id}.part`;
          const p = await preparePath(cfg.DATA_ROOT, key);
          const f = await open(p, "wx", 0o600);
          try {
            await f.sync();
          } finally {
            await f.close();
          }
          await syncParents(cfg.DATA_ROOT, p);
          await c.query(
            "INSERT INTO uploads(id,owner_id,expected_bytes,original_name,temporary_key,expires_at,media_id) VALUES($1,$2,$3,$4,$5,now()+interval '24 hours',$6)",
            [id, i.user.id, b.expectedBytes, b.originalName, key, mediaId],
          );
          await jobs.audit(i.user.id, "upload.created", "upload", id, {
            mediaId,
          });
          return { id, mediaId, offset: 0, expectedBytes: b.expectedBytes };
        });
      },
    );
    h.route("GET", `${prefix}/:id`, empty, access, async (_b, i, r) => {
      const u = await get(uuid.parse((r.params as { id: string }).id), i);
      const [record] = await uploads.records([u], cfg.UPLOAD_CHUNK_MAX_BYTES);
      assert(record, "NOT_FOUND", 404);
      return record;
    });
    h.route("HEAD", `${prefix}/:id`, empty, access, async (_b, i, r, p) => {
      const u = await get(uuid.parse((r.params as { id: string }).id), i);
      p.header("Upload-Offset", u.committed_offset)
        .header("Upload-Length", u.expected_bytes)
        .header("Upload-State", u.state)
        .header("Upload-Chunk-Max-Bytes", cfg.UPLOAD_CHUNK_MAX_BYTES);
      p.code(204);
      return null;
    });
    h.route(
      "PATCH",
      `${prefix}/:id`,
      z.unknown(),
      access,
      async (_body, i, _r, p, prepared) => {
        const { id, offset, length, chunk } = prepared as {
          id: string;
          offset: number;
          length: number;
          chunk: Buffer;
        };
        const committed = await db.transaction(async (c) => {
          const u = await get(id, i, c, true);
          uploads.assertWritable(u, i);
          assert(u && u.state === "uploading", "UPLOAD_UNAVAILABLE", 409);
          assert(
            offset === Number(u.committed_offset) &&
              offset + length <= Number(u.expected_bytes),
            "UPLOAD_OFFSET_MISMATCH",
            409,
          );
          const file = storagePath(cfg.DATA_ROOT, u.temporary_key);
          const s = await stat(file).catch((error) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT")
              return { size: -1 };
            throw error;
          });
          if (s.size < offset) {
            await c.query("UPDATE uploads SET state='failed' WHERE id=$1", [
              id,
            ]);
            return null;
          }
          const f = await open(file, "r+");
          let written = 0;
          try {
            await f.truncate(offset);
            while (written < length) {
              const v = await f.write(
                chunk,
                written,
                length - written,
                offset + written,
              );
              assert(v.bytesWritten > 0, "INVALID_CHUNK");
              written += v.bytesWritten;
            }
            assert(written === length, "INVALID_CHUNK");
            await f.sync();
            await c.query(
              "UPDATE uploads SET committed_offset=$1,expires_at=now()+interval '24 hours' WHERE id=$2",
              [offset + written, id],
            );
            return offset + written;
          } catch (e) {
            await f.truncate(offset);
            await f.sync();
            if ((e as NodeJS.ErrnoException).code === "ENOSPC")
              throw new AppError("INSUFFICIENT_STORAGE", 507);
            throw e;
          } finally {
            await f.close();
          }
        });
        if (committed === null) {
          p.code(409);
          return {
            code: "UPLOAD_CORRUPT",
            message:
              "La carga perdió bytes confirmados. Cancela esta carga y vuelve a seleccionar el archivo original.",
            correlationId: randomUUID(),
          };
        }
        p.header("Upload-Offset", committed);
        p.code(204);
        return null;
      },
      {
        prepare: async (body, i, r, p) => {
          assert(
            r.headers["content-type"] === "application/octet-stream",
            "CONTENT_TYPE_REQUIRED",
            415,
          );
          const id = uuid.parse((r.params as { id: string }).id),
            offset = Number(r.headers["upload-offset"]),
            length = Number(r.headers["content-length"]);
          assert(
            Number.isSafeInteger(offset) &&
              offset >= 0 &&
              Number.isSafeInteger(length) &&
              length > 0 &&
              length <= cfg.UPLOAD_CHUNK_MAX_BYTES,
            "INVALID_CHUNK",
          );
          const u = await get(id, i);
          uploads.assertWritable(u, i);
          assert(u.state === "uploading", "UPLOAD_UNAVAILABLE", 409);
          assert(
            offset === Number(u.committed_offset) &&
              offset + length <= Number(u.expected_bytes),
            "UPLOAD_OFFSET_MISMATCH",
            409,
          );
          assert(!receiving.has(id), "UPLOAD_OFFSET_MISMATCH", 409);
          assert(receiving.size < 2, "UPLOAD_LIMIT", 409);
          receiving.add(id);
          const release = () => {
            receiving.delete(id);
            p.raw.off("finish", release);
            p.raw.off("close", release);
          };
          p.raw.once("finish", release);
          p.raw.once("close", release);
          try {
            const chunk = Buffer.allocUnsafe(length);
            let received = 0;
            for await (const part of body as AsyncIterable<Buffer>) {
              assert(received + part.length <= length, "INVALID_CHUNK");
              chunk.set(part, received);
              received += part.length;
            }
            assert(received === length, "INVALID_CHUNK");
            return { id, offset, length, chunk };
          } catch (error) {
            release();
            throw error;
          }
        },
      },
    );
    h.route(
      "POST",
      `${prefix}/:id/complete`,
      empty,
      access,
      async (_b, i, r, _p, prepared) =>
        db.transaction(async (c) => {
          const id = uuid.parse((r.params as { id: string }).id);
          const u = await get(id, i, c, true);
          assert(u, "NOT_FOUND", 404);
          if (u.state === "completed") {
            const [job] = await db.query<{ id: string }>(
              "SELECT id FROM jobs WHERE media_id=$1 AND kind='ingest' AND payload_json->>'assetId' IN (SELECT id::text FROM assets WHERE media_id=$1 AND kind='original') ORDER BY created_at DESC,id DESC LIMIT 1",
              [u.media_id],
              c,
            );
            return { mediaId: u.media_id, jobId: job?.id };
          }
          uploads.assertWritable(u, i);
          assert(
            u.state === "uploading" && u.expected_bytes === u.committed_offset,
            "UPLOAD_INCOMPLETE",
            409,
          );
          const old = storagePath(cfg.DATA_ROOT, u.temporary_key),
            key = `originals/${u.media_id}/${id}.bin`,
            target = await preparePath(cfg.DATA_ROOT, key);
          try {
            await stat(target);
          } catch {
            await rename(old, target);
          }
          await syncParents(cfg.DATA_ROOT, old);
          await syncParents(cfg.DATA_ROOT, target);
          assert(
            (await stat(target)).size === Number(u.expected_bytes),
            "UPLOAD_CORRUPT",
          );
          const sum = (prepared as { checksum: string }).checksum;
          const assetId = randomUUID();
          await c.query(
            "INSERT INTO assets(id,media_id,kind,storage_key,mime_type,bytes,checksum,metadata_json) VALUES($1,$2,'original',$3,'application/octet-stream',$4,$5,$6)",
            [
              assetId,
              u.media_id,
              key,
              u.expected_bytes,
              sum,
              { originalName: u.original_name },
            ],
          );
          await c.query(
            "UPDATE uploads SET state='completed',temporary_key=$1 WHERE id=$2",
            [key, id],
          );
          const job = await jobs.enqueue(
            "ingest",
            u.media_id,
            `ingest:${u.media_id}:${id}`,
            { assetId },
            c,
          );
          await jobs.audit(i.user.id, "upload.completed", "upload", id, {
            mediaId: u.media_id,
            jobId: job.id,
          });
          return { mediaId: u.media_id, jobId: job.id };
        }),
      {
        prepare: async (_body, i, r) => {
          const u = await get(uuid.parse((r.params as { id: string }).id), i);
          if (u.state === "completed") return {};
          uploads.assertWritable(u, i);
          assert(
            u.state === "uploading" && u.expected_bytes === u.committed_offset,
            "UPLOAD_INCOMPLETE",
            409,
          );
          const target = storagePath(
            cfg.DATA_ROOT,
            `originals/${u.media_id}/${u.id}.bin`,
          );
          // A full upload cannot accept further positive-length PATCH requests.
          // Hash outside the transaction; state/length are fenced again under its row lock.
          const hash = async (file: string) => {
            assert(
              (await stat(file)).size === Number(u.expected_bytes),
              "UPLOAD_CORRUPT",
              409,
            );
            return { checksum: await checksum(file) };
          };
          const missing = (e: unknown) =>
            (e as NodeJS.ErrnoException).code === "ENOENT";
          try {
            // Another completion may rename the part between stat and open. Try
            // the destination again; both requests must return the same ingest.
            try {
              return await hash(target);
            } catch (e) {
              if (!missing(e)) throw e;
            }
            try {
              return await hash(storagePath(cfg.DATA_ROOT, u.temporary_key));
            } catch (e) {
              if (!missing(e)) throw e;
              return await hash(target);
            }
          } catch (e) {
            if (
              !missing(e) &&
              !(e instanceof AppError && e.code === "UPLOAD_CORRUPT")
            )
              throw e;
            const current = await get(u.id, i);
            if (current.state === "completed") return {};
            assert(current.state === "uploading", "UPLOAD_UNAVAILABLE", 409);
            await db.query(
              "UPDATE uploads SET state='failed' WHERE id=$1 AND state='uploading' AND committed_offset=expected_bytes",
              [u.id],
            );
            throw new AppError("UPLOAD_CORRUPT", 409);
          }
        },
      },
    );
    h.route("DELETE", `${prefix}/:id`, empty, access, async (_b, i, r) => {
      const u = await get(uuid.parse((r.params as { id: string }).id), i);
      assert(u.state !== "completed", "UPLOAD_COMPLETED", 409);
      await db.transaction(async (c) => {
        const current = await get(u.id, i, c, true);
        uploads.assertWritable(current, i);
        assert(current.state !== "completed", "UPLOAD_COMPLETED", 409);
        await unlink(storagePath(cfg.DATA_ROOT, u.temporary_key)).catch(
          () => {},
        );
        await unlink(
          storagePath(cfg.DATA_ROOT, `originals/${u.media_id}/${u.id}.bin`),
        ).catch(() => {});
        await c.query("UPDATE uploads SET state='cancelled' WHERE id=$1", [
          u.id,
        ]);
        if (current.state !== "cancelled")
          await jobs.audit(i.user.id, "upload.cancelled", "upload", u.id);
      });
      return { ok: true };
    });
    h.route(
      "GET",
      prefix,
      z.strictObject({
        limit: z.coerce.number().int().min(1).max(100).default(30),
        cursor: z.string().max(1000).optional(),
      }),
      access,
      async (b, i) => {
        let after: { key: string; id: string } | null = null;
        if (b.cursor) {
          try {
            after = z
              .strictObject({ key: z.iso.datetime(), id: uuid })
              .parse(JSON.parse(Buffer.from(b.cursor, "base64url").toString()));
          } catch {
            throw new AppError("INVALID_CURSOR");
          }
        }
        const rows = await uploads.list(i, b.limit, after),
          page = rows.slice(0, b.limit),
          last = page.at(-1);
        return {
          items: await uploads.records(page, cfg.UPLOAD_CHUNK_MAX_BYTES),
          nextCursor:
            rows.length > b.limit && last
              ? Buffer.from(
                  JSON.stringify({ key: last.cursor_created_at, id: last.id }),
                ).toString("base64url")
              : null,
        };
      },
    );
    if (!admin)
      for (const action of ["retry", "cancel"] as const) {
        h.route(
          "POST",
          `${prefix}/:id/${action === "retry" ? "retry" : "cancel-preparation"}`,
          empty,
          "uploader",
          async (_b, i, r) => {
            const u = await get(uuid.parse((r.params as { id: string }).id), i);
            const [record] = await uploads.records(
              [u],
              cfg.UPLOAD_CHUNK_MAX_BYTES,
            );
            assert(
              record?.preparation.job,
              action === "retry" ? "JOB_NOT_RETRYABLE" : "JOB_NOT_CANCELLABLE",
              409,
            );
            return jobs.act(record.preparation.job.id, action, i.user.id, u.id);
          },
        );
      }
  };
  register("/api/v1/admin/uploads", true);
  register("/api/v1/uploads", false);
}

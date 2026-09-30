import { z } from "zod";
import { randomUUID } from "node:crypto";
import { open, stat, rename, unlink, statfs } from "node:fs/promises";
import {
  uuid,
  metadataSchema,
} from "../../../../../packages/contracts/src/index.js";
import { Http } from "../../infrastructure/http.js";
import { assert } from "../../infrastructure/errors.js";
import { preparePath, storagePath, checksum } from "./storage.js";
import type { LibraryService } from "../library/service.js";
import { Jobs } from "../../jobs/service.js";
interface Upload {
  id: string;
  owner_id: string;
  expected_bytes: string;
  committed_offset: string;
  temporary_key: string;
  state: string;
  media_id: string;
  original_name: string;
}
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
  h.app.addContentTypeParser(
    "application/octet-stream",
    (request, payload, done) => done(null, payload),
  );
  h.route(
    "POST",
    "/api/v1/admin/uploads",
    metadataSchema.extend({
      originalName: z.string().min(1).max(255),
      expectedBytes: z.number().int().positive().max(cfg.MAX_UPLOAD_BYTES),
    }),
    "owner",
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
        await f.close();
        await c.query(
          "INSERT INTO uploads(id,owner_id,expected_bytes,original_name,temporary_key,expires_at,media_id) VALUES($1,$2,$3,$4,$5,now()+interval '24 hours',$6)",
          [id, i.user.id, b.expectedBytes, b.originalName, key, mediaId],
        );
        return { id, mediaId, offset: 0, expectedBytes: b.expectedBytes };
      });
    },
  );
  const get = async (id: string, i: { user: { id: string } }) => {
    const [u] = await db.query<Upload>(
      "SELECT * FROM uploads WHERE id=$1 AND owner_id=$2",
      [id, i.user.id],
    );
    assert(u, "NOT_FOUND", 404);
    return u;
  };
  h.route(
    "HEAD",
    "/api/v1/admin/uploads/:id",
    empty,
    "owner",
    async (_b, i, r, p) => {
      const u = await get(uuid.parse((r.params as { id: string }).id), i);
      p.header("Upload-Offset", u.committed_offset)
        .header("Upload-Length", u.expected_bytes)
        .header("Upload-State", u.state);
      p.code(204);
      return null;
    },
  );
  h.route(
    "PATCH",
    "/api/v1/admin/uploads/:id",
    z.unknown(),
    "owner",
    async (body, i, r, p) => {
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
      const committed = await db.transaction(async (c) => {
        const [u] = await db.query<Upload>(
          "SELECT * FROM uploads WHERE id=$1 AND owner_id=$2 FOR UPDATE",
          [id, i.user.id],
          c,
        );
        assert(u && u.state === "uploading", "UPLOAD_UNAVAILABLE", 409);
        assert(
          offset === Number(u.committed_offset) &&
            offset + length <= Number(u.expected_bytes),
          "UPLOAD_OFFSET_MISMATCH",
          409,
        );
        const file = storagePath(cfg.DATA_ROOT, u.temporary_key);
        const s = await stat(file);
        assert(s.size >= offset, "UPLOAD_CORRUPT", 409);
        const f = await open(file, "r+");
        let written = 0;
        try {
          await f.truncate(offset);
          for await (const part of body as AsyncIterable<Buffer>) {
            const chunk = Buffer.from(part);
            assert(written + chunk.length <= length, "INVALID_CHUNK");
            let n = 0;
            while (n < chunk.length) {
              const v = await f.write(
                chunk,
                n,
                chunk.length - n,
                offset + written + n,
              );
              n += v.bytesWritten;
            }
            written += chunk.length;
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
          throw e;
        } finally {
          await f.close();
        }
      });
      p.header("Upload-Offset", committed);
      p.code(204);
      return null;
    },
  );
  h.route(
    "POST",
    "/api/v1/admin/uploads/:id/complete",
    empty,
    "owner",
    async (_b, i, r) =>
      db.transaction(async (c) => {
        const id = uuid.parse((r.params as { id: string }).id);
        const [u] = await db.query<Upload>(
          "SELECT * FROM uploads WHERE id=$1 AND owner_id=$2 FOR UPDATE",
          [id, i.user.id],
          c,
        );
        assert(u, "NOT_FOUND", 404);
        if (u.state === "completed") return { mediaId: u.media_id };
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
        assert(
          (await stat(target)).size === Number(u.expected_bytes),
          "UPLOAD_CORRUPT",
        );
        const sum = await checksum(target);
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
        return { mediaId: u.media_id, jobId: job.id };
      }),
  );
  h.route(
    "DELETE",
    "/api/v1/admin/uploads/:id",
    empty,
    "owner",
    async (_b, i, r) => {
      const u = await get(uuid.parse((r.params as { id: string }).id), i);
      assert(u.state !== "completed", "UPLOAD_COMPLETED", 409);
      await db.transaction(async (c) => {
        const [current] = await db.query<Upload>(
          "SELECT * FROM uploads WHERE id=$1 FOR UPDATE",
          [u.id],
          c,
        );
        assert(current.state !== "completed", "UPLOAD_COMPLETED", 409);
        await unlink(storagePath(cfg.DATA_ROOT, u.temporary_key)).catch(
          () => {},
        );
        await c.query("UPDATE uploads SET state='cancelled' WHERE id=$1", [
          u.id,
        ]);
      });
      return { ok: true };
    },
  );
}

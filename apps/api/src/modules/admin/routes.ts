import { z } from "zod";
import { statfs } from "node:fs/promises";
import { Http } from "../../infrastructure/http.js";
import { uuid } from "../../../../../packages/contracts/src/index.js";
import { assert } from "../../infrastructure/errors.js";
export function adminRoutes(h: Http) {
  const db = h.auth.db,
    cfg = h.auth.config,
    empty = z.strictObject({});
  h.route("GET", "/api/v1/admin/jobs", empty, "owner", async () =>
    db.query(
      "SELECT id,kind,media_id,state,attempt,progress,safe_error_code,cancel_requested,created_at FROM jobs ORDER BY created_at DESC LIMIT 100",
    ),
  );
  h.route(
    "POST",
    "/api/v1/admin/jobs/:id/retry",
    empty,
    "owner",
    async (_b, _i, r) => {
      const id = uuid.parse((r.params as { id: string }).id);
      const rows = await db.query<{ id: string }>(
        "UPDATE jobs j SET state='queued',run_after=now(),safe_error_code=NULL,cancel_requested=false WHERE id=$1 AND state='failed' AND attempt<max_attempts AND (kind NOT IN ('ingest','prepare-copy','hls') OR EXISTS(SELECT 1 FROM media m WHERE m.id=j.media_id AND m.deleted_at IS NULL AND m.content_generation::text=j.payload_json->>'contentGeneration')) RETURNING id",
        [id],
      );
      assert(rows.length, "JOB_NOT_RETRYABLE", 409);
      return { ok: true };
    },
  );
  h.route(
    "POST",
    "/api/v1/admin/jobs/:id/cancel",
    empty,
    "owner",
    async (_b, _i, r) => {
      const id = uuid.parse((r.params as { id: string }).id);
      const rows = await db.query<{ id: string }>(
        "UPDATE jobs SET cancel_requested=true,state=CASE WHEN state='queued' THEN 'cancelled' ELSE state END WHERE id=$1 AND state IN ('queued','running') RETURNING id",
        [id],
      );
      assert(rows.length, "JOB_NOT_CANCELLABLE", 409);
      return { ok: true };
    },
  );
  h.route("GET", "/api/v1/admin/system", empty, "owner", async () => {
    const fs = await statfs(cfg.DATA_ROOT),
      [{ bytes }] = await db.query<{ bytes: string }>(
        "SELECT coalesce(sum(bytes),0)::text AS bytes FROM assets",
      ),
      settings = await db.query(
        "SELECT key,value_json FROM settings ORDER BY key",
      );
    return {
      storage: {
        freeBytes: String(Number(fs.bavail) * Number(fs.bsize)),
        totalBytes: String(Number(fs.blocks) * Number(fs.bsize)),
        assetBytes: bytes,
      },
      jobs: await db.query(
        "SELECT state,count(*)::integer AS count FROM jobs GROUP BY state",
      ),
      settings,
      backupLocation: "local",
      googleConfigured: cfg.googleConfigured,
      mode: cfg.APP_ENV,
    };
  });
  const settings = z.strictObject({
    chatRetentionDays: z.number().int().min(1).max(365).optional(),
    maintenance: z.boolean().optional(),
  });
  h.route(
    "PATCH",
    "/api/v1/admin/settings",
    settings,
    "owner-recent",
    async (b, i) => {
      await db.transaction(async (c) => {
        for (const [key, value] of Object.entries(b))
          await c.query(
            "INSERT INTO settings(key,value_json) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=now()",
            [key, JSON.stringify(value)],
          );
        await c.query(
          "INSERT INTO audit_events(id,actor_id,action,safe_details_json) VALUES(gen_random_uuid(),$1,$2,$3)",
          [i.user.id, "settings.updated", { keys: Object.keys(b) }],
        );
      });
      return { ok: true };
    },
  );
}

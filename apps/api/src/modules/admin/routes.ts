import { z } from "zod";
import { statfs } from "node:fs/promises";
import { Http } from "../../infrastructure/http.js";
import { uuid } from "../../../../../packages/contracts/src/index.js";
import { Jobs, retryableJobSql } from "../../jobs/service.js";
export function adminRoutes(h: Http) {
  const db = h.auth.db,
    jobs = new Jobs(db),
    cfg = h.auth.config,
    empty = z.strictObject({});
  h.route("GET", "/api/v1/admin/jobs", empty, "owner", async () =>
    db.query(
      `SELECT j.id,j.kind,j.media_id,j.state,j.attempt,j.max_attempts,j.progress,j.safe_error_code,j.cancel_requested,j.created_at,m.title AS media_title,m.deleted_at,(${retryableJobSql}) AS retryable FROM jobs j LEFT JOIN media m ON m.id=j.media_id ORDER BY j.created_at DESC,j.id DESC LIMIT 100`,
    ),
  );
  h.route(
    "POST",
    "/api/v1/admin/jobs/:id/retry",
    empty,
    "owner",
    async (_b, i, r) => {
      const id = uuid.parse((r.params as { id: string }).id);
      return jobs.act(id, "retry", i.user.id);
    },
  );
  h.route(
    "POST",
    "/api/v1/admin/jobs/:id/cancel",
    empty,
    "owner",
    async (_b, i, r) => {
      const id = uuid.parse((r.params as { id: string }).id);
      return jobs.act(id, "cancel", i.user.id);
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

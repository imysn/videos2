import { randomUUID } from "node:crypto";
import type { Database, Client } from "../../../../packages/db/src/index.js";
export interface Job {
  id: string;
  kind: string;
  media_id: string | null;
  payload_json: Record<string, unknown>;
  unique_key: string;
  state: string;
  attempt: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_until: Date | null;
  cancel_requested: boolean;
}
// Exactly the existing retry rule, shared by actions and their read-only UI projection.
export const retryableJobSql = `j.state='failed' AND j.attempt<j.max_attempts AND (j.kind NOT IN ('ingest','prepare-copy','hls') OR EXISTS(SELECT 1 FROM media m WHERE m.id=j.media_id AND m.deleted_at IS NULL AND m.content_generation::text=j.payload_json->>'contentGeneration'))`;
export class Jobs {
  constructor(public db: Database) {}
  async enqueue(
    kind: string,
    mediaId: string | null,
    key: string,
    payload: Record<string, unknown>,
    c?: Client,
  ) {
    if (mediaId && ["ingest", "prepare-copy", "hls"].includes(kind)) {
      const [media] = await this.db.query<{ content_generation: string }>(
        "SELECT content_generation FROM media WHERE id=$1 AND deleted_at IS NULL",
        [mediaId],
        c,
      );
      if (!media) throw new Error("MEDIA_UNAVAILABLE");
      payload = { ...payload, contentGeneration: media.content_generation };
      key = `${key}:${media.content_generation}`;
    }
    const [job] = await this.db.query<Job>(
      "INSERT INTO jobs(id,kind,media_id,unique_key,payload_json) VALUES($1,$2,$3,$4,$5) ON CONFLICT(unique_key) DO UPDATE SET unique_key=excluded.unique_key RETURNING *",
      [randomUUID(), kind, mediaId, key, payload],
      c,
    );
    return job;
  }
  async claim(owner: string) {
    return this.db.transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(173005)");
      const maintenance = await this.db.query(
        "SELECT 1 FROM settings WHERE key='maintenance' AND value_json='true'::jsonb",
        [],
        c,
      );
      if (maintenance.length) return null;
      const busy = await this.db.query(
        "SELECT 1 FROM jobs WHERE state='running' AND lease_until>now() LIMIT 1",
        [],
        c,
      );
      if (busy.length) return null;
      await c.query(
        "UPDATE jobs SET state='failed',safe_error_code='MAX_ATTEMPTS',lease_until=NULL WHERE state='running' AND lease_until<now() AND attempt>=max_attempts",
      );
      const [j] = await this.db.query<Job>(
        "SELECT * FROM jobs WHERE attempt<max_attempts AND ((state='queued' AND run_after<=now()) OR (state='running' AND lease_until<now())) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1",
        [],
        c,
      );
      if (!j) return null;
      const [r] = await this.db.query<Job>(
        "UPDATE jobs SET state='running',attempt=attempt+1,lease_owner=$1,lease_until=now()+interval '30 seconds' WHERE id=$2 RETURNING *",
        [owner, j.id],
        c,
      );
      return r;
    });
  }
}

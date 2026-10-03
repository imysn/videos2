import type { Database, Client } from "../../../../../packages/db/src/index.js";
import type { Identity } from "../auth/service.js";
import { assert } from "../../infrastructure/errors.js";
import type {
  UploadRecord,
  UserUpload,
} from "../../../../../packages/contracts/src/upload-pipeline.js";
import { preparations } from "./preparation.js";

export interface UploadRow {
  id: string;
  owner_id: string;
  expected_bytes: string;
  committed_offset: string;
  temporary_key: string;
  state: UploadRecord["state"];
  media_id: string;
  original_name: string;
  title: string;
  description: string;
  category: string | null;
  publication_state: "DRAFT" | "PUBLISHED" | "WITHDRAWN";
  duration_seconds: number;
  health: string | null;
  created_at: Date;
  cursor_created_at: string;
  owner_display_name: string;
}
const select = `SELECT u.*,m.title,m.description,c.name AS category,m.publication_state,m.duration_seconds,s.health,m.created_at,
  to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at,
  (SELECT display_name FROM users WHERE slot='owner') AS owner_display_name
  FROM uploads u JOIN media m ON m.id=u.media_id
  LEFT JOIN categories c ON c.id=m.category_id LEFT JOIN sources s ON s.id=m.primary_source_id`;
// Admin compatibility is OWNER-only. User endpoints always require both account
// ownership fields, and never turn created_by into general media access.
const visible = `m.deleted_at IS NULL AND ($3 OR (u.owner_id=$2 AND m.created_by=$2)) AND ($4 OR m.publication_state<>'WITHDRAWN')`;
export class UploadAccess {
  constructor(
    public db: Database,
    public admin: boolean,
  ) {}
  async get(id: string, i: Identity, c?: Client, lock = false) {
    const [u] = await this.db.query<UploadRow>(
      `${select} WHERE u.id=$1 AND ${visible}${lock ? " FOR UPDATE OF u,m" : ""}`,
      [
        id,
        i.user.id,
        this.admin && i.user.role === "OWNER",
        i.user.role === "OWNER",
      ],
      c,
    );
    assert(u, "NOT_FOUND", 404);
    return u;
  }
  assertWritable(u: UploadRow, i: Identity) {
    assert(
      i.user.role === "OWNER" || u.publication_state === "DRAFT",
      "UPLOAD_UNAVAILABLE",
      409,
    );
  }
  async list(
    i: Identity,
    limit: number,
    after: { key: string; id: string } | null,
  ) {
    return this.db.query<UploadRow>(
      `${select} WHERE ${visible} AND ($1::timestamptz IS NULL OR (m.created_at,u.id)<($1,$5::uuid)) ORDER BY m.created_at DESC,u.id DESC LIMIT $6`,
      [
        after?.key ?? null,
        i.user.id,
        this.admin && i.user.role === "OWNER",
        i.user.role === "OWNER",
        after?.id ?? null,
        limit + 1,
      ],
    );
  }
  async records(
    rows: UploadRow[],
    chunkMaxBytes: number,
  ): Promise<UserUpload[]> {
    const states = await preparations(
      this.db,
      rows.map((u) => ({
        id: u.media_id,
        health: u.health,
        publication_state: u.publication_state,
        duration_seconds: u.duration_seconds,
      })),
    );
    return rows.flatMap((u) => {
      const preparation = states.get(u.media_id);
      if (!preparation) return [];
      return [
        {
          id: u.id,
          mediaId: u.media_id,
          offset: Number(u.committed_offset),
          expectedBytes: Number(u.expected_bytes),
          name: u.original_name,
          state: u.state,
          chunkMaxBytes,
          title: u.title,
          description: u.description,
          category: u.category,
          createdAt: u.created_at.toISOString(),
          durationSeconds: u.duration_seconds,
          publicationState: u.publication_state,
          ownerDisplayName: u.owner_display_name,
          preparation,
        },
      ];
    });
  }
}

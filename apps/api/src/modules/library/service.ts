import { randomUUID } from "node:crypto";
import type { Database, Client } from "../../../../../packages/db/src/index.js";
import type { Identity } from "../auth/service.js";
import type { Config } from "../../infrastructure/config.js";
import { assert } from "../../infrastructure/errors.js";
import { seal, open, type Ciphertext } from "../../infrastructure/secrets.js";
import type {
  PlaybackDescriptor,
  PlayerCapabilities,
} from "../../../../../packages/contracts/src/index.js";
export interface MediaRow {
  id: string;
  title: string;
  description: string;
  category_id: string | null;
  category: string | null;
  poster_asset_id: string | null;
  primary_source_id: string | null;
  content_generation: string;
  duration_seconds: number;
  publication_state: "DRAFT" | "PUBLISHED" | "WITHDRAWN";
  created_at: Date;
  cursor_created_at?: string;
  updated_at: Date;
  deleted_at: Date | null;
  kind: string | null;
  health: string | null;
  domain: string | null;
  personal_position: number | null;
  shared_position: number | null;
  pending: boolean;
  watched: boolean;
}
export interface SourceRow {
  id: string;
  media_id: string;
  kind: "local" | "http_file" | "hls" | "dash" | "drive";
  encrypted_reference: Ciphertext;
  connection_id: string | null;
  delivery_strategy: "direct" | "relay";
  health: string;
  content_fingerprint: string | null;
  capabilities_json: PlayerCapabilities;
  approved_origins_json: string[];
  safe_error_code: string | null;
}
export interface LocalReference {
  assetId: string;
  hlsAssetId?: string;
}
export interface UrlReference {
  url: string;
  domain: string;
  durationSeconds: number;
  bytes: number;
  mimeType: string;
  expiresAt?: string;
}
export const baseCapabilities: PlayerCapabilities = {
  seek: true,
  rate: true,
  qualitySelection: false,
  audioTrackSelection: false,
  subtitles: false,
  thumbnails: false,
  chapters: false,
};
export class LibraryService {
  onUnavailable: (mediaId: string) => Promise<void> = async () => {};
  constructor(
    public db: Database,
    public config: Config,
  ) {}
  async create(
    i: Identity,
    b: { title: string; description: string; category?: string | null },
    c?: Client,
  ) {
    let categoryId = null;
    if (b.category) {
      const [cat] = await this.db.query<{ id: string }>(
        "INSERT INTO categories(id,name,normalized_name) VALUES($1,$2,$3) ON CONFLICT(normalized_name) DO UPDATE SET name=excluded.name RETURNING id",
        [randomUUID(), b.category, b.category.toLowerCase()],
        c,
      );
      categoryId = cat.id;
    }
    const id = randomUUID();
    await this.db.query(
      "INSERT INTO media(id,title,description,category_id,content_generation,created_by) VALUES($1,$2,$3,$4,$5,$6)",
      [id, b.title, b.description, categoryId, randomUUID(), i.user.id],
      c,
    );
    return id;
  }
  view(m: MediaRow) {
    return {
      id: m.id,
      title: m.title,
      description: m.description,
      category: m.category,
      durationSeconds: m.duration_seconds,
      contentGeneration: m.content_generation,
      posterUrl: m.poster_asset_id
        ? `/media/assets/${m.poster_asset_id}`
        : null,
      publicationState: m.publication_state,
      sourceKind: m.kind,
      primarySourceId: m.primary_source_id,
      health: m.health ?? "UNCHECKED",
      personalPosition: m.personal_position ?? 0,
      sharedPosition: m.shared_position ?? 0,
      pending: !!m.pending,
      watched: !!m.watched,
      createdAt: m.created_at,
    };
  }
  private select = `SELECT m.*,to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at,c.name AS category,s.kind,s.health,up.position_seconds AS personal_position,sp.position_seconds AS shared_position,(w.media_id IS NOT NULL AND w.marked_watched_at IS NULL) AS pending,(w.marked_watched_at IS NOT NULL) AS watched FROM media m LEFT JOIN categories c ON c.id=m.category_id LEFT JOIN sources s ON s.id=m.primary_source_id LEFT JOIN user_progress up ON up.media_id=m.id AND up.content_generation=m.content_generation AND up.user_id=$1 LEFT JOIN shared_progress sp ON sp.media_id=m.id AND sp.content_generation=m.content_generation LEFT JOIN watchlist w ON w.media_id=m.id`;
  async get(id: string, i: Identity, c?: Client) {
    const [m] = await this.db.query<MediaRow>(
      this.select +
        " WHERE m.id=$2 AND m.deleted_at IS NULL AND ($3 OR m.publication_state='PUBLISHED')",
      [i.user.id, id, i.user.role === "OWNER"],
      c,
    );
    assert(m, "NOT_FOUND", 404);
    return m;
  }
  async published(id: string, c?: Client) {
    const [m] = await this.db.query<MediaRow>(
      "SELECT m.* FROM media m JOIN sources s ON s.id=m.primary_source_id WHERE m.id=$1 AND m.deleted_at IS NULL AND m.publication_state='PUBLISHED' AND s.health='READY'",
      [id],
      c,
    );
    assert(m, "MEDIA_UNAVAILABLE", 409);
    return m;
  }
  async list(
    i: Identity,
    b: {
      search?: string;
      category?: string;
      pending?: boolean;
      cursor?: string;
      limit?: number;
      sort?: string;
    },
    admin = false,
  ) {
    let after: string | null = null;
    let afterId: string | null = null;
    if (b.cursor) {
      try {
        const j = JSON.parse(Buffer.from(b.cursor, "base64url").toString());
        assert(
          typeof j.key === "string" && typeof j.id === "string",
          "INVALID_CURSOR",
        );
        after = j.key;
        afterId = j.id;
      } catch {
        assert(false, "INVALID_CURSOR");
      }
    }
    const byTitle = b.sort === "title";
    const limit = b.limit ?? 30;
    const rows = await this.db.query<MediaRow>(
      this.select +
        ` WHERE m.deleted_at IS NULL AND ($2 OR m.publication_state='PUBLISHED') AND ($3='' OR m.title ILIKE $3 OR m.description ILIKE $3 OR c.name ILIKE $3) AND ($4::text IS NULL OR c.name=$4) AND (NOT $5 OR (w.media_id IS NOT NULL AND w.marked_watched_at IS NULL)) AND ($6::text IS NULL OR ${byTitle ? "(m.title,m.id)>($6,$7::uuid)" : "(m.created_at,m.id)<($6::timestamptz,$7::uuid)"}) ORDER BY ${byTitle ? "m.title ASC,m.id ASC" : "m.created_at DESC,m.id DESC"} LIMIT $8`,
      [
        i.user.id,
        admin && i.user.role === "OWNER",
        b.search ? `%${b.search.replace(/[%_\\]/g, "\\$&")}%` : "",
        b.category ?? null,
        b.pending ?? false,
        after,
        afterId,
        limit + 1,
      ],
    );
    const page = rows.slice(0, limit),
      last = page.at(-1);
    return {
      items: page.map((m) => this.view(m)),
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify({
                key: byTitle ? last.title : last.cursor_created_at,
                id: last.id,
              }),
            ).toString("base64url")
          : null,
    };
  }
  async source(id: string, c?: Client) {
    const [s] = await this.db.query<SourceRow>(
      "SELECT * FROM sources WHERE id=$1",
      [id],
      c,
    );
    assert(s, "NOT_FOUND", 404);
    return s;
  }
  reference<T>(s: SourceRow) {
    return open<T>(
      s.encrypted_reference,
      this.config.masterKey,
      "source",
      s.id,
    );
  }
  async addSource(
    mediaId: string,
    kind: SourceRow["kind"],
    reference: unknown,
    capabilities = baseCapabilities,
    delivery: "direct" | "relay" = "relay",
    health = "READY",
    connectionId: string | null = null,
    origins: string[] = [],
    c?: Client,
  ) {
    const id = randomUUID();
    await this.db.query(
      "INSERT INTO sources(id,media_id,kind,encrypted_reference,delivery_strategy,health,capabilities_json,connection_id,last_checked_at,approved_origins_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now(),$9)",
      [
        id,
        mediaId,
        kind,
        seal(reference, this.config.masterKey, "source", id),
        delivery,
        health,
        capabilities,
        connectionId,
        JSON.stringify(origins),
      ],
      c,
    );
    await this.db.query(
      "UPDATE media SET primary_source_id=$1,updated_at=now() WHERE id=$2",
      [id, mediaId],
      c,
    );
    return id;
  }
  async localDescriptor(
    m: MediaRow,
    s: SourceRow,
  ): Promise<PlaybackDescriptor> {
    const ref = this.reference<LocalReference>(s);
    const subtitles = await this.db.query<{
      id: string;
      label: string;
      language_tag: string;
    }>("SELECT id,label,language_tag FROM subtitles WHERE media_id=$1", [m.id]);
    const chapters = await this.db.query(
      "SELECT 1 FROM chapters WHERE media_id=$1 LIMIT 1",
      [m.id],
    );
    const sprite = await this.db.query(
      "SELECT 1 FROM assets WHERE media_id=$1 AND kind='sprite' LIMIT 1",
      [m.id],
    );
    return {
      protocolVersion: 1,
      mediaId: m.id,
      sourceId: s.id,
      contentGeneration: m.content_generation,
      kind: ref.hlsAssetId ? "hls" : "file",
      delivery: "relay",
      url: ref.hlsAssetId
        ? `/media/local-hls/${s.id}/master.m3u8`
        : `/media/${s.id}/file`,
      expiresAt: null,
      durationSeconds: m.duration_seconds,
      mimeType: ref.hlsAssetId ? "application/vnd.apple.mpegurl" : "video/mp4",
      capabilities: {
        ...baseCapabilities,
        qualitySelection: !!ref.hlsAssetId,
        subtitles: !!subtitles.length,
        chapters: !!chapters.length,
        thumbnails: !!sprite.length,
      },
      tracks: subtitles.map((v) => ({
        id: v.id,
        kind: "subtitle",
        label: v.label,
        language: v.language_tag,
      })),
      approvedOrigins: [this.config.origin],
    };
  }
}

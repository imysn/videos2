import { OAuth2Client, type Credentials } from "google-auth-library";
import { google } from "googleapis";
import type { drive_v3 } from "googleapis";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import type { FastifyRequest, FastifyReply } from "fastify";
import type { Database } from "../../../../../packages/db/src/index.js";
import type { PlaybackDescriptor } from "../../../../../packages/contracts/src/index.js";
import type { Config } from "../../infrastructure/config.js";
import { privateFile } from "../../infrastructure/config.js";
import {
  seal,
  open,
  hash,
  token,
  type Ciphertext,
} from "../../infrastructure/secrets.js";
import { assert, AppError } from "../../infrastructure/errors.js";
import type { Identity } from "../auth/service.js";
import {
  LibraryService,
  baseCapabilities,
  type SourceRow,
} from "../library/service.js";
import { Streams } from "../media/streams.js";
import { parseRange } from "../media/storage.js";
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export interface DriveReference {
  fileId: string;
  version: string;
  bytes: number;
  mimeType: string;
  durationSeconds: number;
}
export interface Connection {
  id: string;
  encrypted_secrets: Ciphertext;
  status: string;
  authorized_at: Date | null;
  last_verified_at: Date | null;
}
export interface DriveClient {
  getAccessToken(): Promise<{ token?: string | null }>;
  setCredentials(c: Credentials): void;
  credentials: Credentials;
  revokeCredentials(): Promise<unknown>;
}
export interface DriveGateway {
  metadata(fileId: string): Promise<drive_v3.Schema$File>;
  bytes(
    fileId: string,
    range: string | undefined,
    signal?: AbortSignal,
  ): Promise<{
    status: number;
    headers: Record<string, string>;
    body: Readable;
  }>;
  client: DriveClient;
}
export class SingleFlight {
  private tasks = new Map<string, Promise<unknown>>();
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let p = this.tasks.get(key) as Promise<T> | undefined;
    if (!p) {
      p = fn().finally(() => this.tasks.delete(key));
      this.tasks.set(key, p);
    }
    return p;
  }
}
export class Drive {
  readonly refresh = new SingleFlight();
  private active = new Map<string, Set<AbortController>>();
  gatewayFactory?: (
    connection: Connection,
    credentials: Credentials,
  ) => DriveGateway;
  constructor(
    public db: Database,
    public config: Config,
    public library: LibraryService,
    public streams: Streams,
  ) {}
  oauth() {
    assert(this.config.googleConfigured, "DRIVE_NOT_CONFIGURED", 409);
    return new OAuth2Client({
      clientId: this.config.GOOGLE_CLIENT_ID,
      clientSecret: privateFile(this.config.GOOGLE_CLIENT_SECRET_FILE),
      redirectUri:
        this.config.GOOGLE_REDIRECT_URI ??
        `${this.config.origin}/api/v1/admin/drive/callback`,
    });
  }
  async status() {
    const [c] = await this.db.query<Connection>(
      "SELECT * FROM provider_connections WHERE provider='drive' LIMIT 1",
    );
    return {
      implemented: true,
      configured: this.config.googleConfigured,
      authorized: c?.status === "authorized",
      authorizedAt: c?.authorized_at ?? null,
      liveVerifiedAt: c?.last_verified_at ?? null,
      safeErrorCode: c?.status === "revoked" ? "SOURCE_AUTH_REQUIRED" : null,
    };
  }
  async connection() {
    const [c] = await this.db.query<Connection>(
      "SELECT * FROM provider_connections WHERE provider='drive' AND status='authorized' LIMIT 1",
    );
    assert(c, "SOURCE_AUTH_REQUIRED", 409);
    return c;
  }
  async connect(i: Identity) {
    const state = token();
    await this.db.query(
      "INSERT INTO oauth_states(id,state_hash,auth_session_id,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')",
      [randomUUID(), hash(state), i.session.id],
    );
    return this.oauth().generateAuthUrl({
      access_type: "offline",
      scope: [DRIVE_SCOPE],
      state,
      prompt: "consent",
      include_granted_scopes: false,
    });
  }
  async consumeState(i: Identity, state: string) {
    const [s] = await this.db.query<{ id: string }>(
      "UPDATE oauth_states SET used_at=now() WHERE state_hash=$1 AND auth_session_id=$2 AND used_at IS NULL AND expires_at>now() RETURNING id",
      [hash(state), i.session.id],
    );
    assert(s && i.user.role === "OWNER", "INVALID_OAUTH_STATE", 403);
  }
  async callback(i: Identity, state: string, code: string) {
    await this.consumeState(i, state);
    const client = this.oauth();
    const { tokens } = await client.getToken({
      code,
      redirect_uri:
        this.config.GOOGLE_REDIRECT_URI ??
        `${this.config.origin}/api/v1/admin/drive/callback`,
    });
    const scopes = (tokens.scope ?? "").split(" ");
    assert(
      scopes.includes(DRIVE_SCOPE) &&
        !scopes.some(
          (s) =>
            s === "https://www.googleapis.com/auth/drive" ||
            s === "https://www.googleapis.com/auth/drive.readonly",
        ),
      "OAUTH_SCOPE_REJECTED",
      403,
    );
    const [old] = await this.db.query<Connection>(
      "SELECT * FROM provider_connections WHERE provider='drive' AND owner_id=$1",
      [i.user.id],
    );
    const oldTokens = old
      ? open<Credentials>(
          old.encrypted_secrets,
          this.config.masterKey,
          "provider",
          old.id,
        )
      : {};
    const credentials = {
      ...tokens,
      refresh_token: tokens.refresh_token ?? oldTokens.refresh_token,
    };
    assert(credentials.refresh_token, "OFFLINE_ACCESS_REQUIRED", 409);
    const id = old?.id ?? randomUUID();
    await this.db.query(
      "INSERT INTO provider_connections(id,provider,owner_id,encrypted_secrets,status,scopes_json,authorized_at) VALUES($1,'drive',$2,$3,'authorized',$4,now()) ON CONFLICT(provider,owner_id) DO UPDATE SET encrypted_secrets=excluded.encrypted_secrets,status='authorized',scopes_json=excluded.scopes_json,authorized_at=now(),safe_error_code=NULL",
      [
        id,
        i.user.id,
        seal(credentials, this.config.masterKey, "provider", id),
        JSON.stringify(scopes),
      ],
    );
  }
  async gateway(): Promise<{ gateway: DriveGateway; connection: Connection }> {
    const connection = await this.connection();
    const credentials = open<Credentials>(
      connection.encrypted_secrets,
      this.config.masterKey,
      "provider",
      connection.id,
    );
    let gateway: DriveGateway;
    if (this.gatewayFactory)
      gateway = this.gatewayFactory(connection, credentials);
    else {
      const client = this.oauth();
      client.setCredentials(credentials);
      const api = google.drive({ version: "v3", auth: client });
      gateway = {
        client,
        metadata: async (fileId) =>
          (
            await api.files.get(
              {
                fileId,
                fields:
                  "id,name,mimeType,size,version,modifiedTime,capabilities(canDownload),videoMediaMetadata(durationMillis,width,height)",
              },
              { timeout: 20000 },
            )
          ).data,
        bytes: async (fileId, range, signal) => {
          const result = await api.files.get(
            { fileId, alt: "media" },
            {
              responseType: "stream",
              headers: range ? { Range: range } : {},
              timeout: 30000,
              signal,
            },
          );
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(result.headers))
            if (v !== undefined)
              headers[k] = Array.isArray(v) ? v.join(",") : String(v);
          return {
            status: result.status,
            headers,
            body: result.data as unknown as Readable,
          };
        },
      };
    }
    await this.refresh.run(connection.id, async () => {
      try {
        await gateway.client.getAccessToken();
        await this.db.query(
          "UPDATE provider_connections SET encrypted_secrets=$1 WHERE id=$2 AND status=$3",
          [
            seal(
              gateway.client.credentials,
              this.config.masterKey,
              "provider",
              connection.id,
            ),
            connection.id,
            "authorized",
          ],
        );
      } catch (error) {
        const response = (
          error as { response?: { status?: number; data?: { error?: string } } }
        ).response;
        if (
          response?.status !== 401 &&
          response?.data?.error !== "invalid_grant"
        )
          throw new AppError("SOURCE_UNAVAILABLE", 502);
        await this.db.query(
          "UPDATE provider_connections SET status='revoked',safe_error_code='SOURCE_AUTH_REQUIRED' WHERE id=$1",
          [connection.id],
        );
        throw new AppError("SOURCE_AUTH_REQUIRED", 409);
      }
    });
    const current = await this.connection();
    gateway.client.setCredentials(
      open<Credentials>(
        current.encrypted_secrets,
        this.config.masterKey,
        "provider",
        current.id,
      ),
    );
    return { gateway, connection };
  }
  async bounded<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await operation();
      } catch (e) {
        const value = e as { response?: { status?: number }; code?: number };
        const status = value.response?.status ?? value.code;
        if (status === 429 || (typeof status === "number" && status >= 500)) {
          if (attempt < 2) {
            await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
            continue;
          }
          throw new AppError("DRIVE_QUOTA", 429);
        }
        if (status === 401) throw new AppError("SOURCE_AUTH_REQUIRED", 409);
        if (status === 403) throw new AppError("SOURCE_AUTH_REQUIRED", 409);
        if (status === 404) throw new AppError("SOURCE_UNAVAILABLE", 409);
        throw e instanceof AppError
          ? e
          : new AppError("SOURCE_UNAVAILABLE", 502);
      }
    }
    throw new AppError("SOURCE_UNAVAILABLE", 502);
  }
  async metadata(gateway: DriveGateway, fileId: string) {
    assert(/^[A-Za-z0-9_-]{10,200}$/.test(fileId), "INVALID_DRIVE_FILE");
    const file = await this.bounded(() => gateway.metadata(fileId));
    assert(
      file.capabilities?.canDownload && file.mimeType?.startsWith("video/"),
      "SOURCE_UNSUPPORTED",
      409,
    );
    const duration = Number(file.videoMediaMetadata?.durationMillis) / 1000;
    assert(
      Number.isFinite(duration) &&
        duration > 0 &&
        Number.isSafeInteger(Number(file.size)),
      "SOURCE_UNSUPPORTED",
      409,
    );
    return file;
  }
  async prepareImports(fileIds: string[]) {
    const { gateway, connection } = await this.gateway();
    const files: drive_v3.Schema$File[] = [];
    for (const fileId of fileIds)
      files.push(await this.metadata(gateway, fileId));
    return { connectionId: connection.id, files };
  }
  async importFiles(
    i: Identity,
    fileIds: string[],
    prepared?: Awaited<ReturnType<Drive["prepareImports"]>>,
  ) {
    const { connectionId, files } =
      prepared ?? (await this.prepareImports(fileIds));
    const ids: string[] = [];
    for (const [index, fileId] of fileIds.entries()) {
      const m = files[index];
      const ref: DriveReference = {
        fileId,
        version: m.version ?? m.modifiedTime ?? "",
        bytes: Number(m.size),
        mimeType: m.mimeType!,
        durationSeconds: Number(m.videoMediaMetadata!.durationMillis) / 1000,
      };
      const id = await this.library.create(i, {
        title: m.name ?? "Vídeo de Drive",
        description: "",
      });
      await this.library.addSource(
        id,
        "drive",
        ref,
        baseCapabilities,
        "relay",
        "READY",
        connectionId,
      );
      await this.db.query("UPDATE media SET duration_seconds=$1 WHERE id=$2", [
        ref.durationSeconds,
        id,
      ]);
      ids.push(id);
    }
    return ids;
  }
  async verifyIdentity(
    s: SourceRow,
    ref: DriveReference,
    file: drive_v3.Schema$File,
  ) {
    if (
      (file.version ?? file.modifiedTime ?? "") !== ref.version ||
      Number(file.size) !== ref.bytes ||
      Math.abs(
        Number(file.videoMediaMetadata!.durationMillis) / 1000 -
          ref.durationSeconds,
      ) > 1
    ) {
      await this.db.query(
        "UPDATE sources SET health='ERROR',safe_error_code='CONTENT_IDENTITY_MISMATCH' WHERE id=$1",
        [s.id],
      );
      await this.library.onUnavailable(s.media_id);
      throw new AppError("CONTENT_IDENTITY_MISMATCH", 409);
    }
  }
  async descriptor(mediaId: string, i: Identity): Promise<PlaybackDescriptor> {
    const m = await this.library.get(mediaId, i);
    assert(m.primary_source_id, "MEDIA_UNAVAILABLE", 409);
    const s = await this.library.source(m.primary_source_id);
    assert(s.kind === "drive", "SOURCE_UNSUPPORTED", 409);
    try {
      const ref = this.library.reference<DriveReference>(s),
        { gateway } = await this.gateway();
      const file = await this.metadata(gateway, ref.fileId);
      await this.verifyIdentity(s, ref, file);
      return {
        protocolVersion: 1,
        mediaId: m.id,
        sourceId: s.id,
        contentGeneration: m.content_generation,
        kind: "file",
        delivery: "relay",
        url: `/media/${s.id}/file`,
        expiresAt: null,
        durationSeconds: m.duration_seconds,
        mimeType: ref.mimeType,
        capabilities: baseCapabilities,
        tracks: [],
        approvedOrigins: [this.config.origin],
      };
    } catch (e) {
      await this.sourceFailure(s, e);
      throw e;
    }
  }
  private async sourceFailure(s: SourceRow, error: unknown) {
    if (
      !(error instanceof AppError) ||
      ![
        "SOURCE_AUTH_REQUIRED",
        "SOURCE_UNAVAILABLE",
        "CONTENT_IDENTITY_MISMATCH",
      ].includes(error.code)
    )
      return;
    const health =
      error.code === "SOURCE_AUTH_REQUIRED"
        ? "AUTH_REQUIRED"
        : error.code === "CONTENT_IDENTITY_MISMATCH"
          ? "ERROR"
          : "UNAVAILABLE";
    await this.db.query(
      "UPDATE sources SET health=$1,safe_error_code=$2 WHERE id=$3",
      [health, error.code, s.id],
    );
    await this.library.onUnavailable(s.media_id);
    if (s.connection_id)
      for (const controller of this.active.get(s.connection_id) ?? [])
        controller.abort();
  }
  async stream(
    sourceId: string,
    i: Identity,
    r: FastifyRequest,
    p: FastifyReply,
  ) {
    const s = await this.library.source(sourceId);
    try {
      const ref = this.library.reference<DriveReference>(s),
        { gateway, connection } = await this.gateway();
      await this.verifyIdentity(
        s,
        ref,
        await this.metadata(gateway, ref.fileId),
      );
      let requested;
      try {
        requested = parseRange(r.headers.range, ref.bytes);
      } catch (error) {
        p.header("Content-Range", `bytes */${ref.bytes}`);
        throw error;
      }
      const range = requested.partial
        ? `bytes=${requested.start}-${requested.end}`
        : undefined;
      if (r.method === "HEAD") {
        p.code(requested.partial ? 206 : 200)
          .header("Cache-Control", "private, no-store")
          .header("Accept-Ranges", "bytes")
          .header("Content-Type", ref.mimeType)
          .header("Content-Length", requested.end - requested.start + 1);
        if (requested.partial)
          p.header(
            "Content-Range",
            `bytes ${requested.start}-${requested.end}/${ref.bytes}`,
          );
        return p.send();
      }
      const controller = this.streams.register(i, r, p);
      let active = this.active.get(connection.id);
      if (!active) {
        active = new Set();
        this.active.set(connection.id, active);
      }
      active.add(controller);
      controller.signal.addEventListener(
        "abort",
        () => {
          active!.delete(controller);
          if (!active!.size) this.active.delete(connection.id);
        },
        { once: true },
      );
      const result = await this.bounded(() =>
        gateway.bytes(ref.fileId, range, controller.signal),
      );
      try {
        assert(
          result.status === (range ? 206 : 200),
          "SOURCE_NOT_SEEKABLE",
          502,
        );
        if (range)
          assert(
            result.headers["content-range"] ===
              `bytes ${requested.start}-${requested.end}/${ref.bytes}`,
            "CONTENT_IDENTITY_MISMATCH",
            409,
          );
        assert(
          Number(result.headers["content-length"]) ===
            requested.end - requested.start + 1,
          "CONTENT_IDENTITY_MISMATCH",
          409,
        );
      } catch (error) {
        result.body.destroy();
        controller.abort();
        throw error;
      }
      p.code(result.status).header("Cache-Control", "private, no-store");
      for (const key of [
        "content-type",
        "content-length",
        "content-range",
        "accept-ranges",
      ])
        if (result.headers[key]) p.header(key, result.headers[key]);
      result.body.setMaxListeners(20);
      controller.signal.addEventListener("abort", () => result.body.destroy(), {
        once: true,
      });
      result.body.once("end", () => {
        if (!this.gatewayFactory)
          void this.db.query(
            "UPDATE provider_connections SET last_verified_at=now() WHERE id=$1",
            [connection.id],
          );
      });
      return p.send(result.body);
    } catch (e) {
      await this.sourceFailure(s, e);
      throw e;
    }
  }
  async revoke() {
    const c = await this.connection();
    // Local denial must succeed even if Google is unavailable or already revoked.
    let gateway: DriveGateway | undefined;
    try {
      gateway = (await this.gateway()).gateway;
    } catch {
      /* Revoke local access below. */
    }
    await this.db.query(
      "UPDATE provider_connections SET encrypted_secrets=$1,status='revoked',safe_error_code='SOURCE_AUTH_REQUIRED' WHERE id=$2",
      [seal({}, this.config.masterKey, "provider", c.id), c.id],
    );
    const sources = await this.db.query<SourceRow>(
      "UPDATE sources SET health='AUTH_REQUIRED',safe_error_code='SOURCE_AUTH_REQUIRED' WHERE connection_id=$1 RETURNING *",
      [c.id],
    );
    for (const s of sources) await this.library.onUnavailable(s.media_id);
    for (const controller of this.active.get(c.id) ?? []) controller.abort();
    let remoteRevoked = false;
    if (gateway) {
      try {
        await this.bounded(() => gateway!.client.revokeCredentials());
        remoteRevoked = true;
      } catch {
        /* Report remote revocation separately; local credentials are erased. */
      }
    }
    return { ok: true, remoteRevoked };
  }
}

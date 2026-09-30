import { createReadStream } from "node:fs";
import { stat, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { FastifyRequest, FastifyReply } from "fastify";
import type { AuthService, Identity } from "../auth/service.js";
import { assert, AppError } from "../../infrastructure/errors.js";
import { existingPath, parseRange } from "./storage.js";
export class Streams {
  private active = new Map<string, Set<AbortController>>();
  constructor(public auth: AuthService) {}
  revoke(ids: string[]) {
    for (const id of ids) {
      for (const c of this.active.get(id) ?? []) c.abort();
      this.active.delete(id);
    }
  }
  register(i: Identity, r: FastifyRequest, p: FastifyReply) {
    let set = this.active.get(i.session.id);
    if (!set) {
      set = new Set();
      this.active.set(i.session.id, set);
    }
    assert(set.size < 4, "STREAM_LIMIT", 429);
    const c = new AbortController();
    set.add(c);
    const timer = setInterval(() => {
      void this.auth.db
        .query(
          "SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.revoked_at IS NULL AND s.absolute_expires_at>now() AND u.disabled_at IS NULL",
          [i.session.id],
        )
        .then((rows) => {
          if (!rows.length) c.abort();
        })
        .catch(() => c.abort());
    }, 1000);
    const cleanup = () => {
      clearInterval(timer);
      set!.delete(c);
      if (!set!.size) this.active.delete(i.session.id);
      c.abort();
    };
    p.raw.once("close", cleanup);
    r.raw.once("aborted", cleanup);
    return c;
  }
  async file(
    path: string,
    mime: string,
    i: Identity,
    r: FastifyRequest,
    p: FastifyReply,
  ) {
    const size = (await stat(path)).size;
    let range;
    try {
      range = parseRange(r.headers.range, size);
    } catch (e) {
      p.header("Content-Range", `bytes */${size}`);
      throw e;
    }
    p.header("Accept-Ranges", "bytes")
      .header("Cache-Control", "private, no-store")
      .header("Content-Type", mime)
      .header(
        "Content-Length",
        range.partial ? range.end - range.start + 1 : size,
      );
    if (range.partial)
      p.code(206).header(
        "Content-Range",
        `bytes ${range.start}-${range.end}/${size}`,
      );
    if (r.method === "HEAD") return p.send();
    const c = this.register(i, r, p);
    return p.send(
      createReadStream(path, {
        start: range.start,
        ...(size ? { end: range.end } : {}),
        signal: c.signal,
      }),
    );
  }
  async authorizedAsset(id: string, i: Identity) {
    const [a] = await this.auth.db.query<{
      storage_key: string;
      mime_type: string;
      kind: string;
      metadata_json: Record<string, unknown>;
      publication_state: string | null;
      deleted_at: Date | null;
    }>(
      "SELECT a.*,m.publication_state,m.deleted_at FROM assets a LEFT JOIN media m ON m.id=a.media_id WHERE a.id=$1 AND a.state=$2",
      [id, "READY"],
    );
    assert(a, "NOT_FOUND", 404);
    if (a.kind === "avatar")
      assert(
        a.metadata_json.ownerId === i.user.id || i.user.role === "OWNER",
        "FORBIDDEN",
        403,
      );
    else {
      assert(
        !a.deleted_at &&
          (i.user.role === "OWNER" || a.publication_state === "PUBLISHED"),
        "NOT_FOUND",
        404,
      );
      assert(
        a.kind !== "original" || i.user.role === "OWNER",
        "FORBIDDEN",
        403,
      );
    }
    return a;
  }
  async asset(id: string, i: Identity, r: FastifyRequest, p: FastifyReply) {
    const a = await this.authorizedAsset(id, i);
    const path = await existingPath(this.auth.config.DATA_ROOT, a.storage_key);
    return this.file(path, a.mime_type, i, r, p);
  }
  async hlsPath(assetId: string, name: string, i: Identity) {
    const a = await this.authorizedAsset(assetId, i);
    assert(a.kind === "hls", "NOT_FOUND", 404);
    const files = a.metadata_json.files as Record<string, number>;
    assert(
      typeof files?.[name] === "number" && !name.split("/").includes(".."),
      "NOT_FOUND",
      404,
    );
    const path = await existingPath(
      this.auth.config.DATA_ROOT,
      resolve(dirname(a.storage_key), name).replace(
        this.auth.config.DATA_ROOT + "/",
        "",
      ),
    );
    return path;
  }
  async playlist(
    assetId: string,
    name: string,
    i: Identity,
    r: FastifyRequest,
    p: FastifyReply,
  ) {
    const a = await this.authorizedAsset(assetId, i);
    const files = a.metadata_json.files as Record<string, number>;
    assert(typeof files?.[name] === "number", "NOT_FOUND", 404);
    const root = dirname(a.storage_key);
    const file = await existingPath(
      this.auth.config.DATA_ROOT,
      `${root}/${name}`,
    );
    if (name.endsWith(".m3u8")) {
      p.header("Cache-Control", "private, no-store").type(
        "application/vnd.apple.mpegurl",
      );
      return p.send(r.method === "HEAD" ? "" : await readFile(file, "utf8"));
    }
    const mime = name.endsWith(".mp4")
      ? "video/mp4"
      : name.endsWith(".m4s")
        ? "video/iso.segment"
        : "application/octet-stream";
    return this.file(file, mime, i, r, p);
  }
  unavailable() {
    throw new AppError("MEDIA_UNAVAILABLE", 409);
  }
}

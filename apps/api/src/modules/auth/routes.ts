import { z } from "zod";
import {
  password,
  preferencesSchema,
  uuid,
} from "../../../../../packages/contracts/src/index.js";
import { Http } from "../../infrastructure/http.js";
import { Limiter } from "../../infrastructure/limits.js";
import { assert } from "../../infrastructure/errors.js";
import type { User } from "./service.js";
export function authRoutes(h: Http) {
  const empty = z.strictObject({}),
    limits = new Limiter(),
    db = h.auth.db;
  h.route(
    "POST",
    "/api/v1/auth/login",
    z.strictObject({
      username: z.string().min(1).max(64),
      password: z.string().min(1).max(128),
    }),
    "public",
    async (b, _i, r, p) => {
      limits.check(`ip:${r.ip}`, 30, 60000);
      limits.check(`login:${r.ip}:${b.username.toLowerCase()}`, 5, 60000);
      const s = await h.auth.login(
        b.username,
        b.password,
        r.headers["user-agent"] ?? "Navegador",
      );
      h.cookie(p, s.raw);
      return { ...h.auth.profile(s.identity.user), csrf: s.identity.csrf };
    },
  );
  h.route("GET", "/api/v1/auth/me", empty, "user", async (_b, i) => ({
    ...h.auth.profile(i.user),
    csrf: i.csrf,
  }));
  h.route(
    "POST",
    "/api/v1/auth/logout",
    empty,
    "user",
    async (_b, i, _r, p) => {
      await h.auth.revokeSession(i.session.id, i.user.id);
      p.clearCookie(h.auth.config.cookieName, { path: "/" });
      return { ok: true };
    },
  );
  h.route(
    "POST",
    "/api/v1/auth/reauth",
    z.strictObject({ password }),
    "user",
    async (b, i) => {
      limits.check(`reauth:${i.user.id}`, 5, 60000);
      await h.auth.reauth(i, b.password);
      return { ok: true };
    },
  );
  h.route(
    "POST",
    "/api/v1/auth/reset/consume",
    z.strictObject({ token: z.string().min(32).max(128), password }),
    "public",
    async (b, _i, r, p) => {
      limits.check(`reset:${r.ip}`, 10, 60000);
      const s = await h.auth.consumeReset(b.token, b.password);
      h.cookie(p, s.raw);
      return { ...h.auth.profile(s.identity.user), csrf: s.identity.csrf };
    },
  );
  h.route(
    "PATCH",
    "/api/v1/account",
    z.strictObject({
      displayName: z.string().trim().min(1).max(60).optional(),
      preferences: preferencesSchema.optional(),
      avatarAssetId: uuid.nullable().optional(),
    }),
    "user",
    async (b, i) => {
      if (b.avatarAssetId)
        assert(
          (
            await db.query(
              "SELECT 1 FROM assets WHERE id=$1 AND kind=$2 AND metadata_json->>'ownerId'=$3",
              [b.avatarAssetId, "avatar", i.user.id],
            )
          ).length,
          "INVALID_ASSET",
          403,
        );
      const [u] = await db.query<User>(
        "UPDATE users SET display_name=coalesce($1,display_name),preferences_json=preferences_json || $2::jsonb,avatar_asset_id=CASE WHEN $3 THEN $4::uuid ELSE avatar_asset_id END WHERE id=$5 RETURNING *",
        [
          b.displayName ?? null,
          JSON.stringify(b.preferences ?? {}),
          b.avatarAssetId !== undefined,
          b.avatarAssetId ?? null,
          i.user.id,
        ],
      );
      return h.auth.profile(u);
    },
  );
  h.route(
    "POST",
    "/api/v1/account/password",
    z.strictObject({ password }),
    "recent",
    async (b, i, _r, p) => {
      const s = await h.auth.changePassword(i, b.password);
      h.cookie(p, s.raw);
      return { ...h.auth.profile(s.identity.user), csrf: s.identity.csrf };
    },
  );
  h.route("GET", "/api/v1/account/sessions", empty, "user", async (_b, i) =>
    db.query(
      "SELECT id,created_at,last_seen_at,device_label,absolute_expires_at,(id=$2) AS current FROM sessions WHERE user_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC",
      [i.user.id, i.session.id],
    ),
  );
  h.route(
    "DELETE",
    "/api/v1/account/sessions/:id",
    empty,
    "user",
    async (_b, i, r) => {
      const id = uuid.parse((r.params as { id: string }).id);
      await h.auth.revokeSession(id, i.user.id);
      return { ok: true };
    },
  );
  h.route("GET", "/api/v1/admin/accounts", empty, "owner", async () =>
    (await db.query<User>("SELECT * FROM users ORDER BY slot")).map((u) => ({
      ...h.auth.profile(u),
      disabled: !!u.disabled_at,
    })),
  );
  h.route(
    "PATCH",
    "/api/v1/admin/accounts/:id",
    z.strictObject({
      displayName: z.string().trim().min(1).max(60).optional(),
      disabled: z.boolean().optional(),
    }),
    "owner-recent",
    async (b, _i, r) => {
      const id = uuid.parse((r.params as { id: string }).id);
      const [u] = await db.query<User>("SELECT * FROM users WHERE id=$1", [id]);
      assert(u, "NOT_FOUND", 404);
      assert(!(u.role === "OWNER" && b.disabled), "LAST_OWNER_REQUIRED", 400);
      await db.query(
        "UPDATE users SET display_name=coalesce($1,display_name),disabled_at=CASE WHEN $2::boolean IS NULL THEN disabled_at WHEN $2 THEN now() ELSE NULL END WHERE id=$3",
        [b.displayName ?? null, b.disabled ?? null, id],
      );
      if (b.disabled) await h.auth.revokeUser(id);
      return { ok: true };
    },
  );
  h.route(
    "POST",
    "/api/v1/admin/accounts/:id/reset",
    empty,
    "owner-recent",
    async (_b, _i, r) => {
      const id = uuid.parse((r.params as { id: string }).id);
      assert(
        (await db.query("SELECT 1 FROM users WHERE id=$1", [id])).length,
        "NOT_FOUND",
        404,
      );
      const t = await h.auth.reset(id);
      return {
        activationUrl: `${h.auth.config.origin}/activate#${t}`,
        expiresInSeconds: 1800,
      };
    },
  );
  h.route(
    "POST",
    "/api/v1/admin/accounts/:id/revoke-sessions",
    empty,
    "owner-recent",
    async (_b, _i, r) => {
      await h.auth.revokeUser(uuid.parse((r.params as { id: string }).id));
      return { ok: true };
    },
  );
}

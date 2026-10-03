import argon2 from "argon2";
import { randomUUID, createHmac } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Database, Client } from "../../../../../packages/db/src/index.js";
import type { Config } from "../../infrastructure/config.js";
import { hash, token, same } from "../../infrastructure/secrets.js";
import { assert, AppError } from "../../infrastructure/errors.js";
import { accountLocale } from "../../../../../packages/contracts/src/locale.js";
export interface User {
  id: string;
  slot: "owner" | "partner";
  username: string;
  display_name: string;
  role: "OWNER" | "PARTNER";
  password_hash: string;
  must_change_password: boolean;
  disabled_at: Date | null;
  avatar_asset_id: string | null;
  preferences_json: Record<string, unknown>;
}
export interface Session {
  id: string;
  user_id: string;
  token_hash: string;
  csrf_hash: string;
  created_at: Date;
  last_seen_at: Date;
  absolute_expires_at: Date;
  revoked_at: Date | null;
  auth_time: Date;
  device_label: string;
}
export interface Identity {
  user: User;
  session: Session;
  csrf: string;
}
export const passwordHash = (p: string) =>
  argon2.hash(p, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
export class AuthService {
  onRevoke: (ids: string[]) => Promise<void> = async () => {};
  private dummyHash: Promise<string> = passwordHash(token());
  constructor(
    public db: Database,
    public config: Config,
  ) {}
  csrf(raw: string) {
    return createHmac("sha256", this.config.masterKey)
      .update(`csrf:${raw}`)
      .digest("base64url");
  }
  profile(u: User) {
    return {
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      role: u.role,
      mustChangePassword: u.must_change_password,
      avatarAssetId: u.avatar_asset_id,
      preferences: {
        ...u.preferences_json,
        locale: accountLocale(u.role, u.preferences_json.locale),
      },
    };
  }
  async bootstrap(credentialsFile: string) {
    const created = await this.db.transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(173003)");
      const result: Record<string, string> = {};
      for (const slot of ["owner", "partner"] as const) {
        const old = await this.db.query<User>(
          "SELECT * FROM users WHERE slot=$1",
          [slot],
          c,
        );
        if (old.length) continue;
        const pw = token();
        const username = slot === "owner" ? "jason" : "pareja";
        await c.query(
          "INSERT INTO users(id,slot,username,display_name,role,password_hash) VALUES($1,$2,$3,$4,$5,$6)",
          [
            randomUUID(),
            slot,
            username,
            slot === "owner" ? "Jason" : "Mi pareja",
            slot === "owner" ? "OWNER" : "PARTNER",
            await passwordHash(pw),
          ],
        );
        result[username] = pw;
      }
      await c.query(
        "INSERT INTO rooms(id,singleton_key) VALUES($1,'home') ON CONFLICT(singleton_key) DO NOTHING",
        [randomUUID()],
      );
      return result;
    });
    if (Object.keys(created).length) {
      await mkdir(dirname(credentialsFile), { recursive: true, mode: 0o700 });
      await writeFile(credentialsFile, JSON.stringify(created, null, 2), {
        mode: 0o600,
        flag: "wx",
      });
    }
    return Object.keys(created).length;
  }
  async issue(user: User, label: string, c?: Client) {
    const raw = token();
    const csrf = this.csrf(raw);
    const [s] = await this.db.query<Session>(
      "INSERT INTO sessions(id,user_id,token_hash,csrf_hash,absolute_expires_at,device_label) VALUES($1,$2,$3,$4,now()+interval '30 days',$5) RETURNING *",
      [randomUUID(), user.id, hash(raw), hash(csrf), label.slice(0, 100)],
      c,
    );
    return { raw, identity: { user, session: s, csrf } };
  }
  async login(username: string, password: string, label: string) {
    const [u] = await this.db.query<User>(
      "SELECT * FROM users WHERE username=$1",
      [username.toLowerCase()],
    );
    const valid = await argon2.verify(
      u?.password_hash ?? (await this.dummyHash),
      password,
    );
    assert(u && valid && !u.disabled_at, "INVALID_CREDENTIALS", 401);
    return this.issue(u, label);
  }
  async authenticate(raw?: string): Promise<Identity> {
    assert(raw, "AUTH_REQUIRED", 401);
    const [s] = await this.db.query<Session>(
      "SELECT * FROM sessions WHERE token_hash=$1 AND revoked_at IS NULL AND absolute_expires_at>now() AND last_seen_at>now()-interval '7 days'",
      [hash(raw)],
    );
    assert(s, "AUTH_REQUIRED", 401);
    const [u] = await this.db.query<User>(
      "SELECT * FROM users WHERE id=$1 AND disabled_at IS NULL",
      [s.user_id],
    );
    assert(u, "ACCESS_REVOKED", 401);
    if (Date.now() - new Date(s.last_seen_at).getTime() > 60000)
      await this.db.query(
        "UPDATE sessions SET last_seen_at=now() WHERE id=$1",
        [s.id],
      );
    return { user: u, session: s, csrf: this.csrf(raw) };
  }
  checkCsrf(i: Identity, value: unknown) {
    assert(
      typeof value === "string" && same(hash(value), i.session.csrf_hash),
      "CSRF_REJECTED",
      403,
    );
  }
  recent(i: Identity) {
    assert(
      Date.now() - new Date(i.session.auth_time).getTime() < 600000,
      "REAUTH_REQUIRED",
      403,
    );
  }
  async reauth(i: Identity, pw: string) {
    assert(
      await argon2.verify(i.user.password_hash, pw),
      "INVALID_CREDENTIALS",
      401,
    );
    await this.db.query("UPDATE sessions SET auth_time=now() WHERE id=$1", [
      i.session.id,
    ]);
  }
  async revokeUser(userId: string) {
    const rows = await this.db.query<{ id: string }>(
      "UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL RETURNING id",
      [userId],
    );
    await this.db.query(
      "UPDATE playback_leases SET revoked_at=now() WHERE user_id=$1",
      [userId],
    );
    await this.db.afterCommit(() => this.onRevoke(rows.map((v) => v.id)));
  }
  async revokeSession(id: string, userId: string) {
    const rows = await this.db.query<{ id: string }>(
      "UPDATE sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2 RETURNING id",
      [id, userId],
    );
    assert(rows.length, "NOT_FOUND", 404);
    await this.db.query(
      "UPDATE playback_leases SET revoked_at=now() WHERE auth_session_id=$1",
      [id],
    );
    await this.db.afterCommit(() => this.onRevoke([id]));
  }
  async changePassword(i: Identity, pw: string) {
    this.recent(i);
    const newHash = await passwordHash(pw);
    return this.db.transaction(async () => {
      await this.revokeUser(i.user.id);
      const [u] = await this.db.query<User>(
        "UPDATE users SET password_hash=$1,must_change_password=false WHERE id=$2 RETURNING *",
        [newHash, i.user.id],
      );
      return this.issue(u, i.session.device_label);
    });
  }
  async reset(userId: string) {
    const raw = token();
    await this.db.transaction(async (c) => {
      await c.query(
        "UPDATE reset_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL",
        [userId],
      );
      await c.query(
        "INSERT INTO reset_tokens(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '30 minutes')",
        [randomUUID(), userId, hash(raw)],
      );
    });
    return raw;
  }
  async consumeReset(raw: string, pw: string) {
    const newHash = await passwordHash(pw);
    const user = await this.db.transaction(async (c) => {
      const [t] = await this.db.query<{ user_id: string }>(
        "UPDATE reset_tokens SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() RETURNING user_id",
        [hash(raw)],
        c,
      );
      assert(t, "INVALID_RESET", 400);
      const [u] = await this.db.query<User>(
        "UPDATE users SET password_hash=$1,must_change_password=false WHERE id=$2 AND disabled_at IS NULL RETURNING *",
        [newHash, t.user_id],
        c,
      );
      assert(u, "ACCESS_REVOKED", 403);
      await c.query("UPDATE sessions SET revoked_at=now() WHERE user_id=$1", [
        u.id,
      ]);
      await c.query(
        "UPDATE playback_leases SET revoked_at=now() WHERE user_id=$1",
        [u.id],
      );
      return u;
    });
    const ids = await this.db.query<{ id: string }>(
      "SELECT id FROM sessions WHERE user_id=$1",
      [user.id],
    );
    await this.db.afterCommit(() => this.onRevoke(ids.map((v) => v.id)));
    return this.issue(user, "PASSWORD_RESET");
  }
  async assertOwner(i: Identity) {
    if (i.user.role !== "OWNER") throw new AppError("FORBIDDEN", 403);
  }
}

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database } from "../../../../../packages/db/src/index.js";
import type {
  ChatSend,
  ChatMessage,
} from "../../../../../packages/contracts/src/index.js";
import type { Identity } from "../auth/service.js";
import { assert } from "../../infrastructure/errors.js";
import { Limiter } from "../../infrastructure/limits.js";
import { Http } from "../../infrastructure/http.js";
import { uuid } from "../../../../../packages/contracts/src/index.js";
interface MessageRow {
  id: string;
  room_id: string;
  sender_id: string;
  client_message_id: string;
  seq: string;
  body: string | null;
  created_at: Date;
  deleted_at: Date | null;
  display_name: string;
}
export class Chat {
  readonly limits = new Limiter();
  broadcast: (m: ChatMessage) => void = () => {};
  notice: (type: string, payload: unknown) => void = () => {};
  constructor(public db: Database) {}
  view(m: MessageRow) {
    return {
      id: m.id,
      roomId: m.room_id,
      senderId: m.sender_id,
      clientMessageId: m.client_message_id,
      sequence: m.seq,
      body: m.body,
      createdAt: new Date(m.created_at).toISOString(),
      deletedAt: m.deleted_at ? new Date(m.deleted_at).toISOString() : null,
      displayName: m.display_name,
    };
  }
  async send(i: Identity, b: ChatSend) {
    this.limits.check(`chat:${i.user.id}`, 10, 10000);
    const [room] = await this.db.query<{ id: string }>(
      "SELECT id FROM rooms WHERE singleton_key=$1",
      ["home"],
    );
    assert(b.roomId === room.id, "NOT_FOUND", 404);
    const result = await this.db.transaction(async (c) => {
      const [old] = await this.db.query<MessageRow>(
        "SELECT c.*,u.display_name FROM chat_messages c JOIN users u ON u.id=c.sender_id WHERE sender_id=$1 AND client_message_id=$2",
        [i.user.id, b.clientMessageId],
        c,
      );
      if (old) {
        assert(old.body === b.body, "IDEMPOTENCY_CONFLICT", 409);
        return old;
      }
      const [row] = await this.db.query<MessageRow>(
        "INSERT INTO chat_messages(id,room_id,sender_id,client_message_id,body) VALUES($1,$2,$3,$4,$5) ON CONFLICT(sender_id,client_message_id) DO NOTHING RETURNING *",
        [randomUUID(), room.id, i.user.id, b.clientMessageId, b.body],
        c,
      );
      if (!row) {
        const [existing] = await this.db.query<MessageRow>(
          "SELECT c.*,u.display_name FROM chat_messages c JOIN users u ON u.id=c.sender_id WHERE sender_id=$1 AND client_message_id=$2",
          [i.user.id, b.clientMessageId],
          c,
        );
        assert(existing.body === b.body, "IDEMPOTENCY_CONFLICT", 409);
        return existing;
      }
      return { ...row, display_name: i.user.display_name };
    });
    const message = this.view(result);
    this.broadcast(message);
    return message;
  }
  routes(h: Http) {
    const empty = z.strictObject({}),
      cursor = z
        .string()
        .regex(/^\d{1,19}$/)
        .refine((x) => BigInt(x) <= 9223372036854775807n);
    h.route(
      "GET",
      "/api/v1/room/chat",
      z.strictObject({ before: cursor.optional(), after: cursor.optional() }),
      "user",
      async (b) => {
        assert(!(b.before && b.after), "INVALID_CURSOR");
        const rows = await this.db.query<MessageRow>(
          "SELECT c.*,u.display_name FROM chat_messages c JOIN users u ON u.id=c.sender_id WHERE c.room_id=(SELECT id FROM rooms WHERE singleton_key=$1) AND ($2::bigint IS NULL OR c.seq<$2) AND ($3::bigint IS NULL OR c.seq>$3) ORDER BY c.seq " +
            (b.after ? "ASC" : "DESC") +
            " LIMIT 50",
          ["home", b.before ?? null, b.after ?? null],
        );
        return (b.after ? rows : rows.reverse()).map((m) => this.view(m));
      },
    );
    h.route(
      "DELETE",
      "/api/v1/room/chat/:id",
      empty,
      "user",
      async (_b, i, r) => {
        const id = uuid.parse((r.params as { id: string }).id);
        const rows = await this.db.query<{ id: string }>(
          "UPDATE chat_messages SET body=NULL,deleted_at=now() WHERE id=$1 AND (sender_id=$2 OR $3) RETURNING id",
          [id, i.user.id, i.user.role === "OWNER"],
        );
        assert(rows.length, "FORBIDDEN", 403);
        this.notice("chat:deleted", { id });
        return { ok: true };
      },
    );
    h.route(
      "DELETE",
      "/api/v1/admin/room/chat",
      empty,
      "owner-recent",
      async () => {
        await this.db.query(
          "UPDATE chat_messages SET body=NULL,deleted_at=now() WHERE room_id=(SELECT id FROM rooms WHERE singleton_key=$1)",
          ["home"],
        );
        this.notice("chat:cleared", {});
        return { ok: true };
      },
    );
  }
}

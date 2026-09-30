import pg from "pg";
import type { PoolClient, QueryResultRow } from "pg";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
export type Client = PoolClient;
export class Database {
  readonly pool: pg.Pool;
  private readonly context = new AsyncLocalStorage<Client>();
  constructor(url: string) {
    this.pool = new pg.Pool({
      connectionString: url,
      max: 10,
      statement_timeout: 10000,
      idle_in_transaction_session_timeout: 10000,
    });
  }
  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
    client?: Client,
  ) {
    return (
      await (client ?? this.context.getStore() ?? this.pool).query<T>(
        sql,
        params,
      )
    ).rows;
  }
  async transaction<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const existing = this.context.getStore();
    if (existing) return fn(existing);
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const r = await this.context.run(c, () => fn(c));
      await c.query("COMMIT");
      return r;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async migrate() {
    const dir = resolve("packages/db/migrations");
    await this.transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(173002)");
      await c.query(
        "CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
      );
      for (const name of (await readdir(dir))
        .filter((v) => v.endsWith(".sql"))
        .sort()) {
        const text = await readFile(resolve(dir, name), "utf8");
        const checksum = createHash("sha256").update(text).digest("hex");
        const old = await this.query<{ checksum: string }>(
          "SELECT checksum FROM schema_migrations WHERE version=$1",
          [name],
          c,
        );
        if (old.length) {
          if (old[0].checksum !== checksum)
            throw new Error(`Migration checksum changed: ${name}`);
          continue;
        }
        await c.query(text);
        await c.query(
          "INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)",
          [name, checksum],
        );
      }
    });
  }
  async close() {
    await this.pool.end();
  }
}

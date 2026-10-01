import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { testApp, actor, syntheticVideo } from "../helpers/context.js";
import { seal } from "../../apps/api/src/infrastructure/secrets.js";
let a: Awaited<ReturnType<typeof testApp>>,
  owner: Awaited<ReturnType<typeof actor>>;
beforeAll(async () => {
  a = await testApp();
  owner = await actor(a);
  await a.app.listen({ host: "127.0.0.1", port: a.config.PORT });
});
afterAll(async () => {
  await a.app.close();
});
it("P12: catálogo de mil fichas, paginación íntegra y p95 HTTP inferior a 300 ms", async () => {
  const partner = await actor(a, "pareja");
  const fixture = await syntheticVideo(a, owner.identity),
    source = await a.library.source(fixture.primary_source_id!),
    ref = a.library.reference(source),
    prefix = `[PERF ${randomUUID()}]`;
  const records = Array.from({ length: 1000 }, (_, n) => {
    const mediaId = randomUUID(),
      sourceId = randomUUID();
    return {
      mediaId,
      sourceId,
      generation: randomUUID(),
      title: `${prefix} ${String(n).padStart(4, "0")}`,
      encrypted: seal(ref, a.config.masterKey, "source", sourceId),
    };
  });
  await a.db.transaction(async (client) => {
    for (const row of records) {
      await client.query(
        "INSERT INTO media(id,title,content_generation,duration_seconds,publication_state,created_by) VALUES($1,$2,$3,120,'DRAFT',$4)",
        [row.mediaId, row.title, row.generation, owner.identity.user.id],
      );
      await client.query(
        "INSERT INTO sources(id,media_id,kind,encrypted_reference,delivery_strategy,health,capabilities_json,approved_origins_json) VALUES($1,$2,'local',$3,'relay','READY',$4,$5)",
        [
          row.sourceId,
          row.mediaId,
          row.encrypted,
          source.capabilities_json,
          source.approved_origins_json,
        ],
      );
      await client.query(
        "UPDATE media SET primary_source_id=$1,publication_state='PUBLISHED' WHERE id=$2",
        [row.sourceId, row.mediaId],
      );
    }
  });
  const timings: number[] = [];
  const request = async (cursor?: string) => {
    const query = new URLSearchParams({
      search: prefix,
      limit: "100",
      ...(cursor ? { cursor } : {}),
    });
    const started = performance.now(),
      response = await fetch(`${a.config.origin}/api/v1/library?${query}`, {
        headers: { Cookie: timings.length % 2 ? partner.cookie : owner.cookie },
      }),
      body = await response.json();
    expect(response.status).toBe(200);
    timings.push(performance.now() - started);
    return body;
  };
  try {
    let cursor: string | undefined,
      seen = 0;
    const ids = new Set<string>();
    do {
      const result = await request(cursor);
      seen += result.items.length;
      for (const row of result.items) ids.add(row.id);
      cursor = result.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toBe(1000);
    expect(ids.size).toBe(1000);
    for (let n = 0; n < 40; n++)
      expect((await request()).items).toHaveLength(100);
    const sorted = [...timings].sort((x, y) => x - y),
      p95 = sorted[Math.floor((sorted.length - 1) * 0.95)];
    await mkdir("artifacts/performance", { recursive: true });
    await writeFile(
      "artifacts/performance/catalog.json",
      JSON.stringify(
        {
          status: p95 < 300 ? "PASS" : "FAIL",
          actualHttp: true,
          actualPostgreSQL: true,
          catalogFixtures: 1000,
          authenticatedUsers: 2,
          samples: timings.length,
          p95Ms: p95,
          maxMs: Math.max(...timings),
          timingsMs: timings,
          productionData: false,
        },
        null,
        2,
      ),
    );
    expect(p95).toBeLessThan(300);
  } finally {
    const ids = records.map((r) => r.mediaId);
    await a.db.transaction(async (client) => {
      await client.query(
        "UPDATE media SET primary_source_id=NULL,publication_state='DRAFT' WHERE id=ANY($1::uuid[])",
        [ids],
      );
      await client.query("DELETE FROM sources WHERE media_id=ANY($1::uuid[])", [
        ids,
      ]);
      await client.query("DELETE FROM media WHERE id=ANY($1::uuid[])", [ids]);
    });
  }
});

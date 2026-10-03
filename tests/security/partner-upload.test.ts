import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { testApp, actor } from "../helpers/context.js";
import { canUploadLocalFiles } from "../../packages/contracts/src/permissions.js";

let app: Awaited<ReturnType<typeof testApp>>,
  owner: Awaited<ReturnType<typeof actor>>,
  partner: Awaited<ReturnType<typeof actor>>;
const ids: string[] = [];
beforeAll(async () => {
  app = await testApp();
  expect(app.config.APP_ENV).toBe("test");
  owner = await actor(app);
  partner = await actor(app, "pareja");
});
afterAll(async () => {
  for (const id of ids) {
    await app.db.query(
      "UPDATE uploads SET state='cancelled' WHERE media_id=$1 AND state='uploading'",
      [id],
    );
    await app.db.query(
      "UPDATE media SET publication_state='WITHDRAWN',deleted_at=now() WHERE id=$1",
      [id],
    );
  }
  await app.app.close();
});
it("local upload capability grants only the existing two roles, never general administration", () => {
  expect(canUploadLocalFiles("OWNER")).toBe(true);
  expect(canUploadLocalFiles("PARTNER")).toBe(true);
  for (const role of ["ADMIN", "uploader", "", "owner", "anonymous"])
    expect(canUploadLocalFiles(role)).toBe(false);
  const operations = Object.entries(app.http.openApi().paths).flatMap(
    ([path, methods]) =>
      Object.entries(methods).map(([method, value]) => ({
        path,
        method,
        value: value as Record<string, unknown>,
      })),
  );
  for (const route of operations.filter((r) =>
    r.path.startsWith("/api/v1/admin/"),
  ))
    expect(String(route.value["x-rave-access"]), route.path).toMatch(/^owner/);
  const scoped = operations
    .filter((r) => r.value["x-rave-access"] === "uploader")
    .map((r) => `${r.method.toUpperCase()} ${r.path}`)
    .sort();
  expect(scoped).toEqual(
    [
      "DELETE /api/v1/uploads/{id}",
      "GET /api/v1/uploads",
      "GET /api/v1/uploads/{id}",
      "HEAD /api/v1/uploads/{id}",
      "PATCH /api/v1/uploads/{id}",
      "POST /api/v1/uploads",
      "POST /api/v1/uploads/{id}/cancel-preparation",
      "POST /api/v1/uploads/{id}/complete",
      "POST /api/v1/uploads/{id}/retry",
    ].sort(),
  );
});
it("both stored ownership fields must match; a private draft remains hidden from all general media APIs", async () => {
  const mediaId = await app.library.create(owner.identity, {
    title: "[TEST] mismatched uploader creator",
    description: "",
  });
  ids.push(mediaId);
  const uploadId = randomUUID();
  await app.db.query(
    "INSERT INTO uploads(id,owner_id,expected_bytes,original_name,temporary_key,expires_at,media_id) VALUES($1,$2,1,'synthetic.mp4',$3,now()+interval '1 hour',$4)",
    [uploadId, partner.identity.user.id, `uploads/${uploadId}.part`, mediaId],
  );
  for (const method of ["GET", "HEAD"] as const) {
    const r = await app.app.inject({
      method,
      url: `/api/v1/uploads/${uploadId}`,
      headers: partner.headers,
    });
    expect(r.statusCode).toBe(404);
    expect(r.headers["upload-offset"]).toBeUndefined();
  }
  for (const suffix of ["/retry", "/cancel-preparation", "/complete"]) {
    const r = await app.app.inject({
      method: "POST",
      url: `/api/v1/uploads/${uploadId}${suffix}`,
      headers: partner.headers,
      payload: {},
    });
    expect(r.statusCode).toBe(404);
  }
  expect(
    (
      await app.app.inject({
        url: `/api/v1/media/${mediaId}`,
        headers: partner.headers,
      })
    ).statusCode,
  ).toBe(404);
  const list = await app.app.inject({
    url: "/api/v1/uploads?limit=100",
    headers: partner.headers,
  });
  expect(list.json().items.some((u: { id: string }) => u.id === uploadId)).toBe(
    false,
  );
});
it("forged pagination cannot enumerate another creator and validates untrusted cursors", async () => {
  for (const cursor of [
    "invalid",
    Buffer.from(
      JSON.stringify({ key: "invalid date", id: randomUUID() }),
    ).toString("base64url"),
    Buffer.from(
      JSON.stringify({
        key: new Date().toISOString(),
        id: randomUUID(),
        ownerId: owner.identity.user.id,
      }),
    ).toString("base64url"),
  ]) {
    const r = await app.app.inject({
      url: `/api/v1/uploads?cursor=${encodeURIComponent(cursor)}`,
      headers: partner.headers,
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe("INVALID_CURSOR");
  }
  for (const extra of [
    `ownerId=${owner.identity.user.id}`,
    "admin=true",
    "publication=all",
  ]) {
    const r = await app.app.inject({
      url: `/api/v1/uploads?${extra}`,
      headers: partner.headers,
    });
    expect(r.statusCode).toBe(400);
  }
});

import { z } from "zod";
import { Http } from "../../infrastructure/http.js";
import { Drive } from "./service.js";
import { assert } from "../../infrastructure/errors.js";
export function driveRoutes(h: Http, drive: Drive) {
  const empty = z.strictObject({});
  h.route("GET", "/api/v1/admin/drive/status", empty, "owner", async () =>
    drive.status(),
  );
  h.route(
    "POST",
    "/api/v1/admin/drive/connect",
    empty,
    "owner-recent",
    async (_b, i) => ({ authorizationUrl: await drive.connect(i) }),
  );
  h.route(
    "GET",
    "/api/v1/admin/drive/callback",
    z.strictObject({
      state: z.string().min(32).max(128),
      code: z.string().min(1).max(4096).optional(),
      error: z.string().max(100).optional(),
      scope: z.string().max(2048).optional(),
      authuser: z.string().max(20).optional(),
      prompt: z.string().max(100).optional(),
    }),
    "owner-recent",
    async (b, i, _r, p) => {
      if (b.error) {
        await drive.consumeState(i, b.state);
        return p.redirect("/admin/integrations?error=consent");
      }
      assert(b.code, "INVALID_OAUTH_CODE");
      await drive.callback(i, b.state, b.code);
      return p.redirect("/admin/integrations");
    },
  );
  h.route(
    "POST",
    "/api/v1/admin/drive/picker-token",
    empty,
    "owner-recent",
    async (_b, _i, _r, p) => {
      const { gateway } = await drive.gateway(),
        access = await gateway.client.getAccessToken();
      p.header("Cache-Control", "no-store");
      return {
        accessToken: access.token,
        apiKey: drive.config.GOOGLE_PICKER_API_KEY,
        appId: drive.config.GOOGLE_CLOUD_PROJECT_NUMBER,
        origin: drive.config.origin,
      };
    },
  );
  h.route(
    "POST",
    "/api/v1/admin/drive/import",
    z.strictObject({
      fileIds: z
        .array(z.string().regex(/^[A-Za-z0-9_-]{10,200}$/))
        .min(1)
        .max(20),
    }),
    "owner",
    async (b, i, _r, _p, prepared) => ({
      mediaIds: await drive.importFiles(
        i,
        b.fileIds,
        prepared as Awaited<ReturnType<Drive["prepareImports"]>>,
      ),
    }),
    { prepare: (b) => drive.prepareImports(b.fileIds) },
  );
  h.route(
    "DELETE",
    "/api/v1/admin/drive/connection",
    empty,
    "owner-recent",
    async () => {
      return drive.revoke();
    },
  );
}

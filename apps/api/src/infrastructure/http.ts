import type {
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
  HTTPMethods,
} from "fastify";
import type {} from "@fastify/cookie";
import type { z } from "zod";
import type { AuthService, Identity } from "../modules/auth/service.js";
import { assert } from "./errors.js";
import { z as validator } from "zod";
import { hash, open, seal, type Ciphertext } from "./secrets.js";
export type Access = "public" | "user" | "owner" | "recent" | "owner-recent";
declare module "fastify" {
  interface FastifyRequest {
    identity?: Identity;
  }
}
export class Http {
  private readonly specification: Record<string, Record<string, unknown>> = {};
  constructor(
    public app: FastifyInstance,
    public auth: AuthService,
  ) {}
  route<T extends z.ZodType>(
    method: HTTPMethods,
    url: string,
    schema: T,
    access: Access,
    handler: (
      body: z.infer<T>,
      i: Identity,
      r: FastifyRequest,
      p: FastifyReply,
      prepared?: unknown,
    ) => Promise<unknown>,
    options: {
      prepare?: (body: z.infer<T>, identity: Identity) => Promise<unknown>;
    } = {},
  ) {
    const path = url
      .replace(/:([A-Za-z][A-Za-z0-9]*)/g, "{$1}")
      .replace("*", "{path}");
    const mutatingMethod = !["GET", "HEAD"].includes(String(method));
    const byteUpload =
      method === "PATCH" && url.startsWith("/api/v1/admin/uploads/");
    const idempotentMethod =
      mutatingMethod &&
      (url.startsWith("/api/v1/admin/") || url === "/api/v1/account/avatar") &&
      (!url.startsWith("/api/v1/admin/drive/") ||
        url === "/api/v1/admin/drive/import") &&
      !url.endsWith("/inspect") &&
      !url.endsWith("/recheck") &&
      !byteUpload;
    const jsonSchema = validator.toJSONSchema(schema, {
      unrepresentable: "any",
    });
    const parameters: unknown[] = Array.from(
      path.matchAll(/\{([^}]+)\}/g),
      (match) => ({
        in: "path",
        name: match[1],
        required: true,
        schema: { type: "string" },
      }),
    );
    if (["GET", "HEAD"].includes(String(method)) && jsonSchema.properties)
      for (const [name, field] of Object.entries(jsonSchema.properties))
        parameters.push({ in: "query", name, required: false, schema: field });
    if (mutatingMethod) {
      parameters.push({
        in: "header",
        name: "Origin",
        required: true,
        schema: { type: "string" },
        description: "Origen exacto de Rave",
      });
      if (access !== "public")
        parameters.push({
          in: "header",
          name: "X-CSRF-Token",
          required: true,
          schema: { type: "string" },
        });
      if (idempotentMethod)
        parameters.push({
          in: "header",
          name: "Idempotency-Key",
          required: true,
          schema: { type: "string", format: "uuid" },
          description:
            "Misma clave/payload para repetir una intención; no reutilizar con otro payload",
        });
    }
    if (byteUpload)
      for (const name of ["Upload-Offset", "Content-Length"])
        parameters.push({
          in: "header",
          name,
          required: true,
          schema: { type: "integer", minimum: 0 },
        });
    if (url.startsWith("/media/"))
      parameters.push({
        in: "header",
        name: "Range",
        required: false,
        schema: { type: "string" },
        description: "Un solo rango de bytes cerrado, abierto o suffix",
      });
    const operation: Record<string, unknown> = {
      operationId: `${method}_${url}`.replace(/[^A-Za-z0-9_]/g, "_"),
      summary: `${method} ${url}`,
      security: access === "public" ? [] : [{ session: [] }],
      parameters,
      responses: {
        "200": { description: "Operación completada" },
        "400": { description: "Payload inválido" },
        "401": { description: "Sesión requerida" },
        "403": {
          description: "Permiso, Origin, CSRF o reautenticación requerido",
        },
        "409": { description: "Conflicto de estado" },
        "429": { description: "Límite excedido" },
      },
      "x-rave-access": access,
    };
    if (!["GET", "HEAD"].includes(String(method)))
      operation.requestBody = {
        required: true,
        content: byteUpload
          ? {
              "application/octet-stream": {
                schema: { type: "string", format: "binary" },
              },
            }
          : { "application/json": { schema: jsonSchema } },
      };
    const responses = operation.responses as Record<string, unknown>;
    if (
      byteUpload ||
      (method === "HEAD" && url.startsWith("/api/v1/admin/uploads/"))
    ) {
      delete responses["200"];
      responses["204"] = {
        description: "Offset durable; sin cuerpo",
        headers: {
          "Upload-Offset": { schema: { type: "integer" } },
          "Upload-Length": { schema: { type: "integer" } },
          "Upload-State": { schema: { type: "string" } },
        },
      };
    }
    if (url.startsWith("/media/")) {
      responses["200"] = {
        description: "Recurso privado completo",
        ...(method === "HEAD"
          ? {}
          : {
              content: {
                "application/octet-stream": {
                  schema: { type: "string", format: "binary" },
                },
              },
            }),
      };
      responses["206"] = {
        description: "Rango de bytes autorizado",
        headers: {
          "Content-Range": { schema: { type: "string" } },
          "Content-Length": { schema: { type: "integer" } },
        },
      };
      responses["416"] = {
        description: "Rango inválido",
        headers: { "Content-Range": { schema: { type: "string" } } },
      };
    }
    this.specification[path] ??= {};
    this.specification[path][String(method).toLowerCase()] = operation;
    this.app.route({
      method,
      url,
      preHandler: async (r) => {
        const mutating = !["GET", "HEAD"].includes(r.method);
        if (mutating) {
          assert(
            r.headers.origin === this.auth.config.origin,
            "ORIGIN_REJECTED",
            403,
          );
          if (
            r.method !== "PATCH" ||
            !r.url.startsWith("/api/v1/admin/uploads/")
          )
            assert(
              r.headers["content-type"]?.startsWith("application/json") ||
                r.headers["content-type"]?.startsWith(
                  "application/octet-stream",
                ),
              "CONTENT_TYPE_REQUIRED",
              415,
            );
        }
        if (access !== "public") {
          const i = await this.auth.authenticate(
            r.cookies[this.auth.config.cookieName],
          );
          r.identity = i;
          if (mutating) this.auth.checkCsrf(i, r.headers["x-csrf-token"]);
          if (access.startsWith("owner")) await this.auth.assertOwner(i);
          if (access.includes("recent")) this.auth.recent(i);
          if (
            i.user.must_change_password &&
            !r.url.startsWith("/api/v1/auth/") &&
            !r.url.startsWith("/api/v1/account")
          )
            assert(false, "PASSWORD_CHANGE_REQUIRED", 403);
        }
      },
      handler: async (r, p) => {
        const value = schema.parse(
          ["GET", "HEAD"].includes(r.method) ? r.query : (r.body ?? {}),
        );
        const identity = r.identity as Identity;
        // Credential-bearing auth responses use their own single-use/session rules.
        // Byte chunks are already serialized by Upload-Offset and row locks.
        const idempotent = idempotentMethod;
        const prepared = await options.prepare?.(value, identity);
        const protectsFiles =
          !["GET", "HEAD"].includes(r.method) &&
          (/^\/api\/v1\/admin\/(videos|uploads)(\/|$)/.test(url) ||
            url === "/api/v1/account/avatar");
        const guard = async (
          client: import("../../../../packages/db/src/index.js").Client,
        ) => {
          if (!protectsFiles) return;
          await client.query("SELECT pg_advisory_xact_lock_shared(173006)");
          const maintenance = await client.query(
            "SELECT 1 FROM settings WHERE key='maintenance' AND value_json='true'::jsonb",
          );
          assert(!maintenance.rowCount, "MAINTENANCE", 503);
        };
        if (!idempotent) {
          if (protectsFiles)
            return this.auth.db.transaction(async (client) => {
              await guard(client);
              return handler(value, identity, r, p, prepared);
            });
          return handler(value, identity, r, p, prepared);
        }
        const requestKey = validator.uuid().parse(r.headers["idempotency-key"]);
        const operation = `${r.method} ${r.url.split("?")[0]}`;
        const payloadHash = hash(JSON.stringify(value));
        const receiptId = `${identity.user.id}:${requestKey}`;
        return this.auth.db.transaction(async (client) => {
          await guard(client);
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            [receiptId],
          );
          const [prior] = await this.auth.db.query<{
            operation: string;
            payload_hash: string;
            result_json: Ciphertext;
          }>(
            "SELECT operation,payload_hash,result_json FROM http_receipts WHERE actor_user_id=$1 AND request_key=$2",
            [identity.user.id, requestKey],
            client,
          );
          if (prior) {
            assert(
              prior.operation === operation &&
                prior.payload_hash === payloadHash,
              "IDEMPOTENCY_CONFLICT",
              409,
            );
            const cached = open<{ status: number; body: unknown }>(
              prior.result_json,
              this.auth.config.masterKey,
              "http-receipt",
              receiptId,
            );
            p.code(cached.status);
            return cached.body;
          }
          const result = await handler(value, identity, r, p, prepared);
          assert(!p.sent, "INVALID_IDEMPOTENT_RESPONSE", 500);
          await client.query(
            "INSERT INTO http_receipts(actor_user_id,request_key,operation,payload_hash,result_json) VALUES($1,$2,$3,$4,$5)",
            [
              identity.user.id,
              requestKey,
              operation,
              payloadHash,
              seal(
                { status: p.statusCode, body: result ?? null },
                this.auth.config.masterKey,
                "http-receipt",
                receiptId,
              ),
            ],
          );
          return result;
        });
      },
    });
  }
  openApi() {
    return {
      openapi: "3.1.0",
      info: { title: "Rave privado V1", version: "0.1.0" },
      servers: [{ url: "/" }],
      paths: this.specification,
      components: {
        securitySchemes: {
          session: {
            type: "apiKey",
            in: "cookie",
            name: this.auth.config.cookieName,
          },
        },
      },
    };
  }
  cookie(p: FastifyReply, raw: string) {
    p.setCookie(this.auth.config.cookieName, raw, {
      httpOnly: true,
      secure: this.auth.config.COOKIE_SECURE === "true",
      sameSite: "lax",
      path: "/",
      maxAge: 30 * 86400,
    });
  }
}

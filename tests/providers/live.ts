import { mkdir, writeFile } from "node:fs/promises";
import {
  chromium,
  expect,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { z } from "zod";
import { loadConfig } from "../../apps/api/src/infrastructure/config.js";
import { Database } from "../../packages/db/src/index.js";
import { AuthService } from "../../apps/api/src/modules/auth/service.js";
import { LibraryService } from "../../apps/api/src/modules/library/service.js";
import { Drive } from "../../apps/api/src/modules/drive/service.js";
import { Streams } from "../../apps/api/src/modules/media/streams.js";
import { checkMasterKey } from "../../apps/api/src/infrastructure/key-state.js";
import { open, seal } from "../../apps/api/src/infrastructure/secrets.js";
import type { Credentials } from "google-auth-library";
import type { User } from "../../apps/api/src/modules/auth/service.js";
const config = loadConfig();
await mkdir("artifacts/providers", { recursive: true });
async function report(data: Record<string, unknown>) {
  await writeFile(
    "artifacts/providers/live.json",
    JSON.stringify(
      {
        test: "SRC-07",
        verifiedAt: new Date().toISOString(),
        physicalDevice: false,
        ...data,
      },
      null,
      2,
    ),
  );
}
async function blocked(reason: string) {
  await report({
    status: "BLOCKED_EXTERNAL",
    configured: config.googleConfigured,
    reason,
    liveVerified: false,
  });
  console.log(`SRC-07 BLOCKED_EXTERNAL: ${reason}`);
  process.exitCode = 2;
}
async function video(page: Page) {
  return page.locator("video").evaluate((v: HTMLVideoElement) => ({
    time: v.currentTime,
    ready: v.readyState,
    paused: v.paused,
  }));
}
if (!config.googleConfigured)
  await blocked(
    "Falta configuración OAuth/Picker y consentimiento del propietario.",
  );
else if (!process.env.RAVE_LIVE_MEDIA_ID)
  await blocked(
    "Selecciona mediante Picker un vídeo de prueba propio publicado e indica su UUID en RAVE_LIVE_MEDIA_ID.",
  );
else {
  const mediaId = z.uuid().parse(process.env.RAVE_LIVE_MEDIA_ID),
    db = new Database(config.databaseUrl),
    auth = new AuthService(db, config),
    library = new LibraryService(db, config),
    app = {
      db,
      auth,
      library,
      drive: new Drive(db, config, library, new Streams(auth)),
    };
  const sessions: Awaited<ReturnType<typeof app.auth.issue>>[] = [];
  const contexts: BrowserContext[] = [];
  try {
    // Verify the running application, including its actual HTTPS ingress. Do
    // not acquire another room lock or compete for the application's port.
    const ready = await fetch(config.origin + "/health/ready", {
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    expect(ready.ok).toBe(true);
    await checkMasterKey(db, config);
    if (!(await app.drive.status()).authorized)
      await blocked(
        "Falta consentimiento OAuth del propietario; no se usan credenciales sintéticas.",
      );
    else {
      const users = await app.db.query<User>(
        "SELECT * FROM users WHERE disabled_at IS NULL ORDER BY role DESC",
      );
      if (users.length !== 2 || users.some((u) => u.must_change_password))
        await blocked(
          "Ambas cuentas deben completar el primer inicio de sesión antes de esta verificación.",
        );
      else {
        const owner = users.find((u) => u.role === "OWNER")!,
          media = await app.library.published(mediaId),
          source = await app.library.source(media.primary_source_id!);
        expect(source.kind).toBe("drive");
        expect(media.duration_seconds).toBeGreaterThan(15);
        // Expire only this project's short-lived access token. Google must issue
        // a new token using the owner's actual offline consent; no fixture path.
        const connection = await app.drive.connection();
        const credentials = open<Credentials>(
          connection.encrypted_secrets,
          config.masterKey,
          "provider",
          connection.id,
        );
        expect(credentials.refresh_token).toBeTruthy();
        await app.db.query(
          "UPDATE provider_connections SET encrypted_secrets=$1 WHERE id=$2",
          [
            seal(
              { ...credentials, access_token: undefined, expiry_date: 1 },
              config.masterKey,
              "provider",
              connection.id,
            ),
            connection.id,
          ],
        );
        const refreshed = await app.drive.gateway();
        expect(refreshed.gateway.client.credentials.access_token).toBeTruthy();
        expect(
          refreshed.gateway.client.credentials.expiry_date,
        ).toBeGreaterThan(Date.now());
        const browser = await chromium.launch({
          executablePath: process.env.RAVE_CHROMIUM_BIN ?? "/usr/bin/chromium",
          args: ["--no-sandbox"],
        });
        try {
          const pages: Page[] = [];
          for (const user of [
            owner,
            users.find((u) => u.role === "PARTNER")!,
          ]) {
            const issued = await app.auth.issue(
              user,
              "Verificación real Drive autorizada",
            );
            sessions.push(issued);
            const context = await browser.newContext({
              baseURL: config.origin,
            });
            contexts.push(context);
            await context.addCookies([
              {
                name: config.cookieName,
                value: issued.raw,
                url: config.origin,
                httpOnly: true,
                secure: config.COOKIE_SECURE === "true",
                sameSite: "Lax",
              },
            ]);
            pages.push(await context.newPage());
          }
          const [a, b] = pages;
          const start = await contexts[0].request.post("/api/v1/room/start", {
            headers: {
              Origin: config.origin,
              "X-CSRF-Token": sessions[0].identity.csrf,
            },
            data: { mediaId, personalPositionSeconds: 0 },
          });
          expect(start.ok()).toBe(true);
          for (const page of pages) {
            await page.goto("/room");
            await expect
              .poll(async () => (await video(page)).ready, { timeout: 30000 })
              .toBeGreaterThanOrEqual(3);
            await page
              .getByRole("button", {
                name: "Pulsa para activar la reproducción",
              })
              .click();
          }
          await a
            .getByRole("button", { name: "Reproducir", exact: true })
            .click();
          for (const page of pages)
            await expect
              .poll(async () => (await video(page)).time, { timeout: 30000 })
              .toBeGreaterThan(1);
          await a.getByRole("button", { name: "Avanzar 10 segundos" }).click();
          for (const page of pages)
            await expect
              .poll(async () => (await video(page)).time, { timeout: 30000 })
              .toBeGreaterThan(10);
          await expect
            .poll(
              async () =>
                Math.abs((await video(a)).time - (await video(b)).time),
              { timeout: 10000 },
            )
            .toBeLessThan(0.8);
          await a.getByRole("button", { name: "Pausar", exact: true }).click();
          for (const page of pages)
            await expect
              .poll(async () => (await video(page)).paused)
              .toBe(true);
          await report({
            status: "PASS",
            configured: true,
            authorized: true,
            liveVerified: true,
            mediaId,
            metadata: true,
            relay: true,
            realSdkTokenRefresh: true,
            authenticatedContexts: 2,
            actualVideoPlayback: true,
            actualSeek: true,
            synchronizedPause: true,
            runningApplicationVerified: true,
            originHttps: new URL(config.origin).protocol === "https:",
            durationSeconds: media.duration_seconds,
          });
          console.log(
            "SRC-07 PASS: Drive real, refresh OAuth, relay y playback/seek/pausa con dos contextos autenticados.",
          );
          await a
            .getByRole("button", { name: "Cerrar sesión compartida" })
            .click();
          await a
            .getByRole("button", { name: "Confirmar", exact: true })
            .click();
        } finally {
          for (const context of contexts) await context.close();
          await browser.close();
        }
      }
    }
  } catch {
    await report({
      status: "FAIL",
      liveVerified: false,
      reason:
        "Falló la verificación real. Revisar localmente el entorno y Google sin publicar secretos.",
    });
    console.error(
      "SRC-07 FAIL: verificación real incompleta; no se imprimen detalles de credenciales.",
    );
    process.exitCode = 1;
  } finally {
    for (const session of sessions)
      await app.auth.revokeSession(
        session.identity.session.id,
        session.identity.user.id,
      );
    await app.db.close();
  }
}

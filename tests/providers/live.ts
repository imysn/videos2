import { mkdir, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { z } from "zod";
import { loadConfig } from "../../apps/api/src/infrastructure/config.js";
import { createApp } from "../../apps/api/src/server.js";
import type { User } from "../../apps/api/src/modules/auth/service.js";
const config = loadConfig();
await mkdir("artifacts/providers", { recursive: true });
async function blocked(reason: string) {
  await writeFile(
    "artifacts/providers/live.json",
    JSON.stringify(
      {
        status: "BLOCKED_EXTERNAL",
        test: "SRC-07",
        configured: config.googleConfigured,
        reason,
        liveVerified: false,
      },
      null,
      2,
    ),
  );
  console.log(`SRC-07 BLOCKED_EXTERNAL: ${reason}`);
  process.exitCode = 2;
}
if (!config.googleConfigured) {
  await blocked(
    "Falta configuración OAuth/Picker y consentimiento del propietario.",
  );
} else if (!process.env.RAVE_LIVE_MEDIA_ID) {
  await blocked(
    "Selecciona primero mediante Picker un vídeo de prueba autorizado e indica su UUID en RAVE_LIVE_MEDIA_ID.",
  );
} else {
  const mediaId = z.uuid().parse(process.env.RAVE_LIVE_MEDIA_ID),
    app = await createApp(config, { logger: false, roomLock: false });
  try {
    const status = await app.drive.status();
    if (!status.authorized) {
      await blocked(
        "Falta consentimiento OAuth del propietario; no se sustituye por credenciales de fixture.",
      );
    } else {
      const [owner] = await app.db.query<User>(
        "SELECT * FROM users WHERE role='OWNER' AND disabled_at IS NULL",
      );
      if (owner.must_change_password) {
        await blocked(
          "El propietario debe completar el primer inicio de sesión antes de la prueba de su conexión.",
        );
      } else {
        const issued = await app.auth.issue(
          owner,
          "Verificación Drive autorizada",
        );
        try {
          const media = await app.library.published(mediaId),
            source = await app.library.source(media.primary_source_id!);
          expect(source.kind).toBe("drive");
          const descriptor = await app.drive.descriptor(
            mediaId,
            issued.identity,
          );
          expect(descriptor.delivery).toBe("relay");
          await app.app.listen({ host: "127.0.0.1", port: config.PORT });
          const browser = await chromium.launch({
            executablePath:
              process.env.RAVE_CHROMIUM_BIN ?? "/usr/bin/chromium",
            args: ["--no-sandbox"],
          });
          const started = performance.now();
          try {
            const context = await browser.newContext();
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
            const page = await context.newPage();
            await page.goto(config.origin + `/watch/${mediaId}`);
            await page
              .locator("video")
              .or(
                page.getByRole("button", {
                  name: "Usar este dispositivo",
                  exact: true,
                }),
              )
              .waitFor();
            const takeover = page.getByRole("button", {
              name: "Usar este dispositivo",
              exact: true,
            });
            if (await takeover.isVisible()) await takeover.click();
            await page.locator("video").waitFor();
            await page
              .getByRole("button", { name: "Reproducir", exact: true })
              .click();
            await page.waitForFunction(() => {
              const video = document.querySelector("video");
              return video && video.currentTime > 1 && video.readyState >= 3;
            });
            await page
              .getByRole("button", { name: "Avanzar 10 segundos" })
              .click();
            await page.waitForFunction(
              () => document.querySelector("video")!.currentTime > 10,
            );
            await page
              .getByRole("button", { name: "Pausar", exact: true })
              .click();
            await writeFile(
              "artifacts/providers/live.json",
              JSON.stringify(
                {
                  status: "PASS",
                  test: "SRC-07",
                  configured: true,
                  authorized: true,
                  liveVerified: true,
                  verifiedAt: new Date().toISOString(),
                  mediaId,
                  metadata: true,
                  relay: true,
                  actualVideoPlayback: true,
                  actualSeek: true,
                  durationSeconds: descriptor.durationSeconds,
                  elapsedSeconds: (performance.now() - started) / 1000,
                  physicalDevice: false,
                },
                null,
                2,
              ),
            );
            console.log(
              "SRC-07 PASS: Google Drive real, bytes autorizados, reproducción y seek de vídeo seleccionado.",
            );
          } finally {
            await browser.close();
          }
        } finally {
          await app.auth.revokeSession(issued.identity.session.id, owner.id);
        }
      }
    }
  } finally {
    await app.app.close();
  }
}

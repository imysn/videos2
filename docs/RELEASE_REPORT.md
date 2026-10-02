# Revisión de deployment · 2 de octubre de 2026

Correcciones publicadas en `feat/rave-private-v1`: `de12747` incorpora APT/ca-certificates, COPY tests, tmpfs, Tailscale y regresión Docker; `60781d2` ajusta propietarios de secrets sintéticos en CI y sincroniza las observaciones del navegador, sin cambiar código de producto. Historial conservado y sin force push. Los archivos finales de documentación/evidencia se identifican mediante el HEAD de la rama.

Build y runtime Docker **PASS en amd64 y ARM64 nativos** en [GitHub Actions run 36999714371](https://github.com/imysn/videos2/actions/runs/36999714371), commit `60781d2da3f5233f0a77af9a29d96001fde56036`. Cada job construye la imagen completa, ejecuta argon2/sharp, Node, FFmpeg encode/ffprobe, age y PostgreSQL client; rechaza tmpfs antiguo, crea DB/app/worker y verifica healthy/running, readiness HTTP 200 contenedor/host, puerto loopback sin Caddy, migraciones/bootstrap idempotentes y persistencia tras reinicio/recreación. Reportes descargados de esos jobs: `artifacts/verification/deployment-{amd64,arm64}.json`. El primer run `36999143583` construyó ambas imágenes pero falló en runtime por propietarios UID de archivos de ensayo; no se declaró PASS_RUNTIME.

El executor cloud rechazó pulls/builds con HTTP 429 Docker Hub antes de descargar Node; el espejo oficial devolvió Forbidden. Proxy/CA, TLS y firmas conservados. Los PASS de build/runtime proceden de GitHub runners, no de `compose config`. La matriz CI queda permanente.

Configuración base/local/Tailscale/Drive PASS. Formato, lint, typecheck y build normal ejecutados; unitarias 66 PASS (94,21% ramas room-core), integración 69 PASS en namespace nuevo, seguridad 36 PASS, contratos Drive 15 PASS y E2E Chromium 12 PASS. La integración inicial tuvo dos fallos de medición/espera en browser-resilience: reproducidos en otra ejecución y corregidos en el ensayo, conservando umbral de 1500 ms; sus 16 casos y después la batería completa pasaron. Resumen de comandos/resultados en `artifacts/verification/deployment-review.json`. No se atribuye a esta revisión un nuevo soak de 30 minutos; evidencia histórica conservada abajo.

Secret scan ejecutado sobre candidatos Git/bundle web, incluyendo secretos Compose de ensayo; cero hallazgos. Regresión manual: clave sintética Compose introducida temporalmente en un candidato produjo FAIL/exit1; al retirarlo, PASS/exit0. `.local/`, secrets, identidades y credenciales bootstrap no se publican.

Pi 5 ARM64 y HTTPS Tailscale funcionan según el deployment comunicado por el propietario; Codex no verifica ni actualiza esa instancia. `PUBLIC_ORIGIN` externo, Caddy/volúmenes/defaults/uploads/seguridad conservados. Procedimiento exacto para respaldar/comparar correcciones locales Dockerfile/Compose, fast-forward al commit entregado y redeploy sin perder datos: [RASPBERRY_TAILSCALE](RASPBERRY_TAILSCALE.md). GitHub es fuente oficial; push no actualiza la Pi.

Limitaciones reales: Google OAuth/Picker sin configuración/consentimiento; aceptación de hostname Tailscale en Google Console no verificada y documentación Google bloqueada HTTP403 desde el executor. Móviles físicos y smoke remoto de esta revisión no ejecutados. ACME público falló por red ISP/router/CGNAT, sin modificar Caddy. Sin nuevas funciones/proveedores ni migración storage.

## Informe histórico del primer cierre (1 de octubre)

El texto siguiente conserva evidencia de aquella sesión; sus bloqueos de alojamiento/contenedores han sido actualizados arriba y en BLOCKERS.

**La V1 todavía no está terminada para uso remoto de ambos.** El código funcional y la verificación local están disponibles; faltan Google Drive con consentimiento real, un destino HTTPS autorizado y las verificaciones externas indicadas abajo. El propietario confirmó que aún no tiene alojamiento ni OAuth configurados.

## Código y alcance

Repositorio `imysn/videos2`, rama `feat/rave-private-v1`. Commits publicados: `26d6922` (implementación), `4e15b21` (correcciones y regresiones), `c790bd5` (prerrequisitos de tests desde DB limpia), `9410221` (sala vacía, storage y escáner) y `d5c9004` (acceso por teclado al historial). El commit de cierre se identifica mediante `git log` de la rama. El original `54debc0` y los doce archivos de entrada se conservaron; once checksums válidos y `docs/MASTER_PLAN.md` idéntico al plan original.

Implementado: dos cuentas privadas, una sala, biblioteca administrada por Jason, cargas reanudables, enlaces compatibles autorizados, procesamiento FFmpeg, reproductor propio nativo/HLS/DASH, progreso individual y compartido separados, play/pausa/seek/velocidad compartidos, transferencia de anfitrión, chat, Esperarnos, reconexión, preferencias individuales, permisos y revocación, backup cifrado/restauración/rotación de claves. Google Drive usa SDK oficial, OAuth/Picker `drive.file` y relay protegido; el runner vivo se conecta a la API activa en PUBLIC_ORIGIN sin arrancar otra instancia; su prueba viva sigue bloqueada. Sin iframes ni conectores dedicados excluidos.

## Resultados realmente ejecutados

La verificación inicial completa pasó sobre `c790bd5`. La verificación final utiliza `/workspace/rave-clean-9410221`, creado mediante `git archive 9410221` y actualizado con `git archive d5c9004`, sin worktree ni copia de configuración privada; sus 153 archivos controlados coinciden exactamente con blobs de Git. `bash scripts/cloud-setup.sh` pasó con instalación frozen y configuración nueva; migraciones/bootstrap idempotentes y build. DBs de fixtures nuevas con sufijo independiente y claves age nuevas. El equivalente completo de `verify` se ejecutó por suites, con configuración validation para las suites DB y E2E en test después de liberar 3001 del soak; todos los comandos terminaron con código 0:

| Verificación                                  | Resultado                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Formato, lint, TypeScript strict y build      | PASS                                                                                             |
| Unitarias                                     | 64 PASS; room-core 94,21 % ramas                                                                 |
| Integración                                   | 69 PASS en nueve archivos                                                                        |
| Seguridad                                     | 31 PASS                                                                                          |
| Contratos Drive controlados                   | 14 PASS en fuente limpia; ampliación final 15 PASS                                               |
| E2E Chromium real                             | 12 PASS, cero skipped/flaky                                                                      |
| Soak final, dos usuarios/dos HTMLVideoElement | PASS: 1800,262 s; 3368 muestras; p95 24,6 ms; máximo 127,7 ms; cero pausas; RSS máximo 285,2 MiB |
| Backup age + restore aislado                  | PASS: 786 archivos, RTO 16,292 s; login, catálogo, reproducción y seek                           |
| Auditoría npm                                 | Cero vulnerabilidades reportadas; imágenes pendientes                                            |
| Compose producción/local/Drive                | Estructura PASS con valores de ejemplo; contenedores sin ejecutar                                |

Las pruebas de navegador observan `currentTime`/`readyState`, reproducción real y el estado autoritativo. Incluyen transferencia de control, seek en pausa/reproducción, cambio de velocidad y deriva, buffering real de segmentos, pausa voluntaria durante buffering, cortes WebSocket y RTT/jitter, reinicio real de API, reclamación después de quince segundos, tres contextos para dos cuentas, carga antigua descartada al cambiar vídeo y duraciones incompatibles bloqueadas.

Además: HLS/DASH de dos calidades, dos pistas de audio, subtítulos seguros/desfase, capítulos/sprites, fullscreen/PiP donde Chromium los ofrece, veinte ciclos SPA/diez cambios, catálogo de mil fichas con paginación íntegra y dos usuarios. HLS/DASH se probaron en un origen HTTPS de fixture separado con CORS válido/ausente/segmento 404; la API de ese ensayo es HTTP loopback y el certificado del fixture es de pruebas. No acredita HTTPS de producción ni autorización Google.

SIGKILL de un worker nativo en proceso, vencimiento real de lease de treinta segundos y nueva ejecución produjeron un solo resultado durable. ENOSPC real en tmpfs de 1 MiB dentro de namespace propio, cancelación FFmpeg, errores de archivos, fencing/generación y original intacto. Upgrade desde esquema anterior, rollback y rotación offline con backup/journal/resume también pasaron.

La subida completa adicional desde UI pasó: 13.135.952 bytes en chunks, worker independiente, borrador oculto a partner, publicación por owner, reproducción/seek por partner y checksum original preservado. Evidencia `artifacts/verification/upload-end-to-end.json`. El soak ejecutó c790bd5; API, worker, contratos, room-core y motor/controlador de vídeo son byte a byte idénticos en d5c9004. Los cambios finales de interfaz/setup/escáner se verificaron en el checkout limpio final. Evidencia de alcance: artifacts/sync/source-scope.json. Además, 15 contratos Drive finales incluyen un runner en proceso separado conectado a API real existente; sin consentimiento devuelve bloqueo2 y conserva el servidor. Son contratos, no prueba viva Google. Una ampliación posterior de UX-03 genera un historial con scroll mediante el servicio real de chat y verifica ArrowDown a las tres anchuras; PASS adicional sobre el mismo código de aplicación.

Dos casos de una repetición en el namespace preexistente fallaron en preparación/control y pasaron aislados y en una repetición completa; no se estableció una causa única. La repetición detectó además una violación axe concreta por historial desplazable, corregida en FIX-024 y verificada. La batería final limpia de 69 integración y 12 E2E no tuvo fallos ni reintentos automáticos. No se eliminaron pruebas ni se rebajaron presupuestos.

## Operación y acceso reales

Stack fijado: Node 24.19.0, pnpm 11.19.0, TypeScript 6.0.3, React 19.3.0, Vite 8.3.1, Fastify 5.12.5, Socket.IO 4.8.4, PostgreSQL 17.11, FFmpeg 7.1.5 y age 1.2.1. `pnpm-lock.yaml` conserva los parches exactos.

API y worker principales están activos y su smoke real pasó: health, ambos logins HTTP, cambio inicial obligatorio preservado, logout y biblioteca 401 sin cookie. La aplicación principal utiliza loopback:3000 y PostgreSQL loopback:54329; **no es una URL pública ni acceso desde vuestros dispositivos**. Medios/datos principales persisten en el runtime privado fuera del checkout. Las cuentas iniciales requieren cambiar contraseña. Backup principal cifrado creado; es una copia local y no protege frente a pérdida del host. Configuración privada `.local/config.json`, credenciales iniciales y claves en archivos 0600; no están en Git ni en estos informes.

Arranque reproducible y uso: `README.md`, `docs/OPERATIONS.md`, `docs/USER_GUIDE.md`, `.env.example`. Desde la raíz: `bash scripts/cloud-setup.sh`, `pnpm start` y `pnpm worker` en otro proceso. Pruebas sintéticas separadas: `pnpm test:prepare`, `pnpm exec tsx scripts/test-prepare.ts validation`, `pnpm verify`, `pnpm test:soak`; el soak requiere namespace/proceso exclusivos durante treinta minutos reales. La configuración de producción exige HTTPS, cookies Secure, volumen y secrets privados; no se inventó un dominio ni se contrató servicio.

## Dependencias externas pendientes

- B01: Google OAuth/Picker y consentimiento del proyecto. Los contratos usan transporte controlado; `artifacts/providers/live.json` es BLOCKED_EXTERNAL y no se marca `liveVerifiedAt` con fixtures.
- B02: alojamiento/dominio HTTPS autorizado; smoke remoto y acceso de ambos pendientes.
- B03: Safari iPhone y Chrome Android físicos; responsive 390/768/1440 y axe son automatizados en Chromium, no pruebas físicas.
- B04: capas de Docker rechazadas por política en el CDN oficial; ejecución/reinicio/auditoría de imágenes pendientes. Proxy/CA/TLS conservados; borrador cloud guardado no equivale a política aplicada.
- B05: Git push funciona, API GitHub responde Forbidden a creación de PR. No se creó PR; descripción preparada privadamente. No se fusionó main ni se forzó historial.

La trazabilidad `docs/TRACEABILITY.md` y `docs/EXECUTION_STATE.json` conserva los 86 casos y 60 tareas del manifiesto, distingue PASS_LOCAL de partes externas y apunta a pruebas/evidencias. No hay datos de fixture sembrados en la biblioteca principal como contenido del usuario. Logs/trazas privadas, vídeos y secretos están excluidos de Git. Estado exacto de reanudación: `docs/RESUME.md`.

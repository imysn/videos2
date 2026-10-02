# Estado comprobado · revisión deployment del 2 de octubre de 2026

Scope exclusivamente deployment: Dockerfile APT/CA y COPY tests corregidos, tmpfs válido, perfil Tailscale de producción loopback y Caddy conservado. Build/runtime reales PASS en CI nativa amd64/ARM64, commit `60781d2`, ejecución `36999714371`; dependencias nativas, FFmpeg, readiness, bootstrap/migraciones y persistencia tras reinicios/recreación. Pi 5 funciona según el propietario y no fue modificada por Codex. Guía operativa/reconciliación: RASPBERRY_TAILSCALE/DEPLOYMENT. Drive vivo/móviles físicos siguen separados; esta revisión no declara completos esos gates ni reabre V1. Resultados de la revisión: RELEASE_REPORT y artifacts/verification/deployment-review.json.

## Estado histórico del 1 de octubre

Código publicado en `feat/rave-private-v1`, aplicación final `d5c9004`; commits previos 26d6922/4e15b21/c790bd5/9410221. Paquete original preservado: doce archivos, once SHA256 correctos y plan copiado exactamente.

P00 completo. Implementación V1 presente con dos cuentas, biblioteca privada, uploads y FFmpeg, reproductor propio nativo/HLS/DASH, sala autoritativa/transferencia/chat/Esperarnos/reconexión, progreso separado, preferencias locales, seguridad y operación. P01–P14 distinguen verificación local de gates externos en EXECUTION_STATE/TRACEABILITY; no se declara V1 final para uso remoto.

Verificación final de fuente limpia exacta d5c9004: setup frozen/idempotente, nuevas DBs y claves de fixture, formato/lint/tipos/build; **64 unitarias, 69 integración, 31 seguridad, 14 contratos Drive y 12 E2E PASS**, sin fallos finales, skip ni reintento automático. Room-core 94,21% ramas. Ampliación final: 15 contratos Drive PASS, incluido runner contra API existente sin crear otro servidor. Axe y teclado de historial desplazable PASS a 390/768/1440; no son móviles físicos.

Soak final PASS: **1800,262 segundos reales**, 3368 muestras, p95 24,6 ms, máximo127,7 ms, cero pausas, RSS máximo 285,2 MiB. Se ejecutó c790bd5; protocolo/API/worker/engine/controlador no cambiaron en d5c9004. Evidencia de alcance y medidas en artifacts/sync. Buffering/cortes/reinicio API/leases/SIGKILLworker/ENOSPC real verificados.

Backup/restore age PASS: 786 archivos, RTO 16,292 s, login/catálogo/vídeo/seek reales en namespace nuevo; original principal intacto. Upgrade/rollback y rotación/resume PASS. API 3000 y worker nativos activos, health y login de ambas cuentas verificados sin cambiar sus contraseñas iniciales. Backup principal cifrado creado; copia local, sin protección frente a pérdida del host.

Git push funciona y código publicado; PR no creada por Forbidden de API. Borrador cloud de setup/arranque/dominios guardado, no aplicado a red. Sin hosting/OAuth según propietario, sin móviles físicos y con capas Docker bloqueadas: Drive vivo, HTTPS remoto, dispositivos y contenedores permanecen pendientes. **v1Complete=false**.

Evidencias: artifacts/verification/final.json, docs/RELEASE_REPORT.md y docs/BLOCKERS.md. Credenciales, claves, medios y logs privados excluidos de Git. No se añadieron datos sintéticos a la biblioteca principal.

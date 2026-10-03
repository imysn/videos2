# Continuidad de la mejora PARTNER upload

Trabajo en `feat/rave-partner-upload` desde la base exacta `3d48ddf30bc2d55b800d208649af381fbb770101`; consultar HEAD para el commit publicado. La capacidad de upload local de PARTNER no concede `/admin`, publicación ni privilegios generales sobre `created_by`. Leer [PARTNER_UPLOAD](PARTNER_UPLOAD.md) y la regla permanente de AGENTS antes de tocar permisos. Las nuevas pruebas son parte de las suites normales; CI corre también Docker nativo amd64/ARM64 sobre esta rama. No hay deployment automático: Raspberry no fue accedida y no debe actualizarse sin una instrucción específica futura. Las referencias siguientes corresponden a tareas anteriores.

## Historial anterior

# Continuidad exacta

Revisión deployment del 2 de octubre: correcciones publicadas `de12747`/`60781d2`; CI nativa amd64/ARM64 run `36999714371` PASS_CONFIG/PASS_BUILD/PASS_RUNTIME, incluido bootstrap/migraciones/reinicios/persistencia. Evidencia descargada en artifacts/verification/deployment-*.json. Sin acceso a Raspberry. Reconciliación de cambios locales y preservación de volúmenes: RASPBERRY_TAILSCALE. Consultar HEAD para commit de documentación final. Drive vivo/móviles físicos pendientes, sin rediseño del producto. Lo siguiente es historial anterior, no procesos/paths activos garantizados en esta sesión.

Rama feat/rave-private-v1; aplicación final publicada d5c9004. El commit de cierre añade documentación/evidencias y amplía regresiones de teclado y runner Drive conectado a API activa sin modificar el código de aplicación. Consultar git log para el HEAD exacto; no descartar cambios existentes.

Verificación limpia final PASS: 64 unitarias, 69 integración, 31 seguridad, 14 contratos Drive,12 E2E; setup/build/formato/lint/tipos. Ampliación final de contratos Drive: 15 PASS; sin OAuth la prueba viva devuelve bloqueo2. Soak final PASS:1800,262 s, 3368 muestras, p95 24,6 ms, máximo127,7 ms, cero pausas, RSS máximo 285,2 MiB. API/worker/room-core/engine idénticos entre c790bd5 del soak y d5c9004 final. Backup/restore:786 archivos, RTO 16,292 s,vídeo/seek real. Evidencias públicas artifacts/verification/final.json y artifacts/sync/source-scope.json.

Principales activos en la sesión: PostgreSQL loopback:54329, API/SPA/Socket.IO loopback:3000 terminal 37410, worker terminal 57748. Configuración .local/config.json y datos/claves privados en /workspace/rave-runtime/state; no imprimir valores. Ambas cuentas requieren cambio inicial de contraseña; smoke efectuado y sesiones de prueba cerradas. Backup principal cifrado es local, no protege frente a pérdida del host. Los procesos no se prometen tras cerrar/restaurar el entorno.

Fuentes limpias: /workspace/rave-clean-c790bd5 (soak) y /workspace/rave-clean-9410221 (archivo final d5c9004; 153 blobs verificados; setup/DB/keys generados allí). Namespaces test/validation_clean_9410221 separados. Suites final y E2E terminadas; los servidores de prueba se cerraron. No reutilizar las credenciales sintéticas como contraseñas reales.

Siguiente acción concreta depende del recurso habilitado: si existe destino HTTPS autorizado, activar producción según docs/OPERATIONS.md y verificar OPS-05; con OAuth/Picker del proyecto y consentimiento owner, ejecutar pnpm test:providers:live para SRC-07. No inventar recursos ni pedir secretos por chat. Mantener UX-04 y partes Docker pendientes hasta móviles físicos/capas autorizadas. Git push funciona; API de PR Forbidden, PR no creada. Borrador cloud guardado (instalación/arranque/dominios), no aplicado. No afirmar V1 completa mientras esos gates esenciales sigan pendientes.

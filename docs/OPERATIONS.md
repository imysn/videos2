# Operación

## Cloud y procesos

Usar el checkout existente `/workspace/videos2`; no crear otro worktree para onboarding. `bash scripts/cloud-setup.sh` verifica Node 24.19.0, instala pnpm 11.19.0, conserva PostgreSQL/age privados, inicia PostgreSQL, migra, ejecuta bootstrap idempotente y compila. Descarga paquetes Debian oficiales con firmas verificadas. FFmpeg/ffprobe y Chromium deben estar en la imagen del entorno; el script los comprueba.

Los procesos pueden perderse al restaurar/publicar el entorno. Reanudar con `pnpm local:db`, `pnpm env:check`, `pnpm start` y, en otra terminal, `pnpm worker`. Verificar `/health/live`, `/health/ready` y una operación funcional. `pnpm dev`/`pnpm dev:web` son opciones con watchers; no usarlas para el soak.

Configuración privada: `.local/config.json`; estado nativo en `rave-runtime/state`, contiguo al checkout. `RAVE_CONFIG_FILE` selecciona JSON; variables de entorno prevalecen. Overrides del runtime: `RAVE_RUNTIME_DIR`, `RAVE_RUNTIME_ROOT`, `RAVE_PG_BIN`, `RAVE_AGE_BIN`. Los secrets son archivos absolutos 0600; la clave maestra contiene 32 bytes aleatorios en base64. No publicar configuración privada ni credenciales.

Producción exige `APP_ENV=production`, origen HTTPS y cookie segura `__Host-rave`. `BOOTSTRAP_CREDENTIALS_FILE` debe estar en directorio privado escribible, separado del montaje de secretos de solo lectura. Dos slots/sala única también se restringen en SQL.

## Docker y HTTPS

```sh
pnpm exec tsx scripts/compose-prepare.ts
docker compose --env-file .local/compose.env -f compose.yaml -f compose.local.yaml config --quiet
docker compose --env-file .local/compose.env -f compose.yaml -f compose.local.yaml up -d --build
```

El override local expone solo loopback. Para producción, configurar el destino autorizado en el archivo privado: `PUBLIC_ORIGIN`, `RAVE_HOST` y destinatario age; utilizar `compose.yaml` sin override. Caddy requiere DNS/conectividad reales para TLS. No existe actualmente alojamiento autorizado.

Volúmenes persistentes: DB, medios, backups, credenciales iniciales y Caddy. App/worker usan UID 1000, imagen de solo lectura y capacidades retiradas; worker limita CPU/memoria. Los secrets Compose no cifran el disco del host. Sus archivos deben conservar permisos 0600 compatibles con UID 1000.

En cloud conservar proxy/CA oficiales. Dockerfile admite CA como secreto BuildKit `proxy_ca`; no desactivar TLS ni copiar credenciales/CA privadas a la imagen. La política activa deniega descargar imágenes. `compose config` solo acredita estructura, no ejecución de contenedores.

## Drive

En un proyecto Google destinado a Rave, configurar OAuth web, Drive API y Picker API: redirect exacto `${PUBLIC_ORIGIN}/api/v1/admin/drive/callback`, origen Picker HTTPS, client ID, archivo privado del client secret, API key Picker restringida y número de proyecto. Solo se solicita `drive.file`. Jason se reautentica, conecta y selecciona archivos expresamente mediante Picker.

Token breve Picker solo en memoria del navegador; refresh tokens/referencias cifrados en DB. La pareja usa relay autenticado. Cambios de versión/tamaño/duración bloquean bytes. Desconectar elimina acceso local aunque Google falle; `remoteRevoked=false` no acredita retirada del consentimiento remoto.

El propietario confirma que no tiene configuración ni consentimiento. La prueba viva exige una ficha autorizada identificada por `RAVE_LIVE_MEDIA_ID`. Los contratos controlados no acreditan Google vivo. `pnpm test:providers:live` utiliza el SDK real, fuerza la renovación del token breve y observa playback/seek/pausa en dos contextos; no devuelve PASS sin ello. Ejecutarlo con el API detenido y el proxy HTTPS del destino de prueba apuntando al puerto configurado.

Con Compose, una vez configurado Google, añadir `-f compose.drive.yaml` para montar el client secret privado y los parámetros públicos en el archivo de entorno privado. No montar ese secreto mientras no exista; la base funciona sin Google configurado.

## Copias y restauración

Configurar `BACKUP_TARGET` y `BACKUP_RECIPIENT` (clave pública age). `pnpm backup` activa mantenimiento de catálogo/uploads/procesamiento, espera trabajos, crea dump SQL y manifest/checksums de medios propios, cifra con age y restaura el modo previo. Conserva siete días distintos de copias y cuatro grupos semanales. Excluye clave maestra y vídeos remotos. Una copia en disco local no protege frente a pérdida del host.

Guardar identidad age y clave maestra por un canal separado. `BACKUP_KEY_FILE` se usa al restaurar. El worker de producción ejecuta automáticamente una copia cada 24 h cuando está libre; el advisory lock serializa copias y el estado durable evita duplicados tras reinicio. Ante fallo reintenta después de una hora. Requiere destinatario y destino configurados, capacidad de disco y worker en funcionamiento. Vigilar edad de la última copia para sostener el objetivo RPO 24 h. `pnpm backup --profile test` y `pnpm restore:verify --profile test` usan datos sintéticos. La restauración crea DB/directorio distintos y comprueba login, catálogo, vídeo y seek. Revoca sesiones restauradas y quita mantenimiento exclusivamente en ese namespace. Nunca verifica encima de producción.

Para recuperación operativa, comprobar manifest y claves antes de promover el namespace nuevo; conservar el origen hasta validar. No reutilizar sesiones restauradas. Antes de actualizar: backup verificado, build anterior conservado, migraciones ensayadas y pruebas. SQL guarda checksums; no editar migraciones ejecutadas. Rollback de código solo si el esquema es compatible; si no, restaurar backup en DB nueva y validar antes de cambiar destino.

Administración muestra almacenamiento, jobs e integraciones. Logs omiten secretos/URLs sensibles, errores llevan correlationId. Retención por defecto: chat 30 días, recibos 24 h, logs siete días. Mantener trazas de navegador con credenciales en directorios ignorados y retirarlas tras diagnóstico.

Referencia inicial: 2 vCPU/4 GiB, un job y dos hilos de encoder; no garantiza velocidad. Egress aproximado: bitrate Mbps × espectadores × 0.45 GB/h; dos espectadores a 4 Mbps ~3.6 GB/h más overhead. No hay infraestructura contratada ni tráfico externo medido.

## Rotación de clave y migraciones

Detener API y worker. Crear una nueva clave aleatoria de 32 bytes en base64 en un archivo absoluto 0600 del proyecto, conservando la clave anterior separadamente. Ejecutar `pnpm rotate:key --new-key-file /ruta/privada/nueva-clave` con `RAVE_CONFIG_FILE` apuntando al JSON de la instancia y sin override `MASTER_KEY_FILE`. El comando adquiere exclusión de API, comprueba jobs, cifra un backup previo, reenvuelve referencias/tokens/recibos en una transacción y revoca sesiones/leases. Promueve la ruta de la clave en el JSON y restaura el mantenimiento previo. No imprime claves ni tokens.

Ante interrupción después de confirmar la transacción, `pnpm rotate:key --new-key-file /ruta/privada/nueva-clave --resume` verifica el marcador durable y la huella de la nueva clave antes de promoverla. Una instancia con la clave anterior rechaza arranque. Conservar journal privado `config.json.rotation.json`, ambas claves y backup; para otra rotación, archivar el journal completado en almacenamiento privado antes de empezar. Nunca sobrescribirlo si la fase sigue pendiente.

La migración `002_job_generation.sql` cancela jobs antiguos sin generación capturada: `CONTENT_GENERATION_UNKNOWN`. No infiere la identidad del contenido ni destruye originales. Volver a preparar el original desde administración crea un job con generación actual. La prueba OPS-06 restaura el esquema anterior en otro namespace y verifica datos antes de reaplicar migraciones compatibles; no acredita rollback de una imagen Docker que no se ha podido ejecutar.

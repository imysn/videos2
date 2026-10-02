# Deployment en Raspberry Pi + Tailscale

GitHub (`imysn/videos2`, `feat/rave-private-v1`) es la fuente oficial. Publicar código no actualiza los contenedores de la Raspberry. Esta revisión recoge el deployment comunicado por el propietario: Pi 5 Model B Rev 1.0, 8 GB, ARM64, Raspberry Pi OS Lite/Debian 13 Trixie, Ethernet y microSD 128 GB (unos 107 GB libres al inicio). DB PostgreSQL 17.11/API healthy, worker, FFmpeg, bootstrap y HTTPS privado mediante Serve funcionan allí según ese despliegue. Codex no accede ni modifica esa instancia en esta tarea. Su hostname y secretos quedan externos.

## Requisitos y arquitectura

- Raspberry Pi OS **64 bits** (`uname -m`: `aarch64`), Git, Docker Engine y plugin Docker Compose.
- Node 24.19.0 y pnpm 11.19.0 para ejecutar una vez el tooling de secrets; runtime en Docker.
- Tailscale instalado en el host Linux, acceso autorizado al tailnet y HTTPS/Serve habilitados.
- Espacio para originales, derivados, DB, imágenes, temporales y backups.

Cliente autorizado → HTTPS/Tailscale → Tailscale Serve → `127.0.0.1:3000` → app → DB/worker. Tailscale termina TLS como infraestructura externa; no es dependencia del código de negocio. La imagen conserva amd64: Docker elige la arquitectura del host, sin fijar ARM64 en Compose.

## Instalar y conectar Tailscale

Seguir [las instrucciones oficiales Linux](https://tailscale.com/download/linux), seleccionando Debian Trixie para este host y conservando firmas APT y validación TLS. No guardar auth keys, cuentas ni credenciales Tailscale en el checkout.

```sh
sudo systemctl enable --now tailscaled
sudo tailscale up
sudo tailscale set --operator="$(id -un)"
tailscale status
```

Completar autorización en el navegador; habilitar MagicDNS y certificados HTTPS/Serve en el tailnet si se solicitan. Aplicar la política de acceso del tailnet a los clientes autorizados. Serve es privado; este perfil no utiliza Funnel.

## Primera instalación

```sh
git clone --branch feat/rave-private-v1 https://github.com/imysn/videos2.git
cd videos2
pnpm install --frozen-lockfile
PUBLIC_ORIGIN=https://HOSTNAME-TAILNET.ts.net RAVE_IMAGE_TAG=pi-v1 \
  pnpm exec tsx scripts/compose-prepare.ts --production
```

Sustituir el hostname por el de esta instalación. El tooling crea secrets aleatorios 0600 bajo `.local/production/` y `.local/compose.env` 0600; conserva archivos existentes. En un deployment ya creado, editar su archivo privado, sin regenerar clave maestra ni contraseña PostgreSQL. `RAVE_SECRET_DIR` y `RAVE_COMPOSE_ENV_FILE` seleccionan otros destinos. Comprobar `git check-ignore .local/compose.env`.

Configuración privada externa:

```dotenv
PUBLIC_ORIGIN=https://HOSTNAME-TAILNET.ts.net
RAVE_IMAGE_TAG=pi-v1
RAVE_SECRET_DIR=./.local/production
# Destinatario PUBLICO age para backups; configurar cuando exista.
BACKUP_RECIPIENT=
```

`RAVE_HOST` no se usa en Tailscale; puede estar ausente/vacío. Solo Caddy lo necesita al arrancar. `APP_ENV=production` y `COOKIE_SECURE=true` permanecen en el Compose base. El HTTP interno de Serve a loopback no cambia el origen HTTPS del navegador. Desarrollo/test siguen limitados a loopback; no hay excepción para la LAN.

Los secrets deben ser legibles por UID 1000 (`node`) y conservar 0600. Si el administrador Linux tiene otro UID, ajustar el propietario únicamente de los archivos destinados al contenedor (`sudo chown 1000:1000 .local/production/{postgres_password,database_url,master_key}`); conservar acceso del administrador del host. No imprimirlos en logs.

```sh
docker compose --env-file .local/compose.env -f compose.yaml -f compose.tailscale.yaml config --quiet
docker compose --env-file .local/compose.env -f compose.yaml -f compose.tailscale.yaml build
docker compose --env-file .local/compose.env -f compose.yaml -f compose.tailscale.yaml up -d --wait --wait-timeout 180
tailscale serve --bg 3000
tailscale serve status
```

Serve debe indicar `https://HOSTNAME-TAILNET.ts.net (tailnet only)` y `/ proxy http://127.0.0.1:3000`. El puerto 3000 queda ligado únicamente a `127.0.0.1`; Caddy está desactivado por perfil. Si todavía queda Caddy ejecutándose de un deployment anterior, detener solo ese servicio después de comprobar Serve (`docker compose --env-file .local/compose.env -f compose.yaml stop caddy`), conservando sus volúmenes. No activar el perfil `disabled`.

La API migra con checksums y hace bootstrap al iniciar. Crea exactamente `jason`/OWNER y `pareja`/PARTNER si faltan; conserva cuentas existentes. Las contraseñas aleatorias iniciales están en `/private/bootstrap-credentials.json`, volumen `private`. Para leerlas en una terminal privada:

```sh
docker compose --env-file .local/compose.env -f compose.yaml -f compose.tailscale.yaml exec app cat /private/bootstrap-credentials.json
```

No compartir ni guardar la salida en Git. Ambas cuentas deben cambiar contraseña inicialmente en `/account`; el frontend bloquea otras rutas hasta hacerlo. Solo OWNER accede a `/admin`; el esquema impide deshabilitarlo.

## Health y reinicio automático

```sh
docker compose --env-file .local/compose.env -f compose.yaml -f compose.tailscale.yaml ps
curl --fail http://127.0.0.1:3000/health/ready
docker compose --env-file .local/compose.env -f compose.yaml -f compose.tailscale.yaml port app 3000
docker compose --env-file .local/compose.env -f compose.yaml -f compose.tailscale.yaml exec worker ffmpeg -version
sudo systemctl enable docker tailscaled
```

Esperado: DB/app healthy, worker running, readiness 200 y puerto `127.0.0.1:3000`. Desde un cliente del tailnet comprobar también `https://HOSTNAME-TAILNET.ts.net/health/ready`, login y playback. Un 200 local no acredita HTTPS remoto.

Compose usa `restart: unless-stopped`; Serve `--bg` persiste en tailscaled. Tras reinicio del host repetir `ps`, health y `tailscale serve status`. Un contenedor detenido expresamente necesita `up -d`.

## Reconciliar las modificaciones locales y actualizar sin perder datos

Utilizar el checkout, archivo privado y **nombre de proyecto Compose actuales**. Si se utilizaba `-p`/`COMPOSE_PROJECT_NAME`, repetir ese mismo nombre en todos los comandos: cambiarlo crea otros volúmenes. Los ejemplos asumen el nombre base `rave-private`.

Antes de actualizar, crear y verificar backup según la sección siguiente, registrar volúmenes montados con `docker inspect`/`docker volume inspect` y conservar imagen anterior (`docker image tag rave-private:pi-v1 rave-private:pre-update-FECHA`). No borrar imágenes/volúmenes durante la actualización.

Guardar los dos archivos corregidos manualmente en una carpeta privada ignorada:

```sh
umask 077
rave_reconcile=".local/reconcile-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$rave_reconcile"
git status --short
git branch --show-current
git diff --cached --quiet
git diff --name-only
git rev-parse HEAD > "$rave_reconcile/old-head"
git diff --binary -- infra/Dockerfile compose.yaml > "$rave_reconcile/local.patch"
cp infra/Dockerfile "$rave_reconcile/Dockerfile.local"
cp compose.yaml "$rave_reconcile/compose.local.yaml"
git fetch origin feat/rave-private-v1
# Sustituir por el SHA concreto entregado; no elegir un commit futuro sin verificar.
rave_target=SHA_PUBLICADO_Y_VERIFICADO
git cat-file -e "$rave_target^{commit}"
git merge-base --is-ancestor HEAD "$rave_target"
git show "$rave_target:infra/Dockerfile" > "$rave_reconcile/Dockerfile.target"
git show "$rave_target:compose.yaml" > "$rave_reconcile/compose.target.yaml"
git show "$rave_target:compose.tailscale.yaml" > "$rave_reconcile/compose.tailscale.target.yaml"
diff -u "$rave_reconcile/Dockerfile.local" "$rave_reconcile/Dockerfile.target"
diff -u "$rave_reconcile/compose.local.yaml" "$rave_reconcile/compose.target.yaml"
```

La rama debe ser `feat/rave-private-v1`, sin cambios staged y con modificaciones solo en los dos archivos conocidos. Si hay otros cambios/commits divergentes/diferencias inesperadas, conservar todo y reconciliarlos antes de continuar. `diff` devuelve 1 al encontrar diferencias: revisar cada una.

Comprobar equivalencia funcional: certificados instalados antes de HTTPS, CA opcional segura, pins FFmpeg/PostgreSQL/age, `COPY tests tests` y tmpfs único `"/tmp:size=268435456,mode=1777"`. Si el Compose local también incluía Tailscale manualmente, puerto loopback y Caddy desactivado están ahora en el override. Validar la propuesta antes de restaurar los archivos:

```sh
docker compose --project-directory "$PWD" --env-file .local/compose.env \
  -f "$rave_reconcile/compose.target.yaml" -f "$rave_reconcile/compose.tailscale.target.yaml" config --quiet
docker compose --project-directory "$PWD" --env-file .local/compose.env \
  -f "$rave_reconcile/compose.target.yaml" -f "$rave_reconcile/compose.tailscale.target.yaml" config --services
```

Debe listar solo db/app/worker y conservar origen HTTPS, rutas privadas y nombres de volúmenes. `RAVE_HOST` existente puede conservarse: el perfil privado no lo usa. **Solo después de verificar que los commits incorporan todos los ajustes locales**, restaurar esos dos archivos al HEAD antiguo y avanzar por fast-forward:

```sh
git restore --source=HEAD --worktree -- infra/Dockerfile compose.yaml
git merge --ff-only "$rave_target"
git diff --exit-code "$rave_target" -- infra/Dockerfile compose.yaml compose.tailscale.yaml
git status --short
git check-ignore .local/compose.env .local/production/master_key
docker compose --env-file .local/compose.env -f compose.yaml -f compose.tailscale.yaml config --quiet
docker compose --env-file .local/compose.env -f compose.yaml -f compose.tailscale.yaml build
docker compose --env-file .local/compose.env -f compose.yaml -f compose.tailscale.yaml up -d --wait --wait-timeout 180
docker compose --env-file .local/compose.env -f compose.yaml -f compose.tailscale.yaml ps
curl --fail http://127.0.0.1:3000/health/ready
tailscale serve status
git status --short
```

`git status --short` debe estar vacío; `.local/` y el respaldo siguen ignorados. Conservar el patch privado; reaplicarlo duplicaría cambios incorporados. Comprobar biblioteca, cuentas, vídeos, configuración y backups por HTTPS desde ambos clientes. `build` + `up -d` conserva los volúmenes y ejecuta migraciones/bootstrap idempotentes. **No ejecutar `down -v`**: destruye datos. Rollback de imagen solo con esquema compatible; en otro caso restaurar en namespace nuevo antes de promoverlo.

## Backup, restore y storage

Mantener `database`, `media`, `backups`, `private`, `caddy_data`, `caddy_config` y configuración privada. Con `BACKUP_RECIPIENT` ya configurado en el contenedor actual:

```sh
docker compose --env-file .local/compose.env -f compose.yaml -f compose.tailscale.yaml exec -T app /app/entrypoint.sh backup
```

El tooling cifra dump PostgreSQL/medios propios con age y manifest/checksums. El worker copia cada 24 h cuando está libre y configurado. La identidad age y clave maestra se conservan separadas del backup y del host. La copia lógica no incluye automáticamente `.local/`, credenciales bootstrap ni Caddy: respaldarlos adicionalmente por un canal privado preservando permisos/propietarios. Una copia en la misma microSD no protege frente a pérdida del host.

Si aún no hay destinatario age, preparar antes de actualizar una copia offline consistente de los seis volúmenes y configuración privada en disco externo: detener app/worker y luego DB, verificar parada, copiar preservando permisos/propietarios y volver a arrancar. No tratar una copia de PostgreSQL en ejecución como backup consistente. Restaurar siempre en DB/directorios/volúmenes distintos; validar login, catálogo, checksums, vídeo/seek antes de promover. [OPERATIONS](OPERATIONS.md) detalla `restore:verify`, claves y recuperación.

microSD 128 GB sirve para pruebas/uso inicial. Para vídeos intensivos, recomendar SSD/NVMe posteriormente; esta tarea no implementa migración automática. Una futura copia offline verificada del almacenamiento persistente debe conservar PostgreSQL, biblioteca/metadata, originales/derivados, cuentas, credenciales/configuración y backups, incluidos volúmenes Caddy.

Defaults conservados: 20 GiB por archivo (`MAX_UPLOAD_BYTES=21474836480`), chunks de 8 MiB (`UPLOAD_CHUNK_MAX_BYTES=8388608`), un job y dos hilos FFmpeg. El máximo configurado no reserva ni garantiza espacio: originales/derivados/backups coexisten.

## Memoria y cgroups

El worker conserva `memory: 2G`. El warning del kernel «Limitation discarded» señala falta de enforcement del host, no un fallo del worker ni la causa de APT/build/tmpfs.

```sh
docker info
docker inspect --format '{{.HostConfig.Memory}}' "$(docker compose --env-file .local/compose.env -f compose.yaml -f compose.tailscale.yaml ps -q worker)"
docker compose --env-file .local/compose.env -f compose.yaml -f compose.tailscale.yaml exec worker sh -c 'cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes'
```

Esperado: 2147483648 bytes solicitados y ese límite efectivo en cgroup (`memory.max` v2; `max` implica ilimitado). `HostConfig.Memory` solo acredita lo solicitado; `docker stats` ayuda a observar uso/límite. Algunos kernels Pi requieren habilitar memory cgroup en el arranque y reiniciar: consultar instrucciones de esa versión OS/kernel antes de editar `/boot/firmware/cmdline.txt`. No retirar el límite del Compose.

## Caddy alternativo y conectividad

Para un VPS/IP pública/IPv6 entrante permitida, usar `compose.yaml` sin override con `PUBLIC_ORIGIN=https://DOMINIO`, `RAVE_HOST=DOMINIO`, DNS y entrada 80/443 para ACME. Caddy y sus volúmenes permanecen disponibles con TLS válido.

En el ensayo público comunicado, AAAA y Caddy funcionaron pero ACME HTTP-01/TLS-ALPN-01 recibió `Timeout during connect`. IPv4 WAN privada distinta de la pública externa confirmó CGNAT; IPv6 global también tenía entrada bloqueada. Es un límite ISP/router móvil, no bug Rave/Caddy. No desactivar TLS ni usar certificados autofirmados en producción. Cloudflare Tunnel no es requisito ni arquitectura actual para los vídeos.

## Fuentes HTTPS y Drive

Conservar URL → Verificar enlace → `/admin/sources/inspect` (API bajo `/api/v1`) → tipo/duración/estrategia → Crear borrador → source → READY → publicar. Solo MP4/WebM directos, HLS/DASH compatibles y fuentes autorizadas; no scraper HTML, blob, extracción arbitraria, DRM ni bypass de autenticación.

Drive mantiene API oficial, Picker, `drive.file`, relay autenticado y refresh token cifrado. Añadir `compose.drive.yaml` solo cuando existan secretos externos. El HTTPS Tailscale no acredita OAuth ni consentimiento real.

Antes de registrar OAuth definitivo, revisar [validación de redirect URI](https://developers.google.com/identity/protocols/oauth2/web-server#uri-validation) y [políticas OAuth](https://developers.google.com/identity/protocols/oauth2/policies): HTTPS salvo excepciones loopback, redirect exacto sin comodines, hostname válido, origen JavaScript Picker exacto y requisitos de dominios autorizados/verificación de propiedad aplicables en Google Console. El certificado Tailscale no acredita propiedad de `ts.net` ni capacidad de verificar el dominio registrable exigido. Probar aceptación del hostname completo en la consola; si no puede registrarse/verificarse, resolver un dominio HTTPS controlado por el propietario manteniendo acceso privado antes de autorizar. El navegador que recibe el callback necesita acceso al tailnet.

La consulta en línea de esas páginas desde esta sesión fue bloqueada HTTP 403 por la política de red. La aceptación actual de `*.ts.net` por Google Console queda sin verificar. No inventar autorización: los contract tests y la futura prueba live se distinguen en [PROVIDERS](PROVIDERS.md).

## Regresión Docker y ARM64

```sh
pnpm test:deployment linux/amd64
pnpm test:deployment linux/arm64
```

Ejecutar cada plataforma en host nativo o con binfmt/QEMU previamente configurado. Requiere localhost:3000 libre. Crea proyectos únicos, secrets sintéticos y volúmenes separados; logs privados en `.local/deployment-*`. La CA opcional de cloud se proporciona por BuildKit mediante `CODEX_PROXY_CERT`; Raspberry normal no la necesita. CI utiliza runners nativos amd64 y ARM64.

Cada reporte `artifacts/verification/deployment-{amd64,arm64}.json` distingue:

- `PASS_CONFIG`: producción, cookie segura, Caddy desactivado, puerto loopback y tmpfs único.
- `PASS_BUILD`: imagen completa de la arquitectura; el build incluye scripts y helpers tests.
- `PASS_RUNTIME`: argon2/sharp nativos, Node, FFmpeg encode/ffprobe, age y PostgreSQL client; Docker rechaza tmpfs antiguo y crea contenedores corregidos; DB/app healthy, worker running, readiness 200 interno/host; migraciones/bootstrap idempotentes y persistencia tras reinicios/recreación.

El script usa `down` sin `-v`, conserva sus volúmenes y no apunta a producción. `--config-only` deja BUILD/RUNTIME en false. Build bloqueado o CI configurada no equivalen a PASS. El build comunicado por el propietario en Pi y la evidencia ejecutada en esta sesión se registran por separado en [DEPLOYMENT](DEPLOYMENT.md).

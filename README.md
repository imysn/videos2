# Rave privado

Dos cuentas, una biblioteca privada y una sala compartida con reproductor propio. Alcance y stack: [plan maestro](docs/MASTER_PLAN.md). Estado verificable: [IMPLEMENTATION_STATUS](docs/IMPLEMENTATION_STATUS.md) y [BLOCKERS](docs/BLOCKERS.md). [Informe de entrega](docs/RELEASE_REPORT.md).

Interfaz completa en **Español, Polski y English**, con selección individual persistida por cuenta. Sin preferencia guardada, Jason/OWNER usa ES y pareja/PARTNER usa PL. Selector en login, Cuenta y navegación, también durante reproducción. [Guía i18n y reglas obligatorias para futuras funciones](docs/I18N.md): catálogos tipados, paridad, plurales, control AST y CI.

[Entrega i18n y resultados verificables](docs/I18N_RELEASE.md), con cobertura I18N-01–20 y límites reales de las pruebas.

[Subidas: transferencia, cola y procesamiento](docs/UPLOAD_PIPELINE.md): borradores persistentes, progreso real, cancelación/reintento y benchmark reproducible. Llegar al 100 % de transferencia guarda el original; el worker prepara el vídeo antes de habilitar Publicar.

## Arranque en este entorno cloud

Desde la raíz, con Node 24.19.0:

```sh
bash scripts/cloud-setup.sh
pnpm start
```

En otra terminal del mismo repositorio: `pnpm worker`. La API sirve SPA y Socket.IO en loopback, puerto 3000. No es una publicación accesible desde vuestros dispositivos. El bootstrap conserva las cuentas existentes, guarda credenciales iniciales en un archivo privado del runtime y exige cambiarlas al entrar.

## Verificación

```sh
pnpm test:prepare
pnpm exec tsx scripts/test-prepare.ts validation
pnpm build
RAVE_CONFIG_FILE=.local/validation/config.json pnpm verify
pnpm test:soak
pnpm backup --profile test
pnpm restore:verify --profile test
```

Las pruebas usan datos sintéticos y DB separada. `RAVE_TEST_DATABASE_SUFFIX` permite namespaces de ensayo independientes; `test:prepare` genera sus credenciales y claves privadas de backup. Los suites que usan la misma DB se ejecutan secuencialmente. El soak dura 30 minutos reales: no modificar su DB ni reiniciar su API. `verify:release` lo incluye. `test:providers:live` devuelve estado bloqueado y código 2 si no hay autorización real; no sustituirlo por PASS.

Configuración sin secretos: [.env.example](.env.example). [Operación y recuperación](docs/OPERATIONS.md), [uso](docs/USER_GUIDE.md), [seguridad](docs/SECURITY.md).

## Deployment en Raspberry Pi + Tailscale

Perfil privado actual: `compose.yaml` + `compose.tailscale.yaml`; app en producción y puerto ligado a `127.0.0.1:3000`, HTTPS terminado por Tailscale Serve. `PUBLIC_ORIGIN` se configura externamente. Caddy permanece como alternativa pública.

[Guía completa Raspberry + Tailscale](docs/RASPBERRY_TAILSCALE.md), incluida **reconciliación segura de los cambios locales existentes antes de actualizar**, health, cgroups, storage y backups. [Resultados de deployment](docs/DEPLOYMENT.md). Verificación real por arquitectura: `pnpm test:deployment linux/amd64` / `linux/arm64`, con CONFIG/BUILD/RUNTIME separados.

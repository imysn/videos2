# Rave privado

Dos cuentas, una biblioteca privada y una sala compartida con reproductor propio. Alcance y stack: [plan maestro](docs/MASTER_PLAN.md). Estado verificable: [IMPLEMENTATION_STATUS](docs/IMPLEMENTATION_STATUS.md) y [BLOCKERS](docs/BLOCKERS.md).

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
pnpm build
pnpm verify
pnpm test:soak
pnpm backup --profile test
pnpm restore:verify --profile test
```

Las pruebas usan datos sintéticos y DB separada. El soak dura 30 minutos reales: no modificar su DB ni reiniciar su API. `verify:release` lo incluye. `test:providers:live` devuelve estado bloqueado y código 2 si no hay autorización real; no sustituirlo por PASS.

Configuración sin secretos: [.env.example](.env.example). [Operación y recuperación](docs/OPERATIONS.md), [uso](docs/USER_GUIDE.md), [seguridad](docs/SECURITY.md).

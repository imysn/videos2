# Decisiones de ejecución

Revisión deployment del 2 de octubre: Tailscale Serve es el perfil privado actual externo al producto. PUBLIC_ORIGIN permanece configurable; producción y cookies seguras, app solo localhost:3000 y Caddy alternativo intacto. ARM64 es destino soportado junto a amd64, con build/runtime nativos en CI y estados CONFIG/BUILD/RUNTIME separados. GitHub es fuente oficial; actualizar la Pi requiere reconciliar sus dos archivos modificados, conservar proyecto/volúmenes/secrets y ejecutar build/up según RASPBERRY_TAILSCALE. Sin cambios de UI/stack/proveedores/storage ni eliminación de límites por warnings de cgroups.

- Fuente de verdad: MASTER_PLAN.md, copia íntegra del paquete original verificado por SHA256.
- Se construye en la raíz del checkout existente `/workspace/videos2`; corresponde al árbol `rave-private/` del plan. Se conservan los doce archivos del paquete.
- Rama de implementación: `feat/rave-private-v1`. No se fusiona ni se reescribe main.
- Desarrollo exclusivamente en loopback. Producción privada actual en Pi + Tailscale según deployment comunicado; Caddy queda como alternativa pública cuando exista entrada de red permitida.
- PostgreSQL 17 real, sin reemplazarlo por SQLite ni mocks. Worker separado, dos hilos de FFmpeg.
- Cache de herramientas e instalación nativa dentro de `/workspace/rave-runtime`; no se altera el HOME ni servicios de otras aplicaciones.

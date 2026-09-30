# Decisiones de ejecución

- Fuente de verdad: MASTER_PLAN.md, copia íntegra del paquete original verificado por SHA256.
- Se construye en la raíz del checkout existente `/workspace/videos2`; corresponde al árbol `rave-private/` del plan. Se conservan los doce archivos del paquete.
- Rama de implementación: `feat/rave-private-v1`. No se fusiona ni se reescribe main.
- Desarrollo exclusivamente en loopback. No se ha proporcionado un destino público autorizado.
- PostgreSQL 17 real, sin reemplazarlo por SQLite ni mocks. Worker separado, dos hilos de FFmpeg.
- Cache de herramientas e instalación nativa dentro de `/workspace/rave-runtime`; no se altera el HOME ni servicios de otras aplicaciones.

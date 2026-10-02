# Estado de deployment · revisión del 2 de octubre de 2026

El propietario comunica un deployment real funcional en Raspberry Pi 5 ARM64, con PostgreSQL 17.11/API healthy, worker y FFmpeg running, migraciones/bootstrap y acceso HTTPS privado mediante Tailscale Serve. Esta sesión trabaja exclusivamente sobre GitHub; no modifica ni verifica directamente esa Raspberry. El origen HTTPS sigue suministrándose por `PUBLIC_ORIGIN`, sin hostname de instalación en el producto.

Procedimiento soportado: [Deployment en Raspberry Pi + Tailscale](RASPBERRY_TAILSCALE.md). `compose.tailscale.yaml` conserva producción/cookie segura, publica app solo en `127.0.0.1:3000` y desactiva Caddy. La base conserva Caddy para un destino público con conectividad entrante. Desarrollo/test mantienen protección loopback.

Esta revisión separa CONFIG, BUILD y RUNTIME en `artifacts/verification/deployment-{amd64,arm64}.json`. Docker Hub devolvió 429 en el entorno Codex antes de descargar la base; GitHub Actions sí construyó ambas imágenes y ejecutó sus dependencias nativas. Los resultados completos, commit y ejecución CI se registran en RELEASE_REPORT. Configuración válida y build no acreditan arranque por sí solos.

Drive vivo/OAuth no están configurados ni verificados. La guía documenta la comprobación pendiente de Google Console para dominios Tailscale y no atribuye consentimiento a los contract tests. Las pruebas de dispositivos físicos siguen separadas. El fallo ACME con el ISP/router móvil comunicado corresponde a conectividad entrante/CGNAT; Caddy/TLS no se modifican para sortearlo.

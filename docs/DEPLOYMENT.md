# Estado de despliegue

**No publicado.** El propietario confirmó que todavía no tiene alojamiento ni OAuth configurados. No existe URL HTTPS autorizada para que ambos accedan desde sus dispositivos. Git push no despliega la aplicación.

El checkout contiene Dockerfiles, Compose, Caddy y scripts reproducibles. API/SPA/Socket.IO y worker pueden operar por procesos nativos en el entorno disponible; PostgreSQL y medios persisten fuera del checkout en almacenamiento privado. El modo de desarrollo expone únicamente loopback, sin cookie ni dominio de producción ficticios.

Producción exige configuración del destino autorizado: origen HTTPS/DNS real, cookie Secure, claves por archivos privados, destinatario de backups, volumen persistente y acceso Google del proyecto. `compose.local.yaml` se utiliza solo para desarrollo; `compose.drive.yaml` añade el secreto oficial de Google cuando exista. No publicar `.local/compose.env` ni los secretos.

La configuración Compose se valida estructuralmente. La ejecución/auditoría de imágenes permanece bloqueada por la política de red que deniega sus capas. El borrador cloud conserva los dominios oficiales requeridos, instalación y arranque; no aplica esa política ni crea infraestructura.

Antes de afirmar despliegue, ejecutar en ese destino: descarga/build autenticados, migración/bootstrap idempotentes, healthchecks, login de ambas cuentas, autorización negativa, playback/seek compartido por HTTPS, refresh Drive vivo y backup/restore aislado. OPS-05 y SRC-07 se mantendrán pendientes hasta evidencias reales. No hay servicios contratados ni un dominio supuesto.

# Entorno comprobado

Linux x86_64, usuario agent/UID 1000; cinco CPU, ~33 GiB RAM. Node 24.19.0 y pnpm 11.19.0; FFmpeg/ffprobe 7.1.5 y Chromium. PostgreSQL 17.11 y age 1.2.1 extraídos en prefijo privado desde paquetes Debian oficiales con firmas verificadas. PG opera en loopback:54329; DB de aplicación y namespaces sintéticos separados.

Docker 28.4.0 y Compose 2.40.3 responden; configuraciones Compose local/producción validan estructuralmente. La descarga real de imágenes fue rechazada por política activa en el CDN oficial production.cloudfront.docker.com. Se guardaron dominios y scripts en borrador, lo que no aplica cambios a la instancia ni publica el entorno.

Estado cloud actual: conectado, revisión 3, sin bindings de secretos/identidades externas. El propietario confirma que no tiene alojamiento ni OAuth Google. Git HTTPS de lectura y push funcionan; la API de creación de PR devuelve Forbidden por política. No hay dispositivo físico conectado.

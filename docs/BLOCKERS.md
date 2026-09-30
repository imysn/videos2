# Dependencias externas

- **Drive live / SRC-07**: no hay GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET_FILE, GOOGLE_PICKER_API_KEY ni GOOGLE_CLOUD_PROJECT_NUMBER configurados para el proyecto, ni consentimiento OAuth. Se implementará el conector; su prueba real requiere configuración segura y seleccionar un vídeo autorizado. No se piden secretos en chat.
- **Despliegue / OPS-05**: no hay host, dominio HTTPS ni credenciales de un destino destinado a Rave. El funcionamiento del entorno será local, sin afirmar publicación.
- **Móvil físico / UX-04**: no hay dispositivo iPhone/Android físico conectado. Chromium/emulación se registrará por separado.
- **Imágenes Docker**: primer pull rechazado por red. Dominios oficiales necesarios guardados en borrador de entorno; guardar un borrador no prueba aplicación en la red activa. Se continúa por procesos nativos.

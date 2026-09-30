# Seguridad y límites

API, medios, segmentos, assets y sockets requieren sesión. Cookie HttpOnly/SameSite=Lax; producción Secure con prefijo `__Host-`. Mutaciones validan Origin, CSRF y schemas estrictos. Contraseñas Argon2id; sesiones/reset son tokens opacos almacenados como hash. Reset de un uso/30 minutos, reauth de diez minutos. Solo Jason administra; no puede desactivar el último owner ni crear un tercer slot.

AES-256-GCM cifra refresh tokens, referencias y recibos sensibles con AAD por entidad e ID. La clave maestra se guarda fuera de DB/backups. Age cifra las copias; recuperar exige identidad age y clave maestra por separado. No se implementa criptografía propia.

Safe-fetch exige HTTPS, resuelve y valida todas las IP, fija destino TLS y revalida cada redirect; rechaza redes privadas/metadatos, credenciales URL y protocolos inesperados. Límites de tiempo/tamaño y parsers acotados preceden a aceptar fuentes. HLS/DASH VOD sin DRM; CORS/orígenes aprobados también se restringen en CSP y motor. FFmpeg ejecuta argumentos sin shell y whitelist de formatos/protocolos locales.

Revocar sesión corta sockets y streams propios. Retirar ficha/Drive impide nuevas solicitudes y pausa sala. El backend puede cortar sus relays; no puede revocar una URL externa ya emitida por otro proveedor ni impedir grabación de contenido reproducible. No afirmar protección absoluta frente a cambios de una fuente ajena.

No añadir secretos a Git, storage del navegador, logs ni informes. Picker recibe token breve solo en memoria. Directorios `.local`, medios privados, age y trazas ZIP están ignorados. Las pruebas controladas se identifican como contratos; no equivalen a consentimiento ni acceso Google vivo.

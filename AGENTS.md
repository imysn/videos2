# Rave privado — instrucciones de implementación

## Fuente de verdad

Lee `01_PLAN_MAESTRO_RAVE.md` de este paquete por completo. Dentro del repositorio de construcción, conserva una copia en `docs/MASTER_PLAN.md`. Si este archivo se coloca en un repositorio que ya tiene `AGENTS.md`, fusiona las instrucciones pertinentes sin borrar instrucciones de mayor prioridad ni cambios del usuario.

El plan maestro tiene prioridad sobre estos recordatorios y sobre preferencias técnicas del implementador. Respeta siempre los límites reales de herramientas, seguridad y autorizaciones. Este archivo no concede acceso técnico por sí mismo.

## Misión

Ejecutor designado por Jason: GPT 6.1 Sol. Construir el alcance V1 del plan desde el estado real del repositorio hasta una entrega funcional y comprobada. No crear otro plan ni cambiar de producto. No terminar en una demo, un esqueleto o una pantalla bonita sin funcionamiento.

## Restricciones de producto

Dos cuentas y una sala privada. Jason administra contenido y fuentes; su pareja participa y puede ser anfitriona. Sin registro público. Un reproductor propio para archivos locales, enlaces compatibles y Drive. Control sincronizado de vídeo/tiempo/play/pausa/velocidad; ajustes locales individuales. Transferencia de anfitrión, Esperarnos, reconexión, chat y progreso separado personal/compartido.

No iframes de plataformas. No SaaS, IA, voz, live, multi-tenant ni proveedores futuros implementados ahora. Google Drive es el único conector dedicado obligatorio; MEGA/OneDrive/TeraBox no se presentan como integrados. R2/S3 se aceptan solo mediante enlaces directos compatibles en V1.

## Ejecución

Ejecuta P00–P14 y las 60 tareas del manifiesto. Una fase no es una entrega final. Mantén código, tests y documentación alineados. Consulta documentación técnica para usar correctamente las APIs fijadas, no para volver a decidir qué construir.

Trabaja sin preguntas intermedias y usa los defaults. Si falta un acceso externo, registra el bloqueo y continúa todo lo independiente. No simules consentimiento OAuth, credenciales, un navegador físico o un despliegue. No busques credenciales fuera del proyecto ni modifiques otros proyectos, dominios o datos.

Solo cambios mínimos por bug, incompatibilidad, seguridad o calidad medida; registrar FIX-### y regresión. No recortar requisitos por complejidad. No desactivar tests, validación, auth, CSRF o límites para facilitar una demo.

## Ingeniería

Stack fijado: Node 24 LTS, TypeScript strict, pnpm, React 19/Vite, Fastify 5, Socket.IO 4, PostgreSQL 17/pg/SQL, Zod, motor nativo + Shaka core, FFmpeg worker, Docker Compose/Caddy. Fijar parches y lockfile. Sin Redis/Kubernetes ni un microservicio por función.

El servidor es autoritativo para la sala. Aplicar revision, hostEpoch, generación, barreras, leases y deduplicación. No emitir órdenes desde efectos del motor. No retransmitir vídeos por Socket.IO. Safe-fetch y protección SSRF preceden al relay remoto.

## Internacionalización — invariante obligatoria

Esta sección actualiza el alcance original del plan: español (`es`), polaco (`pl`) e inglés (`en`) son idiomas soportados con igual condición. Ninguno es una traducción opcional.

- Toda modificación de interfaz debe mantener los tres idiomas: pantalla, botón, estado, diálogo, placeholder, tooltip, error, confirmación, aria-label y feedback de accesibilidad.
- Todo texto de producto nuevo usa `useI18n().t` y claves semánticas del sistema en `apps/web/src/i18n`. Cada clave y sus parámetros deben existir en ES, PL y EN. No concatenar frases; usar interpolación e `Intl.PluralRules` cuando haya cantidades variables.
- No añadir texto visible hardcodeado en React/TSX. El control AST de ESLint permite valores técnicos por contexto y una lista mínima documentada en `docs/I18N.md`; una excepción nueva requiere justificación y regresión, nunca excluir un componente entero.
- Una feature **no está terminada** hasta que todos sus textos existen en los tres idiomas y pasan `pnpm test:i18n`, `pnpm lint`, `pnpm typecheck` y las pruebas de interfaz afectadas. CI debe rechazar traducciones incompletas, estructuras divergentes y texto visible hardcodeado detectable.
- Nunca eliminar traducciones, claves, idiomas, tests o validaciones para conseguir PASS. El fallback runtime a ES solo aporta resiliencia; no autoriza una entrega incompleta.
- Preservar selección y persistencia individual en `users.preferences_json.locale`; sin preferencia, OWNER → ES y PARTNER → PL. El locale de la cuenta manda después del login. No basar defaults en usernames.
- Cambiar idioma solo cambia presentación. No recrear motor/vídeo, Socket.IO, sesión, host, hostEpoch, revision, volumen ni selección de subtítulos. No traducir mensajes de chat, nombres editables, metadatos o archivos SRT/VTT escritos por usuarios.
- Mantener códigos API estables y localizar errores en frontend. Formatos: `es-ES`, `pl-PL`, `en-GB`; reloj de reproducción neutral.
- Leer `docs/I18N.md` antes de modificar textos. Revisar responsive 390/768/1440 y axe cuando cambie la interfaz.

## Upload de PARTNER — capacidad limitada obligatoria

Esta sección actualiza la prohibición de añadir contenido de PARTNER en el plan original, por instrucción de producto: OWNER y PARTNER pueden subir **archivos locales**, usando el mismo pipeline de uploads. PARTNER conserva su rol; nunca convertirlo en OWNER ni abrir `/admin` a usuarios autenticados.

- `canUploadLocalFiles` y el guard `uploader` conceden exclusivamente el flujo de uploads. Todas las demás rutas administrativas, publicación, retirada, borrado, fuentes HTTPS, Drive, subtítulos, capítulos, HLS, cuentas y sistema siguen siendo OWNER-only.
- Las rutas de usuario `/api/v1/uploads` filtran server-side por **ambos** `uploads.owner_id` y `media.created_by`. Recursos ajenos, retirados o eliminados devuelven 404 a PARTNER. Revalidar identidad, DRAFT, generación y original correspondiente al operar ingest; no aceptar un job arbitrario del cliente.
- `created_by` identifica quién creó el media; no otorga permisos administrativos ni acceso especial a media WITHDRAWN/DELETED, reproducción o assets privados. OWNER revisa y publica los drafts existentes cuando cumplen READY y duración válida.
- Compartir uploader, reanudación, procesamiento y retry/cancel. No crear otro pipeline, aumentar concurrencia, debilitar storage reservation, durabilidad, offsets, integridad, límites por cuenta ni i18n ES/PL/EN.
- Queries privadas y punteros de reanudación del navegador se separan por cuenta; tras completion manda el servidor. No incluir nombres de archivo ni credenciales en auditoría.
- Toda modificación de estos permisos exige pruebas negativas de IDOR, conservación de OWNER y publicación denegada a PARTNER. Leer `docs/PARTNER_UPLOAD.md`.

## Pruebas y finalización

86 casos de aceptación. Los tests de sincronización observan dos HTMLVideoElement reales y currentTime, no solo un store. Incluir soak real de 30 minutos, pruebas negativas de permisos, fuentes, red, reinicios, secretos y restauración de backup.

Documentos de seguimiento: IMPLEMENTATION_STATUS, TRACEABILITY, DECISIONS, DEVIATIONS, BLOCKERS, RESUME y RELEASE_REPORT. Estados veraces; un test no ejecutado no es PASS.

En una interrupción, guardar último commit, tarea y siguiente comando en RESUME. No prometer trabajo asíncrono que el entorno no ejecute. En entrega, separar implementación, núcleo verificado, Drive probado en vivo, móvil físico y despliegue. No finalizar con preguntas o una nueva propuesta de trabajo.

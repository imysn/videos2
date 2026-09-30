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

## Pruebas y finalización

86 casos de aceptación. Los tests de sincronización observan dos HTMLVideoElement reales y currentTime, no solo un store. Incluir soak real de 30 minutos, pruebas negativas de permisos, fuentes, red, reinicios, secretos y restauración de backup.

Documentos de seguimiento: IMPLEMENTATION_STATUS, TRACEABILITY, DECISIONS, DEVIATIONS, BLOCKERS, RESUME y RELEASE_REPORT. Estados veraces; un test no ejecutado no es PASS.

En una interrupción, guardar último commit, tarea y siguiente comando en RESUME. No prometer trabajo asíncrono que el entorno no ejecute. En entrega, separar implementación, núcleo verificado, Drive probado en vivo, móvil físico y despliegue. No finalizar con preguntas o una nueva propuesta de trabajo.

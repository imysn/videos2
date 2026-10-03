# Subidas de PARTNER sin permisos administrativos

OWNER y PARTNER pueden subir archivos de vídeo locales. Siguen existiendo exactamente los roles OWNER y PARTNER. La capacidad `canUploadLocalFiles`/guard `uploader` no concede administración ni publicación y actualiza exclusivamente este punto del alcance original del plan maestro.

## Experiencia y publicación

Ambos pueden abrir **Subir vídeo** (`/upload`) y **Mis subidas** (`/my-uploads`). El formulario compartido admite archivo local, título, descripción y categoría opcionales. PARTNER no ve enlaces HTTPS, Drive, fuentes, portada, subtítulos, capítulos, HLS ni publicación. OWNER conserva todo `/admin`, incluido su formulario avanzado.

El mismo pipeline distingue transferencia, finalización, subida completada, cola, procesamiento, listo, publicado, error y cancelado. Al completar, navega a `/my-uploads/:uploadId`; la ficha/lista consultan el estado persistido del servidor. No se crea otro media al recargar. Mis subidas muestra únicamente archivos creados y subidos por esa cuenta, también desde otro dispositivo. Fechas, tamaño, errores y progreso se localizan en ES/PL/EN.

La fuente READY y duración positiva muestran **Esperando publicación**, con el display name actual del OWNER; no se fija un username o nombre. OWNER ve el mismo borrador en Administración → Contenido, con **Subido por …**, puede revisarlo y publicarlo con las invariantes existentes. Después ambos encuentran un único vídeo en biblioteca. PARTNER nunca recibe un botón ni endpoint que publique.

## Frontera API y ownership

| Ruta de usuario                               | Operación permitida                                         |
| --------------------------------------------- | ----------------------------------------------------------- |
| `POST /api/v1/uploads`                        | Crear upload y DRAFT con los metadatos mínimos              |
| `GET /api/v1/uploads`                         | Lista paginada exclusivamente de la cuenta                  |
| `GET /api/v1/uploads/:id`                     | Metadatos, offset, estado, ingest y progreso propios        |
| `HEAD /api/v1/uploads/:id`                    | Offset durable y límites propios, sin body                  |
| `PATCH /api/v1/uploads/:id`                   | Chunk secuencial de la transferencia propia                 |
| `POST /api/v1/uploads/:id/complete`           | Checksum, original persistente y un único ingest            |
| `DELETE /api/v1/uploads/:id`                  | Cancelar únicamente transferencia incompleta/fallida propia |
| `POST /api/v1/uploads/:id/retry`              | Reintentar únicamente el ingest propio elegible             |
| `POST /api/v1/uploads/:id/cancel-preparation` | Cancelar únicamente el ingest propio en cola/ejecución      |

Cada ruta autentica sesión, exige cambio inicial de contraseña, y las mutaciones conservan Origin/CSRF, idempotencia y mantenimiento. La autorización de recursos exige **ambos** `uploads.owner_id = identity.user.id` y `media.created_by = identity.user.id`. Recursos ajenos devuelven 404 sin offsets ni datos privados. No se aceptan `ownerId`, `createdBy`, publicación, URL, ni job arbitrario en el payload.

`created_by` no otorga administración permanente: PARTNER no obtiene acceso a media retirado/eliminado, reproducción de borradores ni assets privados, aunque lo haya subido. Se mantienen los guards de biblioteca/playback/assets. Elegir una categoría existente tampoco permite renombrarla globalmente.

Los endpoints antiguos `/api/v1/admin/uploads` siguen siendo OWNER-only y reutilizan los mismos handlers. OWNER puede consultar y operar las subidas de ambas cuentas desde ese ámbito administrativo. Todos los demás endpoints `/admin` mantienen sus permisos, incluida reautenticación donde existía. No hay migración ni reasignación retroactiva de `created_by`.

## Retry, cancelación y límites

Las acciones de preparación propias comprueban en la mutación SQL: identidad, DRAFT no eliminado, job `ingest`, generación vigente, upload completado y asset original correspondiente exactamente a ese upload. No permiten operar otros jobs del media. Las flags visibles se derivan del mismo predicado; el backend revalida aunque la UI esté obsoleta. Retry conserva las reglas existentes de fallo, intentos disponibles y generación. Cancelar cola es inmediato; en ejecución solicita cancelación al worker. Ambos conservan el original completado. Jobs cancelados no se reintentan como fallidos.

Se mantienen 20 GiB por archivo, chunks de 8 MiB, dos uploads incompletos activos por cuenta, dos buffers de chunk por proceso, storage reservation, ACK posterior a `fsync`, checksum final y `MEDIA_JOB_CONCURRENCY=1`. OWNER y PARTNER pueden transferir a la vez; el worker procesa sin prioridades por usuario. No se modifica FFmpeg, storage ni sincronización de reproducción.

Los eventos existentes `audit_events` registran actor, upload/media/job IDs y acciones de creación, completion, cancelación y retry. No añaden filenames, títulos, credenciales o tokens al audit. Las queries privadas y el puntero de reanudación del navegador usan identidad de cuenta; este último solo facilita una transferencia incompleta. Después de completion se elimina y manda el servidor. PARTNER no lee el puntero legado administrativo.

## Verificación e invariantes futuras

- `tests/integration/partner-upload.test.ts`: PERM-UPLOAD-01..22; 544 chunks, nueva sesión, completion concurrente, checksum, actor, IDOR de cada verbo/acción, límites por usuario, worker real de un único job, retry/cancel, atribución, OWNER publica, biblioteca y retirada sin privilegios del creador.
- `tests/security/partner-upload.test.ts`: capacidad cerrada a los dos roles, inventario exacto de rutas uploader y todas las rutas admin OWNER-only, doble ownership y rechazo de enumeración/cursors manipulados.
- `tests/e2e/partner-upload.spec.ts`: dos sesiones reales, formulario limitado, estado recuperado al recargar/otro navegador, progreso persistido, fallo/retry, FFmpeg real, espera por OWNER, publicación, pausa/reanudación, ES/PL/EN, responsive 390/768/1440 y axe.
- La preparación E2E espera a que terminen los recursos iniciales de biblioteca antes de medir reproducción, sin modificar límites de streams ni expectativas de playback. Las fixtures nuevas cancelan sus transferencias incompletas al terminar, para no ocupar reservas de otra prueba. El ensayo de reanudación OWNER verifica ahora el puntero separado por cuenta.
- Se conservan suites de uploads, seguridad, contratos de proveedores e i18n. Nuevas claves deben existir en los tres catálogos y pasar AST, paridad y tipos; no hay excepciones nuevas a esos gates.
- CI normal ejecuta las suites y Docker deployment incluye esta rama con builds/runtimes nativos amd64 y ARM64. No despliega ni accede a producción.

No ampliar `/admin`, publicar desde PARTNER, aceptar jobs arbitrarios, derivar ownership del cliente, reducir tests o duplicar el uploader para futuras funciones. Estas obligaciones están en [AGENTS.md](../AGENTS.md).

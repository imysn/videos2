# Subidas: transferencia, cola y procesamiento

Una subida completa conserva su original y crea un único trabajo `ingest`. El 100 % de transferencia **no** significa que FFmpeg haya terminado. Con `MEDIA_JOB_CONCURRENCY=1`, otro vídeo puede ocupar el worker mientras el nuevo borrador espera. Esa fue la causa del caso observado: 776 138 448 bytes confirmados, subida `completed`, contenido `DRAFT` y trabajo `queued`; no había evidencia de pérdida del archivo.

## Estados y navegación

| Presentación              | Fuente persistida                                            | Comportamiento                                                                                            |
| ------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Subiendo                  | `uploads.state=uploading`, `committed_offset/expected_bytes` | Bytes enviados y confirmados separados; pausar y reanudar seleccionando el original.                      |
| Finalizando transferencia | Todos los bytes confirmados; `/complete` en curso            | El porcentaje corresponde a transferencia, no a preparación.                                              |
| Subida completada         | `uploads.state=completed`                                    | Original almacenado, checksum calculado y trabajo creado. Navega a la ficha existente.                    |
| En cola                   | `jobs.state=queued`                                          | Explica que otro vídeo puede estar procesándose y que el servidor continúa aunque se cierre el navegador. |
| Procesando                | `jobs.state=running`                                         | Porcentaje de `jobs.progress`, sin temporizadores ni progreso simulado.                                   |
| Listo                     | Fuente `READY`, duración positiva                            | OWNER puede publicar. Un job exitoso sin fuente lista no habilita publicación.                            |
| Publicado                 | Fuente lista y `publication_state=PUBLISHED`                 | Accesible según las reglas existentes de biblioteca.                                                      |
| Error                     | Upload fallido o ingest `failed`                             | Código seguro localizado; Reintentar solo si lo permite el backend.                                       |
| Cancelado                 | Upload o job `cancelled`                                     | Estado explícito; cancelar un ingest no elimina el original completado.                                   |

La ficha y las tarjetas administrativas proyectan las tablas existentes; no existe otra columna de estado ni otra fuente de verdad. Contenido ofrece filtros Todos / Sin publicar / Publicados. Los borradores en cola, procesándose, fallidos, cancelados o listos siguen siendo localizables, también tras recargar o entrar desde otro dispositivo.

`GET /api/v1/admin/uploads/:id` recupera metadatos, tamaño, offset durable, estado y límite de chunk. `HEAD` conserva su contrato y añade `Upload-Chunk-Max-Bytes`. Son endpoints OWNER; PARTNER no obtiene detalles privados ni permisos de subida. Un puntero local únicamente facilita encontrar una transferencia incompleta; después de `/complete`, la ficha depende del servidor. Si se pierde la respuesta de completion, consultar el upload recupera el mismo borrador. Repetir completion devuelve el mismo media/job; reintentar la creación desde el mismo formulario reutiliza su clave de idempotencia.

La ficha consulta cada 3 segundos, con la política existente de TanStack Query; la lista cada 5 segundos mientras muestra preparación activa. No consulta en segundo plano cuando la pestaña está oculta. Los códigos backend, roles, publicación y sincronización del reproductor conservan sus contratos. Todos los textos y errores están localizados en ES/PL/EN y pasan los gates i18n existentes.

## Cancelar, retirar, eliminar y reintentar

- **Pausar transferencia** interrumpe el envío; la reanudación consulta el offset confirmado por el servidor. Un chunk parcialmente recibido no se confirma.
- **Cancelar subida** abandona una transferencia incompleta/fallida y elimina sus archivos temporales. El backend rechaza cancelar de esta forma una subida completada.
- **Cancelar preparación** cancela inmediatamente un job en cola o solicita la cancelación al worker si está ejecutándose. El original completado permanece. Un job cancelado no se reintenta como si fuera fallido.
- **Retirar** mantiene el significado existente de `WITHDRAWN`; no cancela el trabajo. La ficha lo explica y ofrece la acción independiente de cancelar preparación.
- **Eliminar contenido** mantiene la eliminación explícita y su reautenticación. Ahora solicita cancelar preparación activa antes del cleanup autorizado; no debe usarse como botón de pausa.
- **Reintentar** reutiliza el mismo job y original, limpia el error/progreso y vuelve a la cola. Solo es válido si falló, quedan intentos y la generación del contenido sigue vigente. UI y endpoint usan el mismo predicado.

## Durabilidad y rendimiento

Se mantienen `MAX_UPLOAD_BYTES=21474836480` (20 GiB) y `UPLOAD_CHUNK_MAX_BYTES=8388608` (8 MiB). El cliente respeta un límite configurado menor. El tamaño máximo permitido no garantiza espacio disponible; las reservas de disco existentes siguen vigentes.

El API recibe cada chunk en un buffer limitado **antes** de tomar locks o abrir la transacción de escritura. Admite como máximo dos buffers por proceso: hasta 16 MiB dedicados a chunks con el default, además de la memoria normal de Node/red. No almacena el archivo completo en RAM. Escribe el buffer mediante una operación de archivo, manejando escrituras parciales, y ejecuta `fsync` antes de actualizar y confirmar `committed_offset`. Mantiene chunks secuenciales y bloqueo por fila; no reduce la frecuencia de sync. Ante un tail no confirmado, trunca al último offset durable antes de reintentar.

La creación del archivo y el rename al original sincronizan también los directorios hasta `DATA_ROOT`. El checksum completo se calcula por streaming fuera de la transacción; dentro se verifica otra vez el estado/tamaño y se confirma original + upload + ingest juntos. Completion concurrente tolera el rename y devuelve el mismo resultado. Si faltan bytes previamente confirmados, persiste un error de upload sin crear ingest. Estas garantías dependen de que el filesystem/dispositivo respete `fsync`; no se ensayaron cortes eléctricos físicos.

El envío muestra bytes/total, porcentaje de transferencia, bytes confirmados, velocidad actual y media en MiB/s. La ETA se muestra después de al menos cinco segundos y muestras suficientemente estables; se oculta con velocidades erráticas o detenidas. La velocidad incluye el ciclo de envío/confirmación y no equivale a una medición aislada del enlace.

## Benchmark reproducible

El tooling rechaza producción y requiere una DB sintética `rave_test` o `rave_validation` (también sus sufijos validados). Levanta una API independiente en loopback y usa PostgreSQL real. Genera bytes sintéticos por bloques; comprueba SHA-256 del cliente, DB y original almacenado; elimina únicamente su contenido `[BENCH]`. No ejecuta ingest ni utiliza cuentas/datos de producción.

```sh
# Preparar el perfil de test/validation mediante el tooling oficial del repo.
pnpm exec tsx scripts/test-prepare.ts validation
RAVE_CONFIG_FILE=.local/validation/config.json pnpm benchmark:upload \
  --bytes=776138448 --chunks=4194304,8388608 --repeats=3 \
  --output=.local/upload-work/benchmark.json

# Modelo de coste por request: añade 20 ms artificiales; no mide Tailscale.
RAVE_CONFIG_FILE=.local/validation/config.json pnpm benchmark:upload \
  --bytes=134217728 --chunks=1048576,8388608 --repeats=2 --latency-ms=20 \
  --output=.local/upload-work/latency.json
```

Para comparar, ejecutar el mismo script desde un checkout aislado de la base `c6a1c5c2024cf087a11a8592b3ade759e168b064` y desde esta rama, con igual configuración y hardware. No ejecutar suites sobre esa DB ni procesos intensivos durante la medición. El límite global HTTP sigue siendo 1000 requests/minuto: una exploración de 776 MB con chunks de 1 MiB y varias repeticiones lo alcanzó. No se deshabilita para benchmark; separar esos casos o dejar que se restablezca. El ejemplo de 4/8 MiB queda dentro del límite.

Cada resultado registra tiempo de transferencia, completion/checksum y total, MB/s decimales, cantidad de PATCH, CPU de API/cliente, pico RSS, contadores Linux `/proc/self/io`, consultas DB y tiempo/cantidad de write/sync. La prueba de interrupción aborta un body parcial, exige offset 0 y reanuda con checksum correcto. La CPU suma los threads; tiempos DB/write/sync son instrumentación, no un perfil exclusivo de cada subsistema. RSS se muestrea; cachés e I/O del host afectan los resultados. El total empieza tras crear el upload e incluye completion; requests son PATCH, más los POST de creación y completion.

Los resultados antes/después están en `artifacts/verification/upload-benchmark.json`. La mejora se atribuye a reducir llamadas de escritura de los fragmentos de red; se conserva un sync por chunk y se añaden los sync de directorios. Red externa, Tailscale y microSD de la Raspberry **no fueron medidos**. La tasa de loopback no predice su throughput. No se aumenta concurrencia ni tamaño de chunk a partir de resultados de otro host.

Resultados principales, media de tres repeticiones de **776 138 448 bytes** en este host:

| Métrica                                            | Base, 8 MiB | Corrección final, 8 MiB        |
| -------------------------------------------------- | ----------- | ------------------------------ |
| Throughput de transferencia                        | 152,8 MB/s  | 196,0 MB/s (+28,3 %)           |
| Tiempo total, incluido completion                  | 5,982 s     | 4,877 s (−18,5 %)              |
| PATCH por archivo                                  | 93          | 93                             |
| Llamadas write por archivo                         | ≈11 843     | 93                             |
| Tiempo acumulado write                             | 1117 ms     | 178 ms                         |
| Sync por archivo, durante transferencia/completion | 93          | 98 (93 chunks + 5 directorios) |
| Tiempo acumulado sync                              | 377 ms      | 405 ms                         |
| Tiempo acumulado consultas DB                      | 477 ms      | 571 ms                         |
| CPU API, user + system                             | 12,03 s     | 9,78 s                         |
| Pico RSS API, media de las muestras máximas        | 299,0 MiB   | 310,3 MiB                      |

Con 4 MiB: 117,2 → 140,8 MB/s (+20,1 %), 186 PATCH. Un primer ensayo después de la corrección con 8 MiB dio 182,7 MB/s (+19,6 %); se conserva también como evidencia de variación entre ensayos. En el modelo de 20 ms/request y 128 MiB, 1 MiB dio 29,2 → 28,1 MB/s (sin mejora), mientras 8 MiB dio 105,4 → 134,5 MB/s. Esto confirma el coste de muchas rondas; no demuestra latencia real de Tailscale. En todos los casos completados, los checksums y la interrupción/reanudación pasan. El benchmark final inicialmente rechazó la reserva de disco; se limpió una fixture sintética antigua y se repitió, sin cambiar la protección.

Las escrituras por cada fragmento de red eran un coste reducible. Tras agruparlas, siguen existiendo coste de sync, DB, hashing y protocolo; no se atribuye todo el límite a `fsync`. No se han medido red/VPN/storage físico de producción y no se afirma cuál limita allí.

## Regresiones y verificación

| Suite nueva                                 | Cobertura                                                                                                                                                                                                                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/unit/upload-pipeline.test.ts`        | Fases separadas, no confundir 100 % con READY, códigos seguros en los tres idiomas, velocidad/ETA estable y reanudación.                                                                                                                                                                   |
| `tests/integration/upload-pipeline.test.ts` | Chunk lento de 11 s, 34 MiB en 544 chunks, completion concurrente única, reinicio API, cola de dos vídeos con worker real, FFmpeg real/success/failure, retry agotado/generación, cancelación, permisos, sync pendiente/fallido, corrupción, interrupción/tail y límite configurado menor. |
| `tests/e2e/upload-processing.spec.ts`       | Navegación/reload y admin persistente, progreso DB real, fallo/retry/READY con worker real, pérdida de ACK de creación/chunk/completion, pausa/reanudación, cancelación/original retenido, ES/PL/EN, 390/768/1440 y axe.                                                                   |

Las fixtures grandes se generan con un MP4 válido y un atom `free`, nunca se añaden vídeos enormes a Git. El benchmark usa además el tamaño exacto reportado en producción. Los estados intermedios del E2E se introducen como fixtures explícitas en la DB de test; no simulan progreso en producto. La prueba de cola y el paso posterior a READY usan el worker/FFmpeg reales.

CI conserva paridad, AST y TypeScript de i18n y ejecuta las suites normales, incluidas estas regresiones. El workflow Docker verifica CONFIG, BUILD y RUNTIME en runners nativos amd64 y ARM64 para esta rama; usa proyectos y secretos sintéticos. No es un despliegue de la Raspberry.

## Resultados de esta entrega

Base exacta: `c6a1c5c2024cf087a11a8592b3ade759e168b064`. Código de producto verificado: `eb506039e6132309cf8d9ac7b8fd1356d8741262`; los cambios posteriores de esta entrega documentan evidencia y completan la configuración de fixtures de CI. Rama `fix/rave-upload-processing`, publicada sin merge ni cambios en Raspberry.

| Verificación                                    | Resultado real                                                                                                          |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Format, lint/AST i18n, TypeScript strict, build | PASS                                                                                                                    |
| Unit                                            | 101 PASS; cobertura de ramas room-core 94,21 %, umbral intacto                                                          |
| Paridad i18n                                    | 27 PASS; 406 claves/locales, 42 nuevas claves en ES/PL/EN                                                               |
| Integración completa                            | 83 PASS, con assets congelados y sin builds concurrentes                                                                |
| Seguridad                                       | 36 PASS                                                                                                                 |
| Contratos de proveedor                          | 15 PASS; no autorización Google live                                                                                    |
| E2E completo                                    | 30 PASS; tras ajustar identidad de archivo se repitió y pasó el caso de ACK perdido                                     |
| Responsive/axe                                  | PASS en suites existentes y nueve análisis nuevos; ES/PL/EN, 390/768/1440; revisión visual de ficha polaca a 390        |
| Secret scan / exclusión de `.local`             | PASS, cero hallazgos; sin secretos de producción rastreados                                                             |
| Docker GitHub nativo amd64 y ARM64              | [PASS_CONFIG / PASS_BUILD / PASS_RUNTIME en ambas](https://github.com/imysn/videos2/actions/runs/37126307604)           |
| Docker local amd64                              | CONFIG y BUILD PASS tras limpiar caché; el intento de runtime agotó el disco del executor `vfs`, no se marca PASS local |

Evidencia por suite, bugs y límites: `artifacts/verification/upload-pipeline.json`; medidas completas: `upload-benchmark.json`. [CI de esta rama](https://github.com/imysn/videos2/actions/workflows/i18n.yml?query=branch%3Afix%2Frave-upload-processing) ejecuta de nuevo todas las suites sobre cada commit.

La primera integración local tuvo dos fallos después de reconstruir `dist` mientras sus navegadores seguían abiertos. Se repitió completa con assets congelados: 83 PASS; no se alteró reproducción ni sus tests. La primera ampliación de CI encontró cuatro fallos de setup: faltaban la configuración explícita del perfil sintético y el padre temporal de las fixtures de operaciones. Se añadieron esos prerrequisitos y sus siete pruebas afectadas pasan localmente; se mantiene la suite completa en CI. Ningún test se elimina, salta o relaja para cerrar esta tarea.

No se midió throughput en Raspberry/Tailscale/microSD, ni un corte eléctrico físico. Las pruebas móviles son de navegador con anchos representativos; no un teléfono físico. No se ejecutó un nuevo soak de 30 minutos ni OAuth Google live en esta tarea. La Raspberry, sus secrets, Docker y datos permanecen intactos.

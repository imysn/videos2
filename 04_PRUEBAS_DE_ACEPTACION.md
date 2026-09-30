# Matriz de aceptación · Rave privado

Complemento generado del mismo registro que el plan maestro. Son pruebas que Sol debe implementar y ejecutar; ninguna se marca como realizada aquí.

Total: 86 pruebas. Fecha: 2026-09-30. Plan: 1.0.

## AUTH-01 · Cuentas

**Procedimiento:** Ejecutar bootstrap dos veces sobre una DB nueva y volver a consultar cuentas.

**Resultado exigido:** Exactamente owner/partner; la segunda ejecución no cambia contraseñas, IDs o sala.

**Evidencia:** Integración SQL + salida saneada de CLI.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## AUTH-02 · Cuentas

**Procedimiento:** Login correcto, incorrecto, usuario desconocido y repetición de intentos.

**Resultado exigido:** Sesión real; errores no enumeran usuarios; rate limit efectivo sin bloqueo permanente.

**Evidencia:** Integración HTTP.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## AUTH-03 · Cuentas

**Procedimiento:** Acceder sin cookie a catálogo, vídeo, asset, segmento, chat y ruta administrativa.

**Resultado exigido:** Ninguna respuesta entrega contenido privado; 401/403 o redirección apropiada.

**Evidencia:** Integración + capturas de red.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## AUTH-04 · Cuentas

**Procedimiento:** Intentar añadir contenido, emitir reset y conectar Drive usando cuenta partner.

**Resultado exigido:** 403 en servidor aunque se invoque la API directamente.

**Evidencia:** Pruebas de autorización negativas.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## AUTH-05 · Cuentas

**Procedimiento:** Consumir reset dos veces, después de expirar y con token manipulado.

**Resultado exigido:** Solo primer uso válido cambia contraseña; sesiones antiguas quedan revocadas.

**Evidencia:** Integración con reloj controlado.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## AUTH-06 · Cuentas

**Procedimiento:** Desactivar partner con un stream relay y socket abiertos.

**Resultado exigido:** Se revocan sesión/lease, se aborta stream y no puede acceder a nuevos rangos.

**Evidencia:** E2E + integración de stream.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## AUTH-07 · Cuentas

**Procedimiento:** Cambiar contraseña y revocar una sesión propia desde otra.

**Resultado exigido:** Cookies seguras, rotación/revocación reales y ausencia de tokens en localStorage.

**Evidencia:** E2E y auditoría de navegador.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## AUTH-08 · Cuentas

**Procedimiento:** Intentar crear tercer slot o desactivar el último owner mediante API/SQL de aplicación.

**Resultado exigido:** Restricción de negocio y DB; no pérdida de administración.

**Evidencia:** Integración SQL.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## LIB-01 · Biblioteca

**Procedimiento:** Crear borrador y comprobar catálogo desde ambas cuentas; publicar y retirar.

**Resultado exigido:** Solo owner ve borrador; publicado aparece a ambos; retirado deja de ser reproducible.

**Evidencia:** E2E de dos cuentas.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## LIB-02 · Biblioteca

**Procedimiento:** Buscar, filtrar, abrir ficha y volver a rejilla.

**Resultado exigido:** Resultados correctos y conservación de búsqueda, scroll y foco.

**Evidencia:** E2E + capturas.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## LIB-03 · Biblioteca

**Procedimiento:** Subir fixture en varios chunks, interrumpir y reanudar tras consultar offset.

**Resultado exigido:** Bytes finales idénticos por checksum; no duplicación ni corrupción.

**Evidencia:** Integración upload y checksum.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## LIB-04 · Biblioteca

**Procedimiento:** Enviar offset incorrecto, chunks simultáneos y simular crash entre escritura y commit.

**Resultado exigido:** 409 o recuperación documentada; fichero consistente con offset durable.

**Evidencia:** Fault injection sobre upload.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## LIB-05 · Biblioteca

**Procedimiento:** Subir archivo no multimedia, corrupto y mayor al límite.

**Resultado exigido:** Rechazo seguro con estado real y limpieza; no publicación ni caída de API.

**Evidencia:** Integración worker.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## LIB-06 · Biblioteca

**Procedimiento:** Generar MP4 compatible y HLS de fixture autorizado; comprobar salidas y seek.

**Resultado exigido:** Assets completos, versiones sin upscale y reproducción real; no variantes ficticias.

**Evidencia:** ffprobe + Playwright.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## LIB-07 · Biblioteca

**Procedimiento:** Reemplazar URL del mismo contenido y luego por contenido distinto.

**Resultado exigido:** La ficha puede conservarse; solo mismo contenido conserva contexto; nueva generación no hereda progreso indebido.

**Evidencia:** Integración + E2E.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## LIB-08 · Biblioteca

**Procedimiento:** Eliminar vídeo propio y ficha Drive usando fixture/control de llamadas.

**Resultado exigido:** Se limpian assets propios; nunca se emite borrado del archivo remoto de Drive.

**Evidencia:** Integración + auditoría de llamadas.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## LIB-09 · Biblioteca

**Procedimiento:** Añadir a pendientes desde ambas cuentas, marcar vídeo corto/largo como visto.

**Resultado exigido:** Lista compartida consistente; vídeo corto no se marca visto al comenzar.

**Evidencia:** Unit + E2E.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## PLAYER-01 · Reproductor

**Procedimiento:** Reproducir MP4 real, pausar y buscar en distintos puntos.

**Resultado exigido:** currentTime avanza al reproducir y se estabiliza al pausar; frames/readyState verificables.

**Evidencia:** E2E con medios sintéticos reales.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## PLAYER-02 · Reproductor

**Procedimiento:** Cargar HLS y DASH VOD de fixtures de dos calidades.

**Resultado exigido:** Misma UI propia, sin iframe; reproducción y selección de variante reales.

**Evidencia:** E2E y eventos de motor.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## PLAYER-03 · Reproductor

**Procedimiento:** Cambiar calidad/audio/subtítulos cuando existen y probar fuente de una sola pista.

**Resultado exigido:** Opciones correctas; no se inventan pistas, no cambia posición por abrir ajustes.

**Evidencia:** E2E con fixtures multipista.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## PLAYER-04 · Reproductor

**Procedimiento:** Arrastrar barra 50 movimientos y soltar; cancelar otro arrastre.

**Resultado exigido:** Un SEEK por commit; cancelar no muta sala; preview no desencadena tráfico de órdenes.

**Evidencia:** E2E + contador de comandos.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## PLAYER-05 · Reproductor

**Procedimiento:** Probar teclado y doble toque, luego escribir las mismas teclas en chat/búsqueda.

**Resultado exigido:** Controles útiles sin secuestrar escritura, sliders o accesibilidad.

**Evidencia:** E2E desktop/mobile.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## PLAYER-06 · Reproductor

**Procedimiento:** Cargar subtítulos SRT/VTT con caracteres especiales y cues solapados; ajustar desfase.

**Resultado exigido:** Representación segura y ajuste local consistente; no ejecución de HTML.

**Evidencia:** Unit parser + E2E.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## PLAYER-07 · Reproductor

**Procedimiento:** Probar rechazo real o controlado de play() por falta de gesto.

**Resultado exigido:** Estado needsGesture honesto; activación local no anula pausa voluntaria del host.

**Evidencia:** E2E con política autoplay y test de fallo.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## PLAYER-08 · Reproductor

**Procedimiento:** Entrar/salir de fullscreen/PiP donde API exista y probar plataforma sin capacidad.

**Resultado exigido:** Función real donde soportada; alternativa clara sin botón que falle silenciosamente.

**Evidencia:** E2E por capacidad + prueba de dispositivo.
**Dependencia:** `capability_dependent`.
**Estado inicial:** `NOT_STARTED`.

## PLAYER-09 · Reproductor

**Procedimiento:** Visualizar sprites, capítulos y fuentes sin esos recursos.

**Resultado exigido:** Previews/capítulos solo reales; ausencia elegante sin valores falsos.

**Evidencia:** E2E.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## PLAYER-10 · Reproductor

**Procedimiento:** Abrir/cerrar reproductor veinte veces y cambiar de vídeo diez veces.

**Resultado exigido:** Motores/listeners/streams liberados; sin audio doble ni crecimiento de memoria no explicado.

**Evidencia:** E2E + diagnóstico de memoria.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## PLAYER-11 · Reproductor

**Procedimiento:** Cargar archivo incompatible y archivo preparado compatible.

**Resultado exigido:** Error accionable en el primero; el segundo reproduce de verdad.

**Evidencia:** E2E + ffprobe.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## SYNC-01 · Sincronización

**Procedimiento:** Abrir dos contextos autenticados distintos y entrar en sala con fixture real.

**Resultado exigido:** Dos elementos de vídeo, misma sesión/generación y un solo host.

**Evidencia:** E2E con dos browser contexts.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## SYNC-02 · Sincronización

**Procedimiento:** Host hace PLAY, PAUSE y SEEK con ambos listos.

**Resultado exigido:** Cada motor converge al estado oficial; no solo etiquetas de UI sincronizadas.

**Evidencia:** Trazas de currentTime de ambos.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## SYNC-03 · Sincronización

**Procedimiento:** Seek durante pausa y durante reproducción, incluido cerca del final.

**Resultado exigido:** Pausa se conserva; playing reanuda tras barrera sin reproducir un seek anterior.

**Evidencia:** E2E + reducer.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## SYNC-04 · Sincronización

**Procedimiento:** Varias órdenes rápidas y respuestas READY/ACK reordenadas artificialmente.

**Resultado exigido:** Sin rollback de revision ni aplicación de barrera anterior.

**Evidencia:** Unit property tests + integración.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## SYNC-05 · Sincronización

**Procedimiento:** Reenviar un commandId idéntico y después el mismo ID con payload distinto.

**Resultado exigido:** Un efecto; conflicto para payload diferente; recibo persistido.

**Evidencia:** Integración SQL/socket.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## SYNC-06 · Sincronización

**Procedimiento:** Transferir host mientras reproduce y enviar después una orden del antiguo host.

**Resultado exigido:** Sin reinicio; nuevo host controla; orden vieja rechazada por epoch.

**Evidencia:** E2E + integración negativa.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## SYNC-07 · Sincronización

**Procedimiento:** Partner intenta orden de host falsificando userId y omitiendo lease.

**Resultado exigido:** Servidor rechaza sin cambiar estado.

**Evidencia:** Prueba negativa de protocolo.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## SYNC-08 · Sincronización

**Procedimiento:** Desconectar host; intentar tomar control antes y después de 15 segundos; reconectar antiguo.

**Resultado exigido:** Solo reclamación válida; nunca dos hosts; el antiguo vuelve como acompañante.

**Evidencia:** Reloj controlado + E2E.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## SYNC-09 · Sincronización

**Procedimiento:** Entrar tarde en vídeo ya avanzado con Esperarnos.

**Resultado exigido:** Barrera en posición actual; el que llega no impone cero o su progreso individual.

**Evidencia:** E2E.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## SYNC-10 · Sincronización

**Procedimiento:** Inducir buffering de 3 segundos en un cliente y recuperar tráfico.

**Resultado exigido:** El otro espera; recuperación sincronizada; no play/pause oscilante.

**Evidencia:** Servidor multimedia controlado + E2E.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## SYNC-11 · Sincronización

**Procedimiento:** Pausar voluntariamente durante buffering y después liberar el buffer.

**Resultado exigido:** Nadie reanuda automáticamente contra la pausa del anfitrión.

**Evidencia:** Reducer + E2E.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## SYNC-12 · Sincronización

**Procedimiento:** Iniciar solo con espera, continuar sin esperar y unir después al otro.

**Resultado exigido:** Acciones explícitas y reincorporación en tiempo actual; política visible.

**Evidencia:** E2E.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## SYNC-13 · Sincronización

**Procedimiento:** Desactivar Esperarnos e inducir retraso en el acompañante.

**Resultado exigido:** Host continúa; acompañante salta al tiempo oficial al recuperarse.

**Evidencia:** E2E.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## SYNC-14 · Sincronización

**Procedimiento:** Cortar socket y pulsar transporte durante desconexión; reconectar.

**Resultado exigido:** No se reproducen comandos viejos acumulados; snapshot primero.

**Evidencia:** Integración socket + E2E.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## SYNC-15 · Sincronización

**Procedimiento:** Reiniciar servidor en playing y después de commit anterior al broadcast.

**Resultado exigido:** Recuperación desde checkpoint pausado; reloj nuevo y ningún avance por tiempo de caída.

**Evidencia:** Fault injection proceso/DB.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## SYNC-16 · Sincronización

**Procedimiento:** Abrir dos pestañas de la misma cuenta y transferir dispositivo.

**Resultado exigido:** Un lease activo; pestaña antigua sin mando ni presencia duplicada.

**Evidencia:** E2E tres contextos.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## SYNC-17 · Sincronización

**Procedimiento:** Cambiar volumen, subtítulo, calidad y fullscreen en un participante.

**Resultado exigido:** No modifica preferencias del otro ni velocidad compartida.

**Evidencia:** E2E.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## SYNC-18 · Sincronización

**Procedimiento:** Cambiar rate en host y causar deriva artificial en un cliente.

**Resultado exigido:** Base rate compartida; corrección local converge sin convertirla en nueva orden global.

**Evidencia:** Unit + E2E.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## SYNC-19 · Sincronización

**Procedimiento:** Cambiar vídeo antes de terminar la carga anterior.

**Resultado exigido:** Eventos/cargas antiguos cancelados; source/generation actuales en ambos.

**Evidencia:** E2E con respuestas demoradas.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## SYNC-20 · Sincronización

**Procedimiento:** Retirar/desactivar fuente mientras se está viendo.

**Resultado exigido:** Sala se pausa con razón; no sirve nuevos bytes propios ni hace bucle de reintento.

**Evidencia:** Integración + E2E.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## SYNC-21 · Sincronización

**Procedimiento:** Simular dos relojes cliente con desfase de varios minutos y RTT variable.

**Resultado exigido:** Sincronización se basa en reloj servidor estimado, no en Date.now del cliente.

**Evidencia:** Unit con tiempo artificial + E2E.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## SYNC-22 · Sincronización

**Procedimiento:** Ejecutar 30 minutos reales de reproducción con dos clientes, pings y muestreo.

**Resultado exigido:** Cumplimiento de presupuestos declarados en entorno base; informe con p50/p95/máximo y memoria.

**Evidencia:** CSV/JSON de media.currentTime y resumen de soak.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## SYNC-23 · Sincronización

**Procedimiento:** Introducir RTT adicional 100 ms, jitter ±50 ms y cortes breves controlados.

**Resultado exigido:** Recuperación sin pérdida de permisos, tiempo incorrecto persistente o bloqueo sin acción.

**Evidencia:** Harness de red reproducible + informe.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## SYNC-24 · Sincronización

**Procedimiento:** Llevar vídeo al final y salir/volver después.

**Resultado exigido:** Ended coherente, progreso compartido guardado y nueva reproducción solo por intención.

**Evidencia:** Reducer + E2E.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## CHAT-01 · Chat/progreso

**Procedimiento:** Enviar texto/emoji simultáneo, perder ACK, reconectar y paginar.

**Resultado exigido:** Mensajes persistidos una sola vez, orden consistente y recuperación por cursor.

**Evidencia:** E2E + integración.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## CHAT-02 · Chat/progreso

**Procedimiento:** Probar borrado propio, borrado ajeno, limpieza admin y expiración de typing.

**Resultado exigido:** Permisos y retención correctos; texto borrado no queda en logs.

**Evidencia:** Integración + E2E.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## CHAT-03 · Chat/progreso

**Procedimiento:** Guardar progreso solo de ambos y progreso compartido; abrir otra pestaña vieja.

**Resultado exigido:** Tres contextos de progreso separados; escritura obsoleta rechazada.

**Evidencia:** Integración SQL + E2E.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## CHAT-04 · Chat/progreso

**Procedimiento:** Ejecutar limpieza con mensajes más antiguos que retención y verificar backups documentados.

**Resultado exigido:** Se borra del almacenamiento operativo según política; no se promete borrado mágico de backups previos.

**Evidencia:** Integración job + documentación.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## SRC-01 · Fuentes

**Procedimiento:** Inspeccionar archivo directo correcto, HTML con sufijo MP4 y blob URL.

**Resultado exigido:** Solo el válido es candidato; errores específicos para página/blob.

**Evidencia:** Servidor fixture HTTP + integración.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## SRC-02 · Fuentes

**Procedimiento:** Probar Range cerrado, abierto, suffix, inválido y múltiple con HEAD/GET.

**Resultado exigido:** 200/206/416 según contrato, Content-Range/longitudes correctos y cancelación upstream.

**Evidencia:** Test byte por byte.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## SRC-03 · Fuentes

**Procedimiento:** Cargar HLS/DASH con CORS correcto, ausente y un segmento inaccesible.

**Resultado exigido:** Reproduce el compatible; informa del fallo real sin proxy universal ni iframe.

**Evidencia:** Fixtures de orígenes separados + E2E.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## SRC-04 · Fuentes

**Procedimiento:** Expirar URL manual y renovar URL resoluble sin cambiar contenido.

**Resultado exigido:** Manual pide reemplazo; renovable recupera posición/generación sin token inventado.

**Evidencia:** Integración + E2E.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## SRC-05 · Fuentes

**Procedimiento:** Ensayar OAuth callback con state válido, inválido, repetido y sesión no owner.

**Resultado exigido:** Solo flujo válido conecta; refresh token nunca llega al acompañante.

**Evidencia:** Prueba contrato OAuth + integración.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## SRC-06 · Fuentes

**Procedimiento:** Drive: simular selección autorizada, Range, token vencido, 403/404/429 y revocación.

**Resultado exigido:** Lectura parcial, refresh único, backoff acotado y errores normalizados; ninguna mutación remota.

**Evidencia:** Servidor controlado con contrato oficial.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## SRC-07 · Fuentes

**Procedimiento:** Con credenciales reales, seleccionar vídeo propio de Drive y reproducirlo en dos dispositivos/contextos.

**Resultado exigido:** Playback/seek y renovación observados; evidencia saneada con fecha, sin publicar credenciales.

**Evidencia:** Prueba real de proveedor.
**Dependencia:** `requires_external_credentials`.
**Estado inicial:** `NOT_STARTED`.

## SRC-08 · Fuentes

**Procedimiento:** Comparar capacidades/configuración/estado de integraciones sin credenciales.

**Resultado exigido:** Drive indica configuración pendiente, no conexión falsa; MEGA/TeraBox no aparecen como implementados.

**Evidencia:** E2E sin secretos.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## SRC-09 · Fuentes

**Procedimiento:** Servir versiones/duraciones distintas de un recurso a los dos clientes.

**Resultado exigido:** No declara sincronía de contenidos distintos; bloquea por identidad/duración incompatible.

**Evidencia:** Fixture de servidor + E2E.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## SEC-01 · Seguridad

**Procedimiento:** Enviar URLs privadas, loopback, link-local, metadata, IPv6 y variantes de codificación.

**Resultado exigido:** Safe-fetch rechaza antes de conexión a red sensible.

**Evidencia:** Suite SSRF con instrumentación.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## SEC-02 · Seguridad

**Procedimiento:** Redirección pública a privada y DNS rebinding controlado.

**Resultado exigido:** Validación por salto y resolución ligada a conexión; ninguna lectura interna.

**Evidencia:** Integración de resolver/transport.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## SEC-03 · Seguridad

**Procedimiento:** CSRF HTTP, login cross-origin y handshake WebSocket de origen no permitido.

**Resultado exigido:** Rechazados incluso con cookie presente; flujo legítimo funciona.

**Evidencia:** Integración seguridad.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## SEC-04 · Seguridad

**Procedimiento:** Inyectar HTML/script en chat, títulos, subtítulos, portada y nombre de archivo.

**Resultado exigido:** Sin ejecución, navegación arbitraria ni fetch de recurso no autorizado.

**Evidencia:** E2E + parser tests.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## SEC-05 · Seguridad

**Procedimiento:** Intentar traversal, rutas de assets ajenos, IDOR y campos JSON extra.

**Resultado exigido:** Confinamiento y permisos en servidor; no acceso a filesystem/objeto no autorizado.

**Evidencia:** Integración seguridad.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## SEC-06 · Seguridad

**Procedimiento:** Inspeccionar bundle, logs, storage, errores, reportes y Git por secretos.

**Resultado exigido:** Sin passwords, refresh tokens, cookies ni URLs firmadas completas.

**Evidencia:** Escáner de secretos + revisión de artefactos.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## SEC-07 · Seguridad

**Procedimiento:** Introducir contenido corrupto y rutas/protocolos inesperados al pipeline.

**Resultado exigido:** Worker aislado; sin shell injection, protocolos remotos libres ni caída de API.

**Evidencia:** Prueba worker/contenedor.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## SEC-08 · Seguridad

**Procedimiento:** Ejecutar límites de login, chat, comandos, upload e inspección.

**Resultado exigido:** Límites reales y errores recuperables; no deshabilitados para pasar tests.

**Evidencia:** Integración carga acotada.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## SEC-09 · Seguridad

**Procedimiento:** Cambiar ciphertext, nonce/AAD y clave; probar rotación respaldada.

**Resultado exigido:** Autenticación de cifrado detecta alteraciones; recuperación/rotación documentada sin pérdida silenciosa.

**Evidencia:** Unit + integración de secretos.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## SEC-10 · Seguridad

**Procedimiento:** Ejecutar auditoría de dependencias e imágenes fijadas.

**Resultado exigido:** Sin vulnerabilidad crítica/alta explotable conocida sin mitigación verificada; excepciones explícitas.

**Evidencia:** Reporte de auditoría con versiones.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## UX-01 · Interfaz

**Procedimiento:** Recorrer login/biblioteca/ficha/sala/admin a 390, 768 y 1440 px.

**Resultado exigido:** Sin desbordes, controles solapados, teclado que tape acciones o navegación rota.

**Evidencia:** Capturas + Playwright.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## UX-02 · Interfaz

**Procedimiento:** Navegar con teclado, lector/árbol accesible y reduced-motion; ejecutar axe.

**Resultado exigido:** Foco, labels, contraste y movimientos cumplen criterios definidos; sin errores serios/críticos de axe.

**Evidencia:** axe + comprobación manual documentada.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## UX-03 · Interfaz

**Procedimiento:** Probar vacíos, loading, error de fuente, esperando pareja y desconexión.

**Resultado exigido:** Mensajes honestos con acciones funcionales; ninguna pantalla depende de datos ficticios.

**Evidencia:** E2E + capturas.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## UX-04 · Interfaz

**Procedimiento:** Probar en Safari iPhone y Chrome Android físicos si están disponibles.

**Resultado exigido:** Gestos, pantalla, pausa/reconexión y reproducción documentados por dispositivo; no confundir emulación con prueba física.

**Evidencia:** Registro de dispositivo real.
**Dependencia:** `requires_physical_device`.
**Estado inicial:** `NOT_STARTED`.

## OPS-01 · Operación

**Procedimiento:** Instalar desde checkout limpio, migrar y ejecutar bootstrap/build.

**Resultado exigido:** Instalación reproducible con lockfile, sin archivos ocultos imprescindibles.

**Evidencia:** Log saneado de instalación limpia.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## OPS-02 · Operación

**Procedimiento:** Reiniciar contenedores y cortar/reanudar worker durante job.

**Resultado exigido:** Persistencia real, reintento idempotente y API disponible.

**Evidencia:** Integración Compose/fault injection.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## OPS-03 · Operación

**Procedimiento:** Llenar presupuesto de disco en volumen fixture y cancelar transcodificación.

**Resultado exigido:** Error claro, originales intactos, temporales limpiados y API viva.

**Evidencia:** Prueba de recursos aislada.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## OPS-04 · Operación

**Procedimiento:** Crear backup y restaurar en DB/directorio nuevos.

**Resultado exigido:** Login, catálogo y reproducción/seek del fixture restaurados; claves necesarias verificadas.

**Evidencia:** Informe de restauración + checksums.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## OPS-05 · Operación

**Procedimiento:** Desplegar en destino real autorizado con HTTPS y ejecutar smoke externo.

**Resultado exigido:** Solo afirmar desplegado tras URL real y pruebas; sin destino, reportar bloqueo de despliegue.

**Evidencia:** Smoke de producción.
**Dependencia:** `requires_deployment_target`.
**Estado inicial:** `NOT_STARTED`.

## OPS-06 · Operación

**Procedimiento:** Actualizar desde versión anterior de fixture y ensayar rollback documentado.

**Resultado exigido:** Migración y recuperación sin pérdida no declarada; artefactos versionados.

**Evidencia:** Informe de actualización/rollback.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

## OPS-07 · Operación

**Procedimiento:** Auditar entregables, pendientes, fake data y cobertura requisito→prueba.

**Resultado exigido:** Cada obligación tiene implementación/evidencia o bloqueo explícito; ningún TODO en camino obligatorio.

**Evidencia:** RELEASE_REPORT + TRACEABILITY.
**Dependencia:** `required`.
**Estado inicial:** `NOT_STARTED`.

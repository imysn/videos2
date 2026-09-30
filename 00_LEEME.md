# Paquete maestro · Rave privado para Jason y su pareja

**Fecha:** 30 de septiembre de 2026 · **Versión:** 1.0  
**Destino:** implementación autónoma por GPT 6.1 Sol.

Este paquete contiene el plan y las instrucciones de construcción. **No contiene la aplicación Rave ya construida.**

## Cómo entregárselo a Sol

Adjunta el ZIP completo en el entorno donde Sol pueda trabajar sobre el proyecto y envía el texto de `02_INSTRUCCION_PARA_SOL.txt`. Sol debe extraerlo, leer el plan y comenzar P00; no hace falta que tú elijas frameworks, arquitectura o fases.

El archivo `01_PLAN_MAESTRO_RAVE.md` es autosuficiente. También puedes entregarle solo ese documento y la instrucción de arranque, aunque el ZIP añade seguimiento y contratos útiles. La versión HTML incluida es únicamente para leer el plan cómodamente en un navegador; no es la interfaz del futuro producto.

## Contenido

| Archivo | Para qué sirve |
|---|---|
| `01_PLAN_MAESTRO_RAVE.md` | Especificación completa: 24 apartados, producto, arquitectura, UI, fuentes, reproductor, sincronización, datos, seguridad, pasos, pruebas y entrega. |
| `01_PLAN_MAESTRO_RAVE.html` | Copia de lectura del mismo plan, sin recursos externos. |
| `02_INSTRUCCION_PARA_SOL.txt` | Mensaje de inicio listo para copiar. |
| `AGENTS.md` | Reglas persistentes de implementación para el workspace. |
| `03_EXECUTION_MANIFEST.json` | 15 fases, 60 tareas y 86 pruebas con estado inicial pendiente. |
| `04_PRUEBAS_DE_ACEPTACION.md` | Matriz legible de las 86 pruebas que Sol debe realizar. |
| `05_ROOM_PROTOCOL.ts` | Contrato tipado de sala, capacidades y eventos. No es el servidor implementado. |
| `06_ENVIRONMENT.example` | Contrato de configuración sin credenciales. |
| `07_CHECKPOINT_TEMPLATE.json` | Plantilla de continuidad en caso de interrupción. |
| `08_VALIDACION_DEL_PAQUETE.md` | Comprobaciones realizadas sobre estos archivos; no son pruebas de la aplicación. |
| `SHA256SUMS.txt` | Integridad de los archivos del paquete. |

## Qué se construye

Dos cuentas privadas, una sala compartida, biblioteca administrada por Jason, archivos propios/enlaces compatibles, conector Google Drive, reproductor propio cuidado, sincronización, traspaso de anfitrión, chat, progreso personal/compartido, seguridad, backups y despliegue reproducible.

MEGA y OneDrive quedan descritos para una ampliación, sin construir conectores ahora. TeraBox no se promete como compatible. Las URLs directas compatibles de R2/S3/Vimeo se tratan como fuentes URL, no como cinco integraciones nuevas.

## Autonomía y límites

El plan ordena a Sol trabajar sin preguntas intermedias, sin rediseñar el producto y hasta terminar el alcance disponible. Solo admite cambios justificados para corregir defectos o mejorar calidad demostrable.

Un documento no puede otorgar permisos técnicos, proporcionar contraseñas desconocidas ni efectuar consentimiento OAuth por ti. Cuando falte un recurso externo, Sol debe dejarlo identificado, terminar lo demás y no inventar un resultado. El plan distingue implementación, pruebas reales y despliegue en Internet.

## Autoridad de los archivos

El maestro es la fuente de verdad. El manifiesto y la matriz se generaron del mismo registro de tareas/pruebas. El contrato TypeScript complementa el texto y necesita validación runtime en la aplicación. Si Sol detecta una incompatibilidad, debe corregirla de forma mínima, registrar la evidencia y añadir una prueba de regresión.

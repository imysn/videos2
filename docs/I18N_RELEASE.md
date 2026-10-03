# Entrega de internacionalización ES / PL / EN

Rama: `feat/rave-i18n-es-pl-en`, creada desde exactamente `385a76df58b4bfc8dab0accfeeab639298580a0f`. No se fusiona con la rama estable ni se accede a la Raspberry. Toda la verificación usa datos sintéticos en Codex o GitHub Actions.

## Resultado de producto

Los tres catálogos contienen **364 claves semánticas y 367 valores de traducción por idioma**; las formas plurales explican la diferencia. Cubren autenticación/activación, navegación, biblioteca/ficha/búsqueda, visionado, sala/chat/presencia/control, reproductor y ajustes, cuenta/sesiones/contraseña, todo admin, fuentes/Drive, almacenamiento, errores, confirmaciones, estados vacíos, placeholders y accesibilidad.

El mismo control AST, aplicado a los archivos web comparables del commit base y de esta rama, detecta **82 ocurrencias de texto hardcodeado antes y 0 después**. Esto mide literales detectables, no datos externos ni el contenido escrito por usuarios. También se reemplaza el catálogo anterior de fragmentos por frases completas con interpolación semántica.

OWNER sin preferencia usa ES; PARTNER sin preferencia usa PL, por rol estable. Ambos pueden elegir ES/PL/EN. El locale se valida y guarda en `users.preferences_json.locale` mediante el endpoint de cuenta existente, conservando otras preferencias. No hay migración ni cambios de usernames. Login y activación tienen selector; Cuenta y navegación permiten cambiar inmediatamente, también durante reproducción. Una nueva carga/dispositivo recupera la preferencia del servidor. Si falla el guardado, la presentación revierte y muestra el error localizado.

## Arquitectura y obligación permanente

- `apps/web/src/i18n/{es,pl,en}.ts`: ES define las claves/parametrización; PL y EN deben satisfacer el tipo exacto `Catalog`.
- `types.ts`, `index.ts`, `provider.tsx`: claves y argumentos tipados, interpolación, `Intl.PluralRules`, formatos `es-ES`/`pl-PL`/`en-GB`, contexto React y `html.lang`. Fallback runtime explícito a ES; paridad estricta en CI.
- `LanguageSelect.tsx`, `features/account/LanguagePreference.tsx`, `app/auth.tsx`: selección prelogin local/navegador/ES y autoridad posterior de la cuenta, actualización optimista y rollback.
- `packages/contracts/src/locale.ts`, esquema de preferencias y `AuthService.profile`: defaults/validación comunes y compatibilidad con cuentas existentes.
- `scripts/eslint-i18n.mjs`, `eslint.config.js`: regla AST en todo el código web, con excepciones técnicas mínimas y tests de su conexión real a ESLint.
- `tests/unit/i18n.test.ts`, `tests/integration/i18n.test.ts`, `tests/e2e/i18n.spec.ts`: **41 pruebas nuevas** (27 unit, 3 integración, 11 E2E).
- `.github/workflows/i18n.yml`: en cada push/PR ejecuta paridad, lint, TypeScript, build, unit, persistencia PostgreSQL, navegador/axe y secret scan. Una clave solo ES o `<button>Guardar</button>` impide un resultado válido.
- [AGENTS.md](../AGENTS.md) exige mantener los tres idiomas en cualquier futura modificación de interfaz; [I18N.md](I18N.md) explica implementación, plurales, excepciones, cuarto idioma y checklist obligatorio.

No se traducen códigos API, URLs, nombres propios, metadatos, mensajes de chat ni archivos SRT/VTT. Los avisos guardan códigos/claves y se traducen al renderizar, de modo que también cambian los errores ya visibles. El Picker futuro recibe el locale de interfaz; sus traducciones son de Google.

## Verificación

Código de aplicación verificado: `56246864566c816044fc7bc9fde844ebbe6d588d`. Los commits posteriores de informe contienen únicamente documentación y evidencia. Resultados resumidos en [i18n.json](../artifacts/verification/i18n.json).

| Comprobación                                                                        | Resultado                                                                                                     |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Format, ESLint con AST i18n, TypeScript strict, build                               | PASS                                                                                                          |
| Unit, suite completa                                                                | 93 PASS; 27 i18n; cobertura branches room-core 94,21%                                                         |
| Integración, suite completa                                                         | 72 PASS, incluyendo 3 de preferencias i18n                                                                    |
| Integración browser-resilience, repetición tras cambios de accesibilidad del player | 16 PASS                                                                                                       |
| Seguridad                                                                           | 36 PASS                                                                                                       |
| Contratos de proveedores                                                            | 15 PASS; no equivalen a OAuth live                                                                            |
| E2E, suite completa                                                                 | 23 PASS, sin skips, retries ni flaky; 11 i18n                                                                 |
| ES/PL/EN en 390/768/1440                                                            | PASS; 153 análisis axe nuevos sin infracciones y texto de calidad completo                                    |
| Secret scan y archivos privados rastreados                                          | PASS, 0 hallazgos; `.local` y secretos reales fuera de Git                                                    |
| CI i18n, código final                                                               | [PASS en GitHub](https://github.com/imysn/videos2/actions/runs/37119052708)                                   |
| Docker nativo amd64 y ARM64, código final                                           | [PASS_CONFIG / PASS_BUILD / PASS_RUNTIME en ambas](https://github.com/imysn/videos2/actions/runs/37119052608) |

La suite completa de integración se ejecutó antes de los ajustes finales de presentación; después se repitió la suite afectada de browser-resilience. No se eliminaron pruebas ni se redujeron umbrales. Los builds Docker se ejecutan en runners nativos distintos y crean contenedores: no se confunde Compose config con runtime.

La prueba de sala usa **dos HTMLVideoElement reales**, verifica que cambiar ES → PL → EN → ES mantiene el mismo elemento/source, no emite `loadstart`, conserva tiempo/reproducción, host/hostEpoch/revision/sesión, Socket.IO, volumen y preferencias de pistas. Un subtítulo polaco seleccionado y el mensaje original del chat permanecen intactos. Las pruebas responsive cubren páginas admin, biblioteca, ficha, cuenta, not-found, login, activación, player con ajustes y sala; los diálogos modales se analizan con axe sobre el diálogo y se comprueba foco dentro de él.

## Cobertura de los requisitos I18N

| IDs   | Regresión                                                                                            |
| ----- | ---------------------------------------------------------------------------------------------------- |
| 01–03 | Locales exactos, claves/estructura/parámetros idénticos y valores no vacíos; TypeScript y unit.      |
| 04–05 | Defaults OWNER/PARTNER en unit, PostgreSQL y login HTTP real.                                        |
| 06–07 | Guardado individual, reload y nueva sesión/dispositivo; integración y navegador.                     |
| 08–09 | Selector preauth, prioridad local/navegador/fallback y autoridad de la cuenta al entrar.             |
| 10    | Cambiar Jason no altera la preferencia ni presentación de pareja.                                    |
| 11    | Cambio durante reproducción real sin recrear vídeo/socket ni modificar estado de sala.               |
| 12–14 | Admin, sala y player en ES/PL/EN, con fuentes sintéticas reproducibles.                              |
| 15    | Códigos HTTP/socket/cliente conocidos y error de login se localizan; errores arbitrarios se ocultan. |
| 16    | AST positivo/negativo y test que verifica la configuración ESLint real del repositorio.              |
| 17–18 | Anchos 390/768/1440, overflow, texto de calidad completo y axe sin infracciones.                     |
| 19    | Fallback ES resiliente y controles negativos de catálogo incompleto/extra/vacío/divergente.          |
| 20    | Mensaje persistido y visible literalmente en ambos clientes antes/después del cambio.                |

## Correcciones mínimas encontradas y límites reales

[DEVIATIONS.md](DEVIATIONS.md) registra FIX-026–029: navegación admin duplicada, semántica ARIA incorrecta del menú de ajustes con selects, nombre accesible del Thumb del slider y etiqueta polaca de calidad cortada en móvil. Se corrigen con los componentes Radix ya instalados y CSS mínimo, sin rediseñar producto ni cambiar la lógica de sincronización.

La verificación de navegador utiliza Chromium en Linux y anchos emulados; no certifica Safari/iOS/Android físicos. La Raspberry no se tocó. No se realizó autorización real de Google OAuth/Picker. No hay sincronización push de locale entre dispositivos: una nueva carga/sesión consulta la preferencia guardada. El AST detecta literales, pero no puede determinar el significado de todos los datos externos; las fronteras de presentación siguen sujetas a revisión conforme a AGENTS. No se repitió el soak de 30 minutos para esta tarea de presentación; sí se ejecutaron las pruebas normales y específicas de sincronización con dos vídeos reales.

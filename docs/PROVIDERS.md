# Fuentes V1

| Fuente           | Implementación                                                                                                                     | Verificación                                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Archivos propios | Upload durable, worker FFmpeg, MP4 compatible, HLS opt-in, Range privado y recursos asociados.                                     | Vídeos sintéticos reales y checksums; reproductor nativo/adaptativo.                                                                    |
| HTTPS directo    | Inspección acotada, clasificación/identidad/duración, Range, CORS y relay solo de archivo autorizado.                              | Transporte controlado con parsers reales y negativos SSRF; no se atribuye acceso a un enlace externo privado que no se haya autorizado. |
| HLS/DASH VOD     | Shaka core, orígenes aprobados/CSP, capacidades/pistas reales, sin iframe ni DRM.                                                  | Fixtures FFmpeg; origen HTTPS separado para CORS correcto/ausente y segmentos 404.                                                      |
| Google Drive     | OAuth web oficial, Picker `drive.file`, selección expresa de Jason, referencias/tokens cifrados, relay para ambos y refresh único. | Contratos separados de la prueba viva. SRC-07 permanece bloqueado: no existe OAuth del proyecto ni consentimiento.                      |

MEGA, OneDrive y TeraBox no tienen conectores dedicados ni se presentan como integrados. R2/S3 solo pueden aportar enlaces HTTPS compatibles y autorizados según el plan.

El estado distingue implementación, configuración, autorización y lectura real verificada. Ningún test con `gatewayFactory` actualiza `last_verified_at`. El runner vivo exige ficha Drive publicada, ambas cuentas habilitadas y primer cambio de contraseña completado; fuerza refresh real del SDK y prueba dos contextos con vídeo/seek/pausa. Su resultado actual está en `artifacts/providers/live.json`.

Un enlace manual vencido exige reemplazo por Jason. Reemplazar conservando contexto requiere identidad comprobada; contenido diferente crea generación y conserva registros anteriores separados. Ningún refresco inventa tokens. Recheck no convierte una nueva versión en el contenido anterior. No hay borrado remoto de archivos Google desde Rave.

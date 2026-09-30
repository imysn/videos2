# Estado

Rama: `feat/rave-private-v1`. Origen preservado: `54debc0`.

- P00 completado: paquete íntegro leído; once checksums correctos; PostgreSQL 17, FFmpeg, age, Chromium, Node 24 y pnpm 11 operativos en el entorno autorizado.
- P01–P11 implementados en buena parte, todavía en verificación: dos cuentas, API, SQL, biblioteca, cargas reanudables, worker real, vídeo nativo/HLS, progreso, sala autoritativa, transferencia, chat y conector Drive oficial. Faltan completar gates y trazabilidad; no se marcan fases aprobadas por tener código.
- Verificado: build/tipos/lint; 58 unitarias (94.11% ramas room-core), 28 integración, 31 seguridad, 10 contratos Drive. E2E individual/HLS/responsive pasan; sala repetida PASS. Dos pruebas de resiliencia observan vídeos y cortes WebSocket reales. Repetir checks afectados por cambios posteriores.
- P12: segundo soak de 30 minutos en terminal 61167 con RSS del proceso correcto. Primer resultado de tiempos preservado en `artifacts/sync/baseline`; su memoria no era válida. Resultado nuevo pendiente.
- P13: backup age/checksums y restauración en DB/directorio nuevos PASS; login, catálogo y reproducción/seek reales en `artifacts/restore/result.json`. Repetición pendiente tras guardas nuevas.
- P14 pendiente: auditoría integral, commits, publicación de rama/PR si el acceso permite, informe final.

Evidencias: `artifacts/verification`, `artifacts/sync`, `artifacts/network`, `artifacts/restore`. Los contratos Drive no marcan `liveVerifiedAt`.

Bloqueos externos confirmados por el propietario: no dispone todavía de alojamiento ni OAuth/Picker. No hay dispositivo móvil físico conectado. Docker registry deniega la descarga por política de red; ejecución nativa disponible. Véase `BLOCKERS.md`.

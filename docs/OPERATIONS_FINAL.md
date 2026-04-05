# Operational Final State

Este documento consolida el estado tecnico-operativo final del backend y del gobierno de datos/seguridad ya implementado.

## 1. Arquitectura final aprobada

- adjuntos fisicos: almacenamiento local en el servidor de la municipalidad
- metadata de adjuntos: PostgreSQL
- Firebase:
  - Auth: si
  - Firestore: si
  - Firebase Storage: no operativo

Decision cerrada:

- el proyecto no usa Firebase Storage para adjuntos
- `firebase.json` del cliente solo mantiene Firestore rules
- las referencias generadas a `storageBucket` en archivos de Firebase config no implican uso real

## 2. Endurecimiento de seguridad completado

Estado cerrado:

- resolucion de actor por Firebase ID token en backend
- guardas por actor/rol en endpoints institucionales
- `verification-codes` endurecido:
  - allowlist de `purpose`
  - `citizen-registration` pre-auth
  - `password-change` con actor autenticado y validacion de ownership del target
  - cooldown persistente
  - rate limit por target e IP
- `/api/auditoria/eventos` endurecido:
  - allowlist publica reducida
  - `login_failure` como unica excepcion pre-auth
  - `actorFallback` acotado
  - rate limit por IP e identificador
- auditoria marcada con:
  - `metadata.audit_source = 'server' | 'client'`
- reglas Firestore desplegadas y validadas
- Firebase Storage fuera del flujo operativo

## 3. Scheduler y jobs de retencion

Mecanismo vigente:

- jobs CLI Node.js en `scripts/retention`
- wrapper operativo: `scripts/retention/run_retention_job.ps1`
- registro de tareas Windows: `scripts/retention/register_windows_tasks.ps1`

Estado del scheduler:

- el problema de `LogonType` en Windows Task Scheduler ya esta resuelto
- el script usa `-LogonType Interactive`
- no requiere otra correccion para ese bug

Programacion operativa actual:

- `verification_codes_prune`
  - diario `02:15`
  - `execute`
- `audit_events_archive_rollover`
  - semanal, domingo `02:45`
  - `dry-run`
- `attachments_reconcile_report`
  - semanal, domingo `03:15`
  - `dry-run`

No automatizados todavia:

- `attachments_quarantine_orphans`
- `attachments_restore_from_quarantine`
- `gps_retention_prune`
- `camera_log_prune`
- `camera_daily_reports_retention`

## 4. Estado por job de retencion

| job | implementado | dry-run validado | execute realizado | automatizado | observaciones |
|---|---|---:|---:|---:|---|
| `verification_codes_prune` | si | si | si | si | primer `execute` manual ya probado; scheduler promovido a `execute` |
| `audit_events_archive_rollover` | si | si | no | si | scheduler en `dry-run`; requiere candidatos reales para primer `execute` |
| `attachments_reconcile_report` | si | si | no aplica | si | job de reporte; hoy sin huerfanos ni faltantes |
| `attachments_quarantine_orphans` | si | si | si | no | validado con prueba controlada; manual solamente |
| `attachments_restore_from_quarantine` | si | si | si | no | restore probado end-to-end con corrida sintetica |
| `gps_retention_prune` | si | si | no | no | `dry-run` real ejecutado; hoy `0` candidatos |
| `camera_log_prune` | si | si | no | no | `dry-run` real ejecutado; hoy `0` candidatos |
| `camera_daily_reports_retention` | si | si | no | no | `dry-run` real ejecutado; hoy `0` candidatos |

## 5. Variables `.env` criticas

### Seguridad / API

- `API_KEY`
- `REQUIRE_HTTPS`

### Firebase / identidad backend

- `FIREBASE_SERVICE_ACCOUNT_JSON`
- `GOOGLE_APPLICATION_CREDENTIALS`
- `FIREBASE_ALLOW_LOCAL_FILE_FALLBACK`

### Base de datos

- `PG_USER`
- `PG_HOST`
- `PG_DATABASE`
- `PG_PASSWORD`
- `PG_PORT`
- `PG_SSL`
- `PG_SSL_REJECT_UNAUTHORIZED`

### Uploads locales

- `UPLOAD_DIR`
- `MAX_UPLOAD_IMAGE_BYTES`
- `MAX_UPLOAD_PDF_BYTES`

### Verification codes

- `VERIFICATION_CODE_EXPIRY_MINUTES`
- `VERIFICATION_SEND_COOLDOWN_SECONDS`
- `VERIFICATION_VERIFY_MAX_ATTEMPTS`
- `VERIFICATION_VERIFY_LOCK_MINUTES`
- `VERIFICATION_VERIFY_IP_WINDOW_MS`
- `VERIFICATION_VERIFY_IP_MAX_ATTEMPTS`

### Auditoria client-driven

- `AUDIT_LOGIN_FAILURE_WINDOW_MS`
- `AUDIT_LOGIN_FAILURE_IP_MAX_EVENTS`
- `AUDIT_LOGIN_FAILURE_IDENTIFIER_MAX_EVENTS`

### Retencion

- `RETENTION_ENABLE_PRUNE`
- `RETENTION_MAX_DELETE_PER_RUN`
- `RETENTION_ATTACHMENTS_QUARANTINE_DIR`

Nota operativa:

- el scheduler no usa variables propias; consume el mismo `.env` del backend

## 6. Runbooks disponibles

- `scripts/retention/README.md`
  - mapa general de jobs y automatizacion
- `scripts/retention/ATTACHMENTS_RUNBOOK.md`
  - operacion de reconcile, quarantine, restore y rollback de adjuntos
- `scripts/retention/ATTACHMENTS_PURGE_SPEC.md`
  - diseno futuro del purge fisico final de adjuntos
- `scripts/retention/SECOND_WAVE_RUNBOOK.md`
  - operacion manual de GPS y camaras
- `scripts/retention/SECOND_WAVE_POST_EXECUTE_TEMPLATE.md`
  - plantilla de revision despues de un `execute`
- `docs/AUDIT_SERVER_DRIVEN_PLAN.md`
  - plan de transicion a auditoria mas server-driven
- `docs/AUDIT_CANONICAL_QUERIES.sql`
  - consultas canonicas priorizando `audit_source = 'server'`

## 7. Rollback / restauracion

### Reversible

- adjuntos en cuarentena:
  - se pueden restaurar con `attachments_restore_from_quarantine`
  - la restauracion es por copia, no por move
  - no sobreescribe destinos existentes
  - no toca metadata en PostgreSQL
- `audit_events_archive_rollover`:
  - conceptualmente reversible desde la tabla de archivo
  - no existe script de rollback automatizado todavia

### No reversible de forma nativa

- `verification_codes_prune`
- `gps_retention_prune`
- `camera_log_prune`
- `camera_daily_reports_retention`

Para estos casos:

- usar siempre `dry-run` antes de `execute`
- usar limites conservadores
- no automatizar sin historial estable

## 8. Estado final de Firebase

- Firestore: operativo y endurecido con reglas desplegadas
- Auth: operativo
- Firebase Storage: no operativo y fuera del flujo

Estado del cliente:

- `firebase.json` ya no referencia Storage
- no existe dependencia real a `firebase_storage`
- referencias generadas a `storageBucket` en `firebase_options.dart` o `google-services.json` no requieren accion

## 9. Pendientes reales

Abiertos de verdad:

- consolidar un primer `execute` real de `audit_events_archive_rollover` cuando existan candidatos
- esperar candidatos reales para la segunda ola (`gps` / `camaras`) antes de cualquier `execute`
- si en el futuro se quiere automatizar segunda ola:
  - hacerlo solo despues de varias corridas manuales estables

Cosas cerradas que no se deben seguir tocando:

- decision de no usar Firebase Storage
- reglas Firestore ya aplicadas
- endurecimiento de `verification-codes`
- endurecimiento de `/api/auditoria/eventos`
- restore de adjuntos desde cuarentena
- fix de `LogonType` en el scheduler

## 10. Cierre operativo recomendado

Observar periodicamente:

- logs de tareas programadas en `runtime_logs/retention`
- salud del backend
- volumen de auditoria `client` vs `server`
- resultados de `dry-run` de segunda ola

Ejecutar manualmente solo cuando aplique:

- `attachments_quarantine_orphans`
  - si `attachments_reconcile_report` detecta huerfanos reales
- `attachments_restore_from_quarantine`
  - si una corrida de cuarentena requiere rollback
- `audit_events_archive_rollover`
  - cuando el `dry-run` muestre candidatos reales y la tabla de archivo ya este validada
- `gps_retention_prune`, `camera_log_prune`, `camera_daily_reports_retention`
  - solo cuando el `dry-run` muestre candidatos reales y con limite conservador

Eventos que deben disparar intervencion:

- `errors` no vacio en cualquier job de retencion
- `warnings` inesperados o volumen candidato anomalo
- desbalance raro entre Firestore y PostgreSQL en GPS
- aparicion de huerfanos o faltantes en adjuntos
- eventos `client` de auditoria fuera de la allowlist esperada

## 11. Cierre practico

El proyecto ya esta tecnicamente endurecido y gobernado a un nivel suficiente para operacion controlada.

Lo que queda no es una re-arquitectura:

- son solo activaciones manuales futuras cuando existan candidatos reales
- y, opcionalmente, una automatizacion mas amplia despues de evidencia operativa

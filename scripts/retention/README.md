# Retention Automation

Este directorio contiene jobs CLI de retencion y los wrappers para automatizarlos de forma gradual en Windows.

## Mecanismo recomendado

- Ejecucion real de jobs: scripts Node.js ya existentes.
- Automatizacion operativa: Windows Task Scheduler.
- Wrapper seguro: `run_retention_job.ps1`.
- Registro de tareas sugeridas: `register_windows_tasks.ps1`.

## Politica inicial segura

- `verification_codes_prune`: programable. Empezar en `dry-run`.
- `audit_events_archive_rollover`: programable. Empezar en `dry-run`.
- `attachments_reconcile_report`: solo reporte, mantener en `dry-run`.
- `attachments_quarantine_orphans`: cuarentena segura de huerfanos. Empezar en `dry-run` y ejecutar solo de forma manual/controlada.

## Guardas existentes

- `RETENTION_ENABLE_PRUNE=true` para permitir acciones destructivas.
- `RETENTION_MAX_DELETE_PER_RUN` para limitar impacto por corrida.
- `--mode=dry-run|execute` en cada job.

## Runbook de adjuntos

La operacion detallada de adjuntos residuales, rollback y el diseno de la fase futura de purge fisico estan en:

- `scripts/retention/ATTACHMENTS_RUNBOOK.md`
- `scripts/retention/ATTACHMENTS_PURGE_SPEC.md`

## Preview de tareas sugeridas

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/retention/register_windows_tasks.ps1
```

## Registro de tareas seguras por defecto

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/retention/register_windows_tasks.ps1 -Apply
```

Por defecto, todas se registran en `dry-run`.

## Cambiar a execute mas adelante

Ejemplo controlado:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/retention/register_windows_tasks.ps1 `
  -Apply `
  -VerificationMode execute `
  -AuditMode execute `
  -AttachmentsMode dry-run
```

Antes de pasar a `execute`, validar:

- migracion de `auditoria_eventos_archive` aplicada
- `RETENTION_ENABLE_PRUNE=true` en el entorno correcto
- dry-runs estables
- limites (`RETENTION_MAX_DELETE_PER_RUN`) definidos

## Cuarentena segura de adjuntos huerfanos

Dry-run:

```powershell
node scripts/retention/attachments_quarantine_orphans.js --mode=dry-run --limit=100
```

Execute controlado:

```powershell
node scripts/retention/attachments_quarantine_orphans.js --mode=execute --limit=100
```

Comportamiento:

- solo considera archivos bajo `UPLOAD_ROOT`
- excluye el subarbol de cuarentena
- solo mueve huerfanos sin referencia en `incidencia_archivos`
- revalida la referencia en PostgreSQL justo antes de mover cada archivo
- no borra metadata
- no borra definitivamente archivos; los mueve a `UPLOAD_ROOT/_retention_quarantine/orphans/<run_id>/files/...`
- genera `manifest.json` por corrida para permitir restauracion manual

## Restore seguro desde cuarentena

Dry-run:

```powershell
node scripts/retention/attachments_restore_from_quarantine.js --run-id=<run_id> --mode=dry-run
```

Restore de un archivo puntual:

```powershell
node scripts/retention/attachments_restore_from_quarantine.js --run-id=<run_id> --mode=execute --file="INCIDENCIAS\\2026\\03\\TK-001\\archivo.pdf"
```

Restore de toda la corrida:

```powershell
node scripts/retention/attachments_restore_from_quarantine.js --run-id=<run_id> --mode=execute
```

Comportamiento:

- lee `manifest.json` del `run_id`
- valida que el origen en cuarentena exista
- valida que el destino original este libre
- no sobreescribe destinos existentes
- restaura por copia desde cuarentena al destino original
- no toca metadata en PostgreSQL

## Fase siguiente no implementada

El purge fisico final de adjuntos sigue siendo solo una fase de diseno. No existe job activo para esa etapa y no debe automatizarse todavia.

## Segunda ola de retencion operativa

Jobs implementados, solo para uso manual inicial:

- `gps_retention_prune`
- `camera_log_prune`
- `camera_daily_reports_retention`

Runbook y checklist de promocion a `execute`:

- `scripts/retention/SECOND_WAVE_RUNBOOK.md`
- `scripts/retention/SECOND_WAVE_POST_EXECUTE_TEMPLATE.md`

Dry-run sugeridos:

```powershell
node scripts/retention/gps_retention_prune.js --mode=dry-run --limit=100
node scripts/retention/camera_log_prune.js --mode=dry-run --limit=100
node scripts/retention/camera_daily_reports_retention.js --mode=dry-run --limit=100
```

Notas:

- `gps_retention_prune` trata Firestore y PostgreSQL como superficies distintas
- no automatizar estos jobs todavia
- no ejecutar `execute` sin revisar antes la salida del `dry-run`

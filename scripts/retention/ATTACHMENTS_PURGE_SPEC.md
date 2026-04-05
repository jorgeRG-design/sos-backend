# Attachments Final Purge Spec

Esta especificacion describe la fase futura de purge fisico final para adjuntos huerfanos ya puestos en cuarentena.

Estado:

- diseno aprobado
- no implementado
- no automatizado
- no debe ejecutarse todavia

## Objetivo

Eliminar fisicamente solo archivos ya cuarentenados, con manifest valido y revalidados como huerfanos persistentes.

Fuera de alcance:

- adjuntos activos
- metadata en PostgreSQL
- adjuntos inactivos con metadata historica
- cualquier archivo fuera de `_retention_quarantine`

## Dataset elegible

Solo archivos ubicados en:

- `<UPLOAD_ROOT>\\_retention_quarantine\\orphans\\<run_id>\\files\\...`

Y solo cuando exista:

- `<UPLOAD_ROOT>\\_retention_quarantine\\orphans\\<run_id>\\manifest.json`

## Politica propuesta

- ventana minima en cuarentena:
  `14 dias` desde `moved_at`
- revalidacion obligatoria:
  confirmar otra vez que `original_absolute_path` no tenga referencia en `incidencia_archivos`
- limite por corrida:
  `25` en la primera activacion real
- guardas:
  `RETENTION_ENABLE_PRUNE=true`
  `RETENTION_MAX_DELETE_PER_RUN`
  `--mode=dry-run|execute`

## Job futuro propuesto

Nombre:

- `attachments_prune_quarantined_orphans`

Ubicacion sugerida:

- `scripts/retention/attachments_prune_quarantined_orphans.js`

## CLI esperada

```powershell
node scripts/retention/attachments_prune_quarantined_orphans.js --mode=dry-run --limit=25
node scripts/retention/attachments_prune_quarantined_orphans.js --mode=execute --limit=25
node scripts/retention/attachments_prune_quarantined_orphans.js --mode=dry-run --limit=25 --cutoff=2026-04-01T00:00:00.000Z
```

## Flujo tecnico esperado

1. fijar `run_id` y `cutoff_ts`
2. enumerar subcarpetas de corridas bajo `_retention_quarantine/orphans`
3. cargar `manifest.json` de cada corrida
4. validar integridad minima del manifest
5. seleccionar solo entradas con `moved_at < cutoff`
6. revalidar contra PostgreSQL que `original_absolute_path` siga sin referencia
7. validar que `quarantine_absolute_path` exista y siga dentro de la cuarentena
8. aplicar `limit` y `RETENTION_MAX_DELETE_PER_RUN`
9. en `dry-run`, solo reportar candidatos
10. en `execute`, eliminar fisicamente el archivo en cuarentena
11. registrar resultado por entrada sin tocar metadata

## Reglas de seguridad

- nunca borrar fuera de la cuarentena
- nunca borrar si falta `manifest.json`
- nunca borrar si la entrada del manifest esta mal formada
- nunca borrar si `quarantine_absolute_path` no esta dentro de `QUARANTINE_ROOT`
- nunca borrar si reaparecio referencia en `incidencia_archivos`
- nunca tocar `original_absolute_path`
- nunca tocar PostgreSQL

## Logging minimo esperado

Salida final JSON:

- `run_id`
- `job`
- `mode`
- `cutoff_ts`
- `started_at`
- `ended_at`
- `duration_ms`
- `manifest_runs_scanned`
- `entries_scanned`
- `eligible_for_delete`
- `affected`
- `deleted_files`
- `skipped_manifest_invalid`
- `skipped_source_missing`
- `skipped_referenced_during_recheck`
- `batches_executed`
- `errors`
- `warnings`

## Modo de activacion recomendado

Fase 1:

- implementacion del job
- pruebas `dry-run`
- sin scheduler

Fase 2:

- primer `execute` manual con `limit=10` o `25`
- revision manual de logs

Fase 3:

- varios `execute` manuales sin incidentes

Fase 4:

- recien ahi evaluar automatizacion

## Prerrequisitos obligatorios antes de implementarlo

1. `attachments_reconcile_report` estable
2. `attachments_quarantine_orphans` probado
3. `attachments_restore_from_quarantine` probado end-to-end
4. al menos una corrida real con `manifest.json`
5. ventana legal/operativa de cuarentena aprobada
6. respaldo del almacenamiento local definido

## Riesgos residuales reales

- borrar demasiado pronto un archivo que aun se queria inspeccionar
- manifest corrupto o incompleto
- referencias metadata que aparezcan despues de la cuarentena
- ejecucion automatica prematura sin observacion suficiente

Mientras estos riesgos no esten absorbidos operativamente, esta fase debe seguir solo como diseno.

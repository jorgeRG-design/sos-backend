# Attachments Retention Runbook

Este documento define la operacion segura de adjuntos residuales en el backend.

Arquitectura vigente:

- archivos adjuntos fisicos: servidor local de la municipalidad
- metadata de adjuntos: PostgreSQL (`incidencia_archivos`)
- Firebase Storage: fuera de la arquitectura operativa

Estado actual implementado:

- `attachments_reconcile_report`
- `attachments_quarantine_orphans`
- `attachments_restore_from_quarantine`

Estado no implementado todavia:

- purge fisico final de adjuntos
- borrado de metadata
- limpieza automatica de adjuntos inactivos

## Definiciones operativas

- Archivo activo:
  existe fisicamente y tiene referencia metadata vigente en `incidencia_archivos`.

- Archivo inactivo:
  existe fisicamente y tiene metadata historica/inactiva. Esta fase todavia no la modifica.

- Archivo huerfano:
  existe fisicamente bajo `UPLOAD_ROOT`, pero no tiene referencia en `incidencia_archivos`.

- Metadata inconsistente:
  existe fila en `incidencia_archivos`, pero el archivo fisico no existe o la ruta no coincide.

## Runbook actual

### 1. Reconciliacion

Objetivo:

- detectar huerfanos
- detectar faltantes fisicos
- detectar inconsistencias sin mover ni borrar nada

Comando:

```powershell
cmd /c npm run retention:attachments:report -- --limit=5000
```

Validar en la salida JSON:

- `errors = []`
- `orphan_files`
- `missing_files`
- `active_refs`
- `inactive_refs`
- `upload_root`
- `quarantine_root`

Decision:

- si `orphan_files = 0`, no avanzar a cuarentena real
- si hay huerfanos, revisar una muestra manual antes de mover

### 2. Cuarentena segura

Objetivo:

- mover solo archivos huerfanos a una zona segura y reversible

Dry-run:

```powershell
cmd /c npm run retention:attachments:quarantine:dry -- --limit=100
```

Execute controlado:

```powershell
cmd /c npm run retention:attachments:quarantine:run -- --limit=100
```

Guardas requeridas para `execute`:

- `RETENTION_ENABLE_PRUNE=true`
- `RETENTION_MAX_DELETE_PER_RUN` definido

Protecciones del job:

- solo considera archivos bajo `UPLOAD_ROOT`
- excluye toda la subcarpeta de cuarentena
- no toca metadata
- revalida la ausencia de referencia en PostgreSQL justo antes de mover
- genera `manifest.json` por corrida

Destino de cuarentena por defecto:

- `<UPLOAD_ROOT>\\_retention_quarantine\\orphans\\<run_id>\\files\\...`

Manifest por corrida:

- `<UPLOAD_ROOT>\\_retention_quarantine\\orphans\\<run_id>\\manifest.json`

### 3. Restauracion desde cuarentena

Objetivo:

- devolver un archivo cuarentenado a su ubicacion original sin sobrescribir archivos existentes

Dry-run:

```powershell
cmd /c npm run retention:attachments:restore -- --run-id=<RUN_ID> --mode=dry-run
```

Restore de un archivo puntual:

```powershell
cmd /c npm run retention:attachments:restore -- --run-id=<RUN_ID> --mode=execute --file="INCIDENCIAS\\2026\\03\\TK-001\\archivo.pdf"
```

Protecciones del restore:

- valida que el origen siga en cuarentena
- valida que el destino siga dentro de `UPLOAD_ROOT`
- no sobreescribe si el destino ya existe
- restaura por copia, no por move
- no toca metadata en PostgreSQL

### 4. Rollback operativo

Si una corrida de cuarentena movio un archivo por error:

1. identificar el `run_id`
2. abrir el `manifest.json`
3. ejecutar primero restore en `dry-run`
4. si el destino esta libre, ejecutar restore en `execute`
5. verificar que el archivo reaparecio en la ruta original
6. confirmar que la copia de cuarentena sigue como respaldo

Comando recomendado:

```powershell
cmd /c npm run retention:attachments:restore -- --run-id=<RUN_ID> --mode=execute --file="<ORIGINAL_RELATIVE_PATH>"
```

## Fase futura: purge fisico final (diseno, no implementado)

Esta fase no existe todavia como job y no debe ejecutarse aun.

Objetivo futuro:

- eliminar fisicamente archivos ya cuarentenados y verificados como huerfanos persistentes

Condiciones minimas antes de implementarla:

- al menos una ronda real de cuarentena sin incidentes
- restore probado y documentado
- ventana minima de cuarentena acordada
- criterio legal/operativo aprobado para eliminacion fisica
- respaldo operativo del almacenamiento local definido

### Politica sugerida

- dataset elegible:
  solo archivos dentro de `_retention_quarantine/orphans/<run_id>/files/...`
- elegibilidad:
  archivos con `manifest.json` valido y antiguedad minima en cuarentena
- ventana inicial sugerida:
  `14 dias` desde `moved_at`
- revalidacion obligatoria antes de purge:
  confirmar otra vez que no exista referencia en `incidencia_archivos`
- limite por corrida:
  conservador, por ejemplo `25` o `50`

### Job futuro propuesto

Nombre sugerido:

- `attachments_prune_quarantined_orphans`

Modo de ejecucion recomendado:

- manual primero
- `dry-run` obligatorio
- `execute` solo con `RETENTION_ENABLE_PRUNE=true`
- no automatizar hasta acumular historial estable

Metricas minimas futuras:

- `run_id`
- `cutoff_ts`
- `manifest_runs_scanned`
- `files_scanned`
- `eligible_for_delete`
- `deleted_files`
- `skipped_referenced_during_recheck`
- `errors`
- `warnings`

Riesgos a evitar:

- purgar archivos fuera de cuarentena
- purgar archivos con metadata vigente
- purgar corridas sin manifest
- borrar respaldo antes de agotar la ventana de observacion

## Validacion minima antes de cualquier purge futuro

1. `attachments_reconcile_report` sin errores
2. `attachments_quarantine_orphans` validado en `dry-run`
3. cuarentena real con `manifest.json`
4. `attachments_restore_from_quarantine` probado correctamente
5. muestra manual confirmada por operacion
6. politica de ventana de cuarentena aprobada

Mientras esos puntos no esten cerrados, la operacion segura sigue siendo:

- reportar
- cuarentenar solo huerfanos
- restaurar si hace falta
- no purgar definitivamente

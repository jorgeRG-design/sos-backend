# Second Wave Post-Execute Review Template

Usar esta plantilla despues de cualquier `execute` manual de la segunda ola:

- `gps_retention_prune`
- `camera_log_prune`
- `camera_daily_reports_retention`

Objetivo:

- verificar que la corrida fue segura
- capturar evidencia minima
- decidir si el job puede repetirse manualmente
- decidir si aun no conviene automatizarlo

## 1. Datos de la corrida

- fecha/hora:
- operador:
- job:
- comando exacto:
- entorno:
- `RETENTION_ENABLE_PRUNE`:
- `RETENTION_MAX_DELETE_PER_RUN`:

## 2. Resumen JSON a conservar

Copiar estos campos de la salida:

- `run_id`
- `job`
- `mode`
- `cutoff_ts`
- `started_at`
- `ended_at`
- `duration_ms`
- `scanned`
- `candidates`
- `affected`
- `batches_executed`
- `errors`
- `warnings`

## 3. Validacion comun

Marcar:

- [ ] `mode = execute`
- [ ] `errors = []`
- [ ] `affected <= limit`
- [ ] `affected <= RETENTION_MAX_DELETE_PER_RUN`
- [ ] `warnings` vacio o entendible
- [ ] el `cutoff_ts` coincide con la politica aprobada

## 4. Validacion especifica por job

### GPS

Revisar:

- `firestore_cutoff_ts`
- `sql_cutoff_ts`
- `deleted_firestore`
- `deleted_sql`
- `candidates_firestore`
- `candidates_sql`

Checklist:

- [ ] `firestore_cutoff_ts` corresponde a `365 dias`
- [ ] `sql_cutoff_ts` corresponde a `730 dias`
- [ ] el volumen borrado en Firestore es razonable
- [ ] el volumen borrado en PostgreSQL es razonable
- [ ] no hay asimetria inesperada entre superficies

Observaciones:

-

### Bitacora de camaras

Revisar:

- `deleted_docs`
- `oldest_candidate_ts`
- `newest_candidate_ts`

Checklist:

- [ ] el rango temporal borrado supera `365 dias`
- [ ] el volumen eliminado es razonable
- [ ] no aparecieron warnings inesperados

Observaciones:

-

### Reportes diarios de camaras

Revisar:

- `cutoff_day`
- `deleted_docs`
- `candidates_fecha_hora`
- `candidates_fecha_dia`

Checklist:

- [ ] `cutoff_day` corresponde a `24 meses`
- [ ] el volumen eliminado es razonable
- [ ] no se ve patron raro por duplicidad entre `fecha_hora` y `fecha_dia`

Observaciones:

-

## 5. Verificacion funcional minima

### GPS

- [ ] la pantalla de importar GPS sigue cargando
- [ ] no hay error nuevo al leer `recorridos_gps`

### Camaras

- [ ] la gestion de camaras sigue cargando
- [ ] la bitacora sigue mostrando datos recientes
- [ ] los reportes diarios siguen mostrando datos recientes

## 6. Decision operativa

Elegir una:

- [ ] corrida aceptada, puede repetirse manualmente si reaparecen candidatos
- [ ] corrida aceptada, pero aun no automatizar
- [ ] corrida con hallazgos, pausar nuevos `execute`

Motivo:

-

## 7. Criterio para promover a scheduler

Solo si se cumplen todos:

- [ ] al menos 2 o 3 `execute` manuales sin incidentes
- [ ] volumen de borrado estable
- [ ] operacion valida que la ventana es correcta
- [ ] no hubo regresion funcional observada
- [ ] existe evidencia guardada de las corridas previas

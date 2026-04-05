# Second Wave Retention Runbook

Este documento define la operacion manual y segura de la segunda ola de retencion operativa.

Datasets cubiertos:

- `recorridos_gps`
- `bitacora_camaras`
- `reportes_diarios_camaras`

Estado actual:

- jobs implementados
- `dry-run` validado
- no automatizados
- no promovidos a `execute`

Plantilla post-ejecucion:

- `scripts/retention/SECOND_WAVE_POST_EXECUTE_TEMPLATE.md`

## Politicas vigentes

### GPS

- Firestore `recorridos_gps`: `365 dias`
- PostgreSQL `public.recorridos_gps`: `730 dias`

### Bitacora de camaras

- Firestore `bitacora_camaras`: `365 dias`

### Reportes diarios de camaras

- Firestore `reportes_diarios_camaras`: `24 meses`

## Jobs disponibles

### 1. GPS

Job:

- `scripts/retention/gps_retention_prune.js`

Comandos:

```powershell
cmd /c npm run retention:gps:dry -- --limit=100
cmd /c npm run retention:gps:run -- --limit=100
```

Caracteristicas:

- trata Firestore y PostgreSQL como superficies distintas
- usa cutoff separado por defecto:
  - Firestore: `now - 365 dias`
  - SQL: `now - 730 dias`
- en `dry-run` solo reporta
- en `execute` aplica borrado por superficie con limite total acotado

Campos clave de salida:

- `firestore_cutoff_ts`
- `sql_cutoff_ts`
- `candidates_firestore`
- `candidates_sql`
- `deleted_firestore`
- `deleted_sql`
- `errors`
- `warnings`

### 2. Bitacora de camaras

Job:

- `scripts/retention/camera_log_prune.js`

Comandos:

```powershell
cmd /c npm run retention:camera-log:dry -- --limit=100
cmd /c npm run retention:camera-log:run -- --limit=100
```

Caracteristicas:

- usa `fecha_hora` como criterio de retencion
- opera solo sobre Firestore
- en `dry-run` no toca datos

Campos clave de salida:

- `candidates_fecha_hora`
- `deleted_docs`
- `oldest_candidate_ts`
- `newest_candidate_ts`
- `errors`
- `warnings`

### 3. Reportes diarios de camaras

Job:

- `scripts/retention/camera_daily_reports_retention.js`

Comandos:

```powershell
cmd /c npm run retention:camera-daily:dry -- --limit=100
cmd /c npm run retention:camera-daily:run -- --limit=100
```

Caracteristicas:

- usa dos criterios complementarios:
  - `fecha_hora`
  - `fecha_dia`
- deduplica por `doc.id`
- opera solo sobre Firestore

Campos clave de salida:

- `cutoff_day`
- `candidates_docs`
- `candidates_fecha_hora`
- `candidates_fecha_dia`
- `deleted_docs`
- `errors`
- `warnings`

## Salida esperada del dry-run

### Caso sin candidatos

Es completamente valido ver:

- `candidates = 0`
- `affected = 0`
- `errors = []`

Eso significa:

- el job esta funcionando
- la ventana aprobada aun no encuentra datos suficientemente antiguos

### Caso con candidatos

Antes de autorizar `execute`, revisar:

- `errors = []`
- `warnings` entendibles
- `cutoff_ts` correcto
- volumen razonable de `candidates`
- timestamps mas antiguos coherentes con la politica aprobada

## Checklist de promocion a execute

### Pre-check comun

1. confirmar que el ultimo `dry-run` del job termino con:
   - `errors = []`
2. confirmar que `cutoff_ts` coincide con la politica aprobada
3. confirmar que el volumen candidato es razonable para el dataset
4. confirmar que `RETENTION_ENABLE_PRUNE=true` solo en el entorno correcto
5. confirmar que `RETENTION_MAX_DELETE_PER_RUN` este definido de forma conservadora
6. no automatizar todavia
7. hacer el primer `execute` solo manualmente

### Pre-check GPS

1. revisar por separado:
   - `candidates_firestore`
   - `candidates_sql`
2. si una superficie muestra volumen inesperado, no ejecutar
3. validar que `sql_cutoff_ts` sea mas largo que `firestore_cutoff_ts`
4. primer `execute` sugerido:
   - `--limit=25` o `--limit=50`

### Pre-check bitacora de camaras

1. revisar:
   - `oldest_candidate_ts`
   - `newest_candidate_ts`
2. confirmar que el rango candidato realmente supera `365 dias`
3. primer `execute` sugerido:
   - `--limit=25` o `--limit=50`

### Pre-check reportes diarios

1. revisar:
   - `cutoff_day`
   - `candidates_fecha_hora`
   - `candidates_fecha_dia`
2. confirmar que el volumen no venga de un problema de datos duplicados
3. primer `execute` sugerido:
   - `--limit=25`

## Primer execute recomendado

### GPS

```powershell
cmd /c npm run retention:gps:run -- --limit=25
```

Validar despues:

- `deleted_firestore <= 25`
- `deleted_sql <= 25`
- `errors = []`

### Bitacora de camaras

```powershell
cmd /c npm run retention:camera-log:run -- --limit=25
```

Validar despues:

- `deleted_docs <= 25`
- `errors = []`

### Reportes diarios de camaras

```powershell
cmd /c npm run retention:camera-daily:run -- --limit=25
```

Validar despues:

- `deleted_docs <= 25`
- `errors = []`

## Rollback y criterio operativo

Estos tres jobs son de purge fisico/logico directo sobre datos operativos historicos.

Por eso:

- no tienen rollback nativo
- requieren respaldo previo si el equipo necesita recuperacion historica
- no deben pasar a scheduler hasta acumular corridas manuales estables

## Criterio para automatizar mas adelante

No promover a scheduler hasta tener:

1. varios `dry-run` consistentes
2. al menos una corrida `execute` manual sin incidentes
3. volumen de candidatos estable y entendible
4. confirmacion operativa de que la ventana aprobada es correcta

Hasta entonces, estos jobs deben seguir:

- manuales
- con revision humana
- y con `execute` solo cuando el `dry-run` lo justifique

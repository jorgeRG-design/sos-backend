-- =============================================================================
-- 003_campos_faltantes_incidencias.sql
-- Añade columnas que el frontend envía al crear/cerrar incidencias pero que
-- solo se persistían en Firestore.  Todas son ADD COLUMN IF NOT EXISTS para
-- poder ejecutar el script de forma idempotente.
-- =============================================================================

BEGIN;

-- Campos de apertura de incidencia (crearIncidencia)
ALTER TABLE incidencias ADD COLUMN IF NOT EXISTS direccion_referencial TEXT;
ALTER TABLE incidencias ADD COLUMN IF NOT EXISTS solicitante          TEXT;
ALTER TABLE incidencias ADD COLUMN IF NOT EXISTS efectivo_asignado_dni    TEXT;
ALTER TABLE incidencias ADD COLUMN IF NOT EXISTS efectivo_asignado_nombre TEXT;
ALTER TABLE incidencias ADD COLUMN IF NOT EXISTS vehiculo_asignado   TEXT;
ALTER TABLE incidencias ADD COLUMN IF NOT EXISTS vehiculo_codigo     TEXT;
ALTER TABLE incidencias ADD COLUMN IF NOT EXISTS vehiculo_alias      TEXT;
ALTER TABLE incidencias ADD COLUMN IF NOT EXISTS medio_comunicacion  TEXT;
ALTER TABLE incidencias ADD COLUMN IF NOT EXISTS persona_contactada  TEXT;
ALTER TABLE incidencias ADD COLUMN IF NOT EXISTS alerta_firestore_id TEXT;

-- Campos de cierre de incidencia (cerrarIncidencia) que se extraen del body
-- pero no se guardaban en PostgreSQL
ALTER TABLE incidencias ADD COLUMN IF NOT EXISTS cumplio_sla  BOOLEAN;
ALTER TABLE incidencias ADD COLUMN IF NOT EXISTS dni_efectivo TEXT;

COMMIT;

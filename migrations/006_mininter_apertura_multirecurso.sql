-- =============================================================================
-- 006_mininter_apertura_multirecurso.sql
-- Tablas hijas auditables (N serenos, N vehículos) y columnas apertura/Anexo.
-- incidencias.id es UUID en este proyecto.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS incidencia_efectivos (
  id SERIAL PRIMARY KEY,
  incidencia_id UUID NOT NULL REFERENCES incidencias(id) ON DELETE CASCADE,
  dni TEXT,
  nombre TEXT,
  orden SMALLINT NOT NULL DEFAULT 0,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_incidencia_efectivos_incidencia
  ON incidencia_efectivos (incidencia_id);

CREATE TABLE IF NOT EXISTS incidencia_vehiculos_asignados (
  id SERIAL PRIMARY KEY,
  incidencia_id UUID NOT NULL REFERENCES incidencias(id) ON DELETE CASCADE,
  vehiculo_codigo TEXT,
  vehiculo_alias TEXT,
  placa TEXT,
  tipo TEXT,
  texto_asignado TEXT,
  orden SMALLINT NOT NULL DEFAULT 0,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_incidencia_vehiculos_incidencia
  ON incidencia_vehiculos_asignados (incidencia_id);

ALTER TABLE incidencias ADD COLUMN IF NOT EXISTS hora_alerta TIME;
ALTER TABLE incidencias ADD COLUMN IF NOT EXISTS manzana TEXT;
ALTER TABLE incidencias ADD COLUMN IF NOT EXISTS lote TEXT;
ALTER TABLE incidencias ADD COLUMN IF NOT EXISTS tipo_zona TEXT;
ALTER TABLE incidencias ADD COLUMN IF NOT EXISTS nombre_zona TEXT;
ALTER TABLE incidencias ADD COLUMN IF NOT EXISTS ubigeo_departamento TEXT;
ALTER TABLE incidencias ADD COLUMN IF NOT EXISTS ubigeo_provincia TEXT;
ALTER TABLE incidencias ADD COLUMN IF NOT EXISTS ubigeo_distrito TEXT;
ALTER TABLE incidencias ADD COLUMN IF NOT EXISTS relacion_victima_victimario TEXT;

COMMIT;

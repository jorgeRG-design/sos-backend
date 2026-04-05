-- =============================================================================
-- 004_expandir_tipo_incidencias.sql
-- El clasificador oficial contiene tipos de incidencia con nombres mayores a
-- 100 caracteres. La columna `incidencias.tipo` seguía como VARCHAR(100), lo
-- que impide registrar incidencias válidas del catálogo oficial.
-- =============================================================================

BEGIN;

ALTER TABLE incidencias
  ALTER COLUMN tipo TYPE TEXT;

COMMIT;

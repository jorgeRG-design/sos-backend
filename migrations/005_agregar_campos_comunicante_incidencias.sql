BEGIN;

ALTER TABLE incidencias
  ADD COLUMN IF NOT EXISTS comunicante_dni TEXT,
  ADD COLUMN IF NOT EXISTS comunicante_nombres TEXT,
  ADD COLUMN IF NOT EXISTS comunicante_celular TEXT;

COMMIT;

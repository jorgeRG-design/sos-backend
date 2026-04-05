BEGIN;

ALTER TABLE public.incidencias
  ADD COLUMN IF NOT EXISTS sector_id INTEGER;

ALTER TABLE public.incidencias
  ADD COLUMN IF NOT EXISTS sector_nombre TEXT;

COMMIT;

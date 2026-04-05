BEGIN;

ALTER TABLE public.incidencias
  ADD COLUMN IF NOT EXISTS requiere_apoyo BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.incidencias
  ADD COLUMN IF NOT EXISTS asignacion_central BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.incidencias
  ADD COLUMN IF NOT EXISTS fecha_asignacion TIMESTAMPTZ;

ALTER TABLE public.incidencias
  ADD COLUMN IF NOT EXISTS hora_aceptacion TIMESTAMPTZ;

ALTER TABLE public.incidencias
  ADD COLUMN IF NOT EXISTS ultima_actualizacion_operativa TIMESTAMPTZ;

COMMIT;

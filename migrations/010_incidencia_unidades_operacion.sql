BEGIN;

CREATE TABLE IF NOT EXISTS public.incidencia_unidades_operacion (
  id SERIAL PRIMARY KEY,
  incidencia_id UUID NOT NULL REFERENCES public.incidencias(id) ON DELETE CASCADE,
  unidad_id TEXT NOT NULL,
  estado_operacion TEXT NOT NULL,
  fuente_asignacion TEXT,
  fecha_asignacion TIMESTAMPTZ,
  fecha_aceptacion TIMESTAMPTZ,
  fecha_liberacion TIMESTAMPTZ,
  requiere_apoyo BOOLEAN NOT NULL DEFAULT FALSE,
  fecha_solicitud_apoyo TIMESTAMPTZ,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;

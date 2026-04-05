CREATE UNIQUE INDEX IF NOT EXISTS uq_incidencia_unidades_operacion_incidencia_unidad
ON public.incidencia_unidades_operacion (incidencia_id, unidad_id);

CREATE INDEX IF NOT EXISTS idx_incidencia_unidades_operacion_incidencia
ON public.incidencia_unidades_operacion (incidencia_id);

CREATE INDEX IF NOT EXISTS idx_incidencia_unidades_operacion_unidad
ON public.incidencia_unidades_operacion (unidad_id);

CREATE INDEX IF NOT EXISTS idx_incidencia_unidades_operacion_estado
ON public.incidencia_unidades_operacion (estado_operacion);

CREATE INDEX IF NOT EXISTS idx_incidencias_estado_fecha_asignacion
ON public.incidencias (estado, fecha_asignacion DESC);

CREATE INDEX IF NOT EXISTS idx_incidencias_requiere_apoyo_estado
ON public.incidencias (requiere_apoyo, estado);

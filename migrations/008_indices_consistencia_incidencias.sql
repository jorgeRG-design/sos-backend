CREATE INDEX IF NOT EXISTS idx_incidencias_ticket
ON public.incidencias (ticket);

CREATE INDEX IF NOT EXISTS idx_incidencias_alerta_firestore_id
ON public.incidencias (alerta_firestore_id);

CREATE INDEX IF NOT EXISTS idx_incidencias_estado_fecha
ON public.incidencias (estado, fecha DESC);

CREATE INDEX IF NOT EXISTS idx_incidencias_sector_id
ON public.incidencias (sector_id);

-- Metadata de archivos adjuntos al cierre de parte (binarios en disco, no en BD).
-- Migracion segura para entornos nuevos. Si la tabla ya existe, no modifica tipos
-- ni aplica cambios en caliente en esta fase.

CREATE TABLE IF NOT EXISTS public.incidencia_archivos (
    id SERIAL PRIMARY KEY,
    incidencia_id UUID NOT NULL REFERENCES public.incidencias(id) ON DELETE CASCADE,
    tipo_archivo VARCHAR(20) NOT NULL,
    nombre_original TEXT NOT NULL,
    nombre_guardado TEXT NOT NULL,
    ruta_archivo TEXT NOT NULL,
    extension VARCHAR(10),
    mime_type VARCHAR(100),
    tamano_bytes BIGINT,
    correlativo INTEGER,
    codigo_sereno_asignado VARCHAR(100),
    subido_por VARCHAR(100),
    fecha_subida TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    observacion TEXT,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT chk_incidencia_archivos_tipo
      CHECK (tipo_archivo IN ('imagen', 'pdf'))
);

CREATE INDEX IF NOT EXISTS idx_incidencia_archivos_incidencia
ON public.incidencia_archivos (incidencia_id);

CREATE INDEX IF NOT EXISTS idx_incidencia_archivos_incidencia_activo
ON public.incidencia_archivos (incidencia_id, activo);

CREATE INDEX IF NOT EXISTS idx_incidencia_archivos_incidencia_correlativo
ON public.incidencia_archivos (incidencia_id, correlativo);

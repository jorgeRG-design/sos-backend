-- ============================================================================
-- 015_postgis_zonas.sql
-- Habilita PostGIS e introduce la tabla `zonas` con soporte geoespacial real.
-- Las zonas representan sectores/polígonos del distrito de Santa Anita.
-- ============================================================================

BEGIN;

-- PostGIS (requiere que la extensión esté disponible en el servidor)
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS public.zonas (
    id         SERIAL PRIMARY KEY,
    nombre     TEXT NOT NULL,
    codigo     TEXT,
    descripcion TEXT,
    color_hex  TEXT DEFAULT '#3388FF',
    activo     BOOLEAN NOT NULL DEFAULT TRUE,
    geom       GEOMETRY(MULTIPOLYGON, 4326),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zonas_geom ON public.zonas USING GIST(geom);
CREATE UNIQUE INDEX IF NOT EXISTS uq_zonas_nombre ON public.zonas (nombre) WHERE activo = TRUE;

-- Función que asigna zona_id / zona_nombre a una incidencia dado un punto
CREATE OR REPLACE FUNCTION public.fn_zona_para_punto(p_lat DOUBLE PRECISION, p_lng DOUBLE PRECISION)
RETURNS TABLE(zona_id INTEGER, zona_nombre TEXT) AS $$
  SELECT z.id, z.nombre
  FROM public.zonas z
  WHERE z.activo = TRUE
    AND ST_Contains(z.geom, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326))
  ORDER BY z.id
  LIMIT 1;
$$ LANGUAGE SQL STABLE;

COMMIT;

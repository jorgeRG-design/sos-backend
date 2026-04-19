-- ============================================================================
-- 017_incidencias_pnp.sql
-- Tabla separada para incidencias externas de la PNP (carga vía Excel).
-- No se mezcla con la tabla `incidencias` del sistema CEMVI.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.incidencias_pnp (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Tipificación jerárquica
    nivel1_codigo   TEXT,
    nivel1_nombre   TEXT,
    nivel2_codigo   TEXT,
    nivel2_nombre   TEXT,
    nivel3_codigo   TEXT,
    nivel3_nombre   TEXT NOT NULL,
    codigo_tipo     TEXT,
    -- Temporal
    fecha_ocurrencia DATE,
    hora_ocurrencia  TIME,
    -- Espacial
    latitud         DOUBLE PRECISION,
    longitud        DOUBLE PRECISION,
    geom            GEOMETRY(POINT, 4326),
    zona_id         INTEGER REFERENCES public.zonas(id) ON DELETE SET NULL,
    zona_nombre     TEXT,
    -- Descriptivo
    direccion       TEXT,
    distrito        TEXT,
    descripcion     TEXT,
    -- Fuente y carga
    fuente          TEXT NOT NULL DEFAULT 'PNP',
    comisaria       TEXT,
    archivo_origen  TEXT,
    lote_carga      TEXT,
    fecha_carga     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    usuario_carga   TEXT
);

-- Índice espacial
CREATE INDEX IF NOT EXISTS idx_incidencias_pnp_geom
    ON public.incidencias_pnp USING GIST(geom);

-- Índices de consulta frecuente
CREATE INDEX IF NOT EXISTS idx_incidencias_pnp_zona
    ON public.incidencias_pnp (zona_id);
CREATE INDEX IF NOT EXISTS idx_incidencias_pnp_fecha
    ON public.incidencias_pnp (fecha_ocurrencia);
CREATE INDEX IF NOT EXISTS idx_incidencias_pnp_nivel3
    ON public.incidencias_pnp (nivel3_nombre);
CREATE INDEX IF NOT EXISTS idx_incidencias_pnp_lote
    ON public.incidencias_pnp (lote_carga);

COMMIT;

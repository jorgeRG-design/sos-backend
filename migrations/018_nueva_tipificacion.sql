-- ============================================================================
-- 018_nueva_tipificacion.sql
-- Reemplaza la tabla clasificador_incidencias por la nueva tabla tipificacion.
-- Nuevo esquema: nivel1 / nivel2 / nivel3 / descripcion / codigo_autogenerado.
-- No hay FK desde incidencias (las columnas tipologia_* almacenan texto directo).
-- ============================================================================

BEGIN;

-- Eliminar vista creada en migración 016
DROP VIEW IF EXISTS public.v_tipificacion;

-- Eliminar tabla anterior con todos sus índices y constraints
DROP TABLE IF EXISTS public.clasificador_incidencias CASCADE;

-- ─── Nueva tabla ─────────────────────────────────────────────────────────────

CREATE TABLE public.tipificacion (
    id                  SERIAL PRIMARY KEY,
    nivel1              TEXT NOT NULL,
    nivel2              TEXT NOT NULL,
    nivel3              TEXT NOT NULL,
    descripcion         TEXT,
    codigo_autogenerado TEXT UNIQUE,
    activo              BOOLEAN NOT NULL DEFAULT TRUE,
    orden               INTEGER,

    CONSTRAINT uq_tipificacion_jerarquia UNIQUE (nivel1, nivel2, nivel3)
);

-- Índices de consulta
CREATE INDEX idx_tipificacion_nivel1 ON public.tipificacion (nivel1);
CREATE INDEX idx_tipificacion_nivel2 ON public.tipificacion (nivel2);
CREATE INDEX idx_tipificacion_nivel3 ON public.tipificacion (nivel3);

-- Índice de texto completo para búsqueda ILIKE eficiente en nivel3
CREATE INDEX idx_tipificacion_nivel3_lower
    ON public.tipificacion (lower(nivel3));

COMMIT;

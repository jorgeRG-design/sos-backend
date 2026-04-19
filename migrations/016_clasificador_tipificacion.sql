-- ============================================================================
-- 016_clasificador_tipificacion.sql
-- Añade campo `codigo` unificado y vista `v_tipificacion` con nomenclatura
-- nivel1/nivel2/nivel3 para la estructura jerárquica del clasificador.
-- ============================================================================

BEGIN;

-- Campo código compuesto único (formato: MOD.SUB.TIP)
ALTER TABLE public.clasificador_incidencias
    ADD COLUMN IF NOT EXISTS codigo TEXT GENERATED ALWAYS AS (
        modalidad_codigo || '.' || subtipo_codigo || '.' || tipo_codigo
    ) STORED;

CREATE UNIQUE INDEX IF NOT EXISTS uq_clasificador_codigo
    ON public.clasificador_incidencias (codigo) WHERE activo = TRUE;

-- Índice para búsqueda rápida por nivel3 (tipo)
CREATE INDEX IF NOT EXISTS idx_clasificador_tipo_nombre
    ON public.clasificador_incidencias (tipo_nombre);
CREATE INDEX IF NOT EXISTS idx_clasificador_tipo_codigo
    ON public.clasificador_incidencias (tipo_codigo);

-- Vista con alias nivel1/nivel2/nivel3 para consumo uniforme en frontend
CREATE OR REPLACE VIEW public.v_tipificacion AS
SELECT
    id,
    codigo,
    modalidad_codigo  AS nivel1_codigo,
    modalidad_nombre  AS nivel1_nombre,
    subtipo_codigo    AS nivel2_codigo,
    subtipo_nombre    AS nivel2_nombre,
    tipo_codigo       AS nivel3_codigo,
    tipo_nombre       AS nivel3_nombre,
    activo,
    orden
FROM public.clasificador_incidencias;

COMMIT;

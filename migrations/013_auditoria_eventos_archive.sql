CREATE TABLE IF NOT EXISTS public.auditoria_eventos_archive (
    id BIGINT PRIMARY KEY,
    actor_uid TEXT,
    actor_identificador TEXT,
    actor_rol TEXT,
    actor_tipo TEXT,
    accion TEXT NOT NULL,
    objeto_tipo TEXT,
    objeto_id TEXT,
    resultado TEXT NOT NULL,
    detalle TEXT,
    ip_origen TEXT,
    user_agent TEXT,
    canal TEXT,
    metadata JSONB,
    creado_en TIMESTAMPTZ NOT NULL,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auditoria_eventos_archive_creado_en
ON public.auditoria_eventos_archive (creado_en DESC);

CREATE INDEX IF NOT EXISTS idx_auditoria_eventos_archive_actor_uid
ON public.auditoria_eventos_archive (actor_uid);

CREATE INDEX IF NOT EXISTS idx_auditoria_eventos_archive_actor_identificador
ON public.auditoria_eventos_archive (actor_identificador);

CREATE INDEX IF NOT EXISTS idx_auditoria_eventos_archive_accion
ON public.auditoria_eventos_archive (accion);

CREATE INDEX IF NOT EXISTS idx_auditoria_eventos_archive_objeto
ON public.auditoria_eventos_archive (objeto_tipo, objeto_id);

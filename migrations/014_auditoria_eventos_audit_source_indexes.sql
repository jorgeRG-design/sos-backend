CREATE INDEX IF NOT EXISTS idx_auditoria_eventos_audit_source_expr
ON public.auditoria_eventos ((COALESCE(metadata->>'audit_source', 'server')));

CREATE INDEX IF NOT EXISTS idx_auditoria_eventos_audit_source_creado_en
ON public.auditoria_eventos ((COALESCE(metadata->>'audit_source', 'server')), creado_en DESC);

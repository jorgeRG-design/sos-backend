-- Auditoria canonica priorizando source=server

-- 1) Listado general reciente, priorizando server sobre client.
SELECT
  id,
  creado_en,
  accion,
  resultado,
  actor_uid,
  actor_identificador,
  actor_rol,
  actor_tipo,
  objeto_tipo,
  objeto_id,
  detalle,
  ip_origen,
  user_agent,
  canal,
  COALESCE(metadata->>'audit_source', 'server') AS audit_source,
  metadata
FROM public.auditoria_eventos
ORDER BY
  CASE
    WHEN COALESCE(metadata->>'audit_source', 'server') = 'server' THEN 0
    ELSE 1
  END ASC,
  creado_en DESC,
  id DESC
LIMIT 200;

-- 2) Solo eventos canonicos server-driven.
SELECT
  id,
  creado_en,
  accion,
  resultado,
  actor_identificador,
  actor_tipo,
  objeto_tipo,
  objeto_id,
  detalle,
  metadata
FROM public.auditoria_eventos
WHERE COALESCE(metadata->>'audit_source', 'server') = 'server'
ORDER BY creado_en DESC, id DESC
LIMIT 200;

-- 3) Solo telemetria client-driven.
SELECT
  id,
  creado_en,
  accion,
  resultado,
  actor_identificador,
  actor_tipo,
  detalle,
  COALESCE(metadata->>'audit_source', 'server') AS audit_source,
  metadata
FROM public.auditoria_eventos
WHERE COALESCE(metadata->>'audit_source', 'server') = 'client'
ORDER BY creado_en DESC, id DESC
LIMIT 200;

-- 4) Conteo por accion y source.
SELECT
  accion,
  COALESCE(metadata->>'audit_source', 'server') AS audit_source,
  COUNT(*)::int AS total
FROM public.auditoria_eventos
GROUP BY accion, COALESCE(metadata->>'audit_source', 'server')
ORDER BY accion, audit_source;

-- 5) Resumen diario por source.
SELECT
  DATE_TRUNC('day', creado_en) AS dia,
  COALESCE(metadata->>'audit_source', 'server') AS audit_source,
  COUNT(*)::int AS total
FROM public.auditoria_eventos
GROUP BY DATE_TRUNC('day', creado_en), COALESCE(metadata->>'audit_source', 'server')
ORDER BY dia DESC, audit_source;

-- 6) Eventos client-driven que no deberian existir si el catalogo futuro se recorta.
SELECT
  id,
  creado_en,
  accion,
  actor_identificador,
  detalle,
  metadata
FROM public.auditoria_eventos
WHERE COALESCE(metadata->>'audit_source', 'server') = 'client'
  AND accion NOT IN ('login_success', 'login_failure', 'logout', 'password_change')
ORDER BY creado_en DESC, id DESC;

-- 7) Foco operativo: login_failure client-driven reciente.
SELECT
  id,
  creado_en,
  actor_identificador,
  actor_tipo,
  resultado,
  detalle,
  ip_origen,
  metadata
FROM public.auditoria_eventos
WHERE accion = 'login_failure'
  AND COALESCE(metadata->>'audit_source', 'server') = 'client'
ORDER BY creado_en DESC, id DESC
LIMIT 200;

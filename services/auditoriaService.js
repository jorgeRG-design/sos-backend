const pool = require('../config/db');
const AUDIT_SOURCES = new Set(['client', 'server']);

function textoSeguro(value, maxLength = 300) {
  if (value == null) return null;
  const txt = String(value).trim();
  if (!txt) return null;
  return txt.length > maxLength ? txt.slice(0, maxLength) : txt;
}

function auditSourceSeguro(value, defaultValue = 'server') {
  const txt = textoSeguro(value, 20)?.toLowerCase();
  if (!txt || !AUDIT_SOURCES.has(txt)) {
    return defaultValue;
  }
  return txt;
}

function metadataSegura(metadata, auditSource = 'server') {
  const source = auditSourceSeguro(auditSource, 'server');
  const base =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? { ...metadata }
      : {};

  base.audit_source = source;
  return base;
}

function auditSourceExpr(metadataColumn = 'metadata') {
  return `COALESCE(${metadataColumn}->>'audit_source', 'server')`;
}

function auditSourcePriorityExpr(metadataColumn = 'metadata') {
  const sourceExpr = auditSourceExpr(metadataColumn);
  return `CASE WHEN ${sourceExpr} = 'server' THEN 0 ELSE 1 END`;
}

function canonicalAuditOrderBy({
  metadataColumn = 'metadata',
  createdAtColumn = 'creado_en'
} = {}) {
  return `${auditSourcePriorityExpr(metadataColumn)} ASC, ${createdAtColumn} DESC`;
}

function ipOrigen(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').trim();
  if (forwarded) {
    return textoSeguro(forwarded.split(',')[0], 120);
  }
  return textoSeguro(req?.ip, 120);
}

function canalOrigen(req) {
  return (
    textoSeguro(req?.headers?.['x-client-platform'], 40) ||
    textoSeguro(req?.headers?.['x-platform'], 40) ||
    'api'
  );
}

function actorDesdeEntrada(req, actorFallback = null) {
  const actor = req?.actor || actorFallback || {};
  return {
    uid: textoSeguro(actor.uid, 191),
    identificador:
      textoSeguro(actor.identificador, 191) ||
      textoSeguro(actor.email, 191) ||
      textoSeguro(actor.dni, 191),
    rol: textoSeguro(actor.rol, 100),
    tipo: textoSeguro(actor.tipo, 100)
  };
}

async function registrarEvento({
  req,
  accion,
  objetoTipo = null,
  objetoId = null,
  resultado = 'success',
  detalle = null,
  metadata = null,
  actorFallback = null,
  auditSource = 'server'
}) {
  const actor = actorDesdeEntrada(req, actorFallback);
  const result = await pool.query(
    `INSERT INTO auditoria_eventos (
       actor_uid,
       actor_identificador,
       actor_rol,
       actor_tipo,
       accion,
       objeto_tipo,
       objeto_id,
       resultado,
       detalle,
       ip_origen,
       user_agent,
       canal,
       metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id, creado_en`,
    [
      actor.uid,
      actor.identificador,
      actor.rol,
      actor.tipo,
      textoSeguro(accion, 120) || 'unknown_action',
      textoSeguro(objetoTipo, 120),
      textoSeguro(objetoId, 191),
      textoSeguro(resultado, 40) || 'success',
      textoSeguro(detalle, 500),
      ipOrigen(req),
      textoSeguro(req?.headers?.['user-agent'], 500),
      canalOrigen(req),
      metadataSegura(metadata, auditSource)
    ]
  );

  return result.rows[0] || null;
}

async function registrarEventoSeguro(args) {
  try {
    return await registrarEvento(args);
  } catch (error) {
    console.error('[auditoria] No se pudo registrar el evento:', error.message);
    return null;
  }
}

module.exports = {
  registrarEvento,
  registrarEventoSeguro,
  auditSourceExpr,
  auditSourcePriorityExpr,
  canonicalAuditOrderBy
};

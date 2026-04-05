const { sendOk, sendError } = require('../utils/apiResponse');
const { registrarEvento } = require('../services/auditoriaService');
const { CLIENT_AUDIT_ACTIONS, isPublicClientAuditAction } = require('../utils/auditCatalog');

const TIPOS_ACTOR_LOGIN_FAILURE = new Set(['ciudadano', 'central', 'operativo']);
const DEFAULT_LOGIN_FAILURE_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_LOGIN_FAILURE_IP_MAX_EVENTS = 20;
const DEFAULT_LOGIN_FAILURE_IDENTIFIER_MAX_EVENTS = 5;
const loginFailureIpBuckets = new Map();
const loginFailureIdentifierBuckets = new Map();

function parsePositiveInt(value, defaultValue) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return Math.trunc(parsed);
}

function loginFailureWindowMs() {
  return parsePositiveInt(
    process.env.AUDIT_LOGIN_FAILURE_WINDOW_MS,
    DEFAULT_LOGIN_FAILURE_WINDOW_MS
  );
}

function loginFailureIpMaxEvents() {
  return parsePositiveInt(
    process.env.AUDIT_LOGIN_FAILURE_IP_MAX_EVENTS,
    DEFAULT_LOGIN_FAILURE_IP_MAX_EVENTS
  );
}

function loginFailureIdentifierMaxEvents() {
  return parsePositiveInt(
    process.env.AUDIT_LOGIN_FAILURE_IDENTIFIER_MAX_EVENTS,
    DEFAULT_LOGIN_FAILURE_IDENTIFIER_MAX_EVENTS
  );
}

function ipOrigen(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').trim();
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return String(req?.ip || '').trim();
}

function cleanBucket(map, key, nowMs) {
  const windowMs = loginFailureWindowMs();
  const bucket = (map.get(key) || []).filter((value) => nowMs - value < windowMs);
  if (bucket.length > 0) {
    map.set(key, bucket);
  } else {
    map.delete(key);
  }
  return bucket;
}

function registerBucketHit(map, key, nowMs) {
  if (!key) return [];
  const bucket = cleanBucket(map, key, nowMs);
  bucket.push(nowMs);
  map.set(key, bucket);

  const windowMs = loginFailureWindowMs();
  setTimeout(() => {
    cleanBucket(map, key, Date.now());
  }, windowMs).unref?.();

  return bucket;
}

function buildRetryAfterSeconds(nowMs, bucket) {
  if (!Array.isArray(bucket) || bucket.length === 0) {
    return 1;
  }
  const retryAfterMs = bucket[0] + loginFailureWindowMs() - nowMs;
  return Math.max(1, Math.ceil(retryAfterMs / 1000));
}

function actorFallbackValido(bodyActor) {
  if (!bodyActor || typeof bodyActor !== 'object' || Array.isArray(bodyActor)) {
    return { ok: false };
  }

  const keys = Object.keys(bodyActor);
  if (keys.length === 0) {
    return { ok: false };
  }

  const allowedKeys = new Set(['tipo', 'identificador']);
  if (keys.some((key) => !allowedKeys.has(key))) {
    return { ok: false };
  }

  const tipo = String(bodyActor.tipo || '').trim().toLowerCase();
  const identificador = String(bodyActor.identificador || '').trim();

  if (!TIPOS_ACTOR_LOGIN_FAILURE.has(tipo) || !identificador) {
    return { ok: false };
  }

  return {
    ok: true,
    actor: {
      tipo,
      identificador: identificador.slice(0, 191)
    }
  };
}

function validarRateLimitLoginFailure(req, actorFallback) {
  const nowMs = Date.now();
  const ip = ipOrigen(req);
  const identifier = String(actorFallback?.identificador || '').trim();

  const ipBucket = registerBucketHit(loginFailureIpBuckets, ip, nowMs);
  if (ipBucket.length > loginFailureIpMaxEvents()) {
    return buildRetryAfterSeconds(nowMs, ipBucket);
  }

  const keyByIdentifier = ip && identifier ? `${ip}::${identifier}` : '';
  const identifierBucket = registerBucketHit(
    loginFailureIdentifierBuckets,
    keyByIdentifier,
    nowMs
  );
  if (
    keyByIdentifier &&
    identifierBucket.length > loginFailureIdentifierMaxEvents()
  ) {
    return buildRetryAfterSeconds(nowMs, identifierBucket);
  }

  return null;
}

exports.registrarEvento = async (req, res) => {
  const body = req.body || {};
  const accion = String(body.accion || '').trim();
  const resultado = String(body.resultado || 'success').trim() || 'success';
  let actorFallback = null;

  if (!accion || !isPublicClientAuditAction(accion)) {
    return sendError(res, {
      status: 400,
      code: 'invalid_audit_action',
      message: 'La accion de auditoria no es valida.'
    });
  }

  if (!req.actor && req.actorAuthError && accion !== CLIENT_AUDIT_ACTIONS.LOGIN_FAILURE) {
    return sendError(res, {
      status: 401,
      code: 'invalid_actor_token',
      message: 'Token de actor invalido o vencido.'
    });
  }

  if (!req.actor && accion !== CLIENT_AUDIT_ACTIONS.LOGIN_FAILURE) {
    return sendError(res, {
      status: 401,
      code: 'actor_auth_required',
      message: 'Se requiere autenticacion del actor para registrar este evento.'
    });
  }

  if (!req.actor && accion === CLIENT_AUDIT_ACTIONS.LOGIN_FAILURE) {
    const sanitizedActor = actorFallbackValido(body.actor);
    if (!sanitizedActor.ok) {
      return sendError(res, {
        status: 400,
        code: 'invalid_audit_actor',
        message: 'El actor de auditoria no es valido para login_failure.'
      });
    }
    actorFallback = sanitizedActor.actor;

    const retryAfterSeconds = validarRateLimitLoginFailure(req, actorFallback);
    if (retryAfterSeconds != null) {
      res.set('Retry-After', String(retryAfterSeconds));
      return sendError(res, {
        status: 429,
        code: 'audit_login_failure_rate_limited',
        message:
          'Demasiados eventos de fallo de inicio de sesion. Espere antes de intentar nuevamente.'
      });
    }
  }

  try {
    const inserted = await registrarEvento({
      req,
      accion,
      objetoTipo: body.objeto_tipo || null,
      objetoId: body.objeto_id || null,
      resultado,
      detalle: body.detalle || null,
      metadata: body.metadata || null,
      actorFallback,
      auditSource: 'client'
    });

    return sendOk(res, {
      status: 201,
      message: 'Evento de auditoria registrado.',
      data: inserted || { registrado: true }
    });
  } catch (error) {
    return sendError(res, {
      status: 500,
      code: 'audit_event_failed',
      message: 'No se pudo registrar el evento de auditoria.'
    });
  }
};

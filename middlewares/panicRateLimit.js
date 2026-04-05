const pool = require('../config/db');
const { sendOk, sendError } = require('../utils/apiResponse');

const RATE_LIMIT_WINDOW_MS = parsePositiveInt(
  process.env.PANIC_RATE_LIMIT_WINDOW_MS,
  60_000
);
const RATE_LIMIT_MAX_REQUESTS = parsePositiveInt(
  process.env.PANIC_RATE_LIMIT_MAX_REQUESTS,
  3
);
const DEDUPE_WINDOW_SECONDS = parsePositiveInt(
  process.env.PANIC_DEDUPE_WINDOW_SECONDS,
  45
);
const DEDUPE_MAX_DISTANCE_METERS = parsePositiveInt(
  process.env.PANIC_DEDUPE_MAX_DISTANCE_METERS,
  150
);
const ACTIVE_BUCKETS = new Map();

function parsePositiveInt(value, defaultValue) {
  if (value == null || String(value).trim() === '') {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return Math.trunc(parsed);
}

function texto(value) {
  const trimmed = String(value || '').trim();
  return trimmed || null;
}

function normalizarComparable(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function esSolicitudBotonPanico(body) {
  const origen = normalizarComparable(body?.origen);
  if (origen === 'boton_panico') {
    return true;
  }

  const fuente = normalizarComparable(body?.fuente);
  const subtipo = normalizarComparable(body?.tipologia_subtipo);

  return (
    fuente.includes('panico') ||
    subtipo.includes('panico') ||
    fuente.includes('boton de panico') ||
    fuente.includes('boton panico')
  );
}

function resolverIdentidadDedupe(req) {
  const actorDni = texto(req.actor?.dni);
  if (actorDni) {
    return { valor: actorDni, fuente: 'actor_dni' };
  }

  const actorIdentificador = texto(req.actor?.identificador);
  if (actorIdentificador) {
    return { valor: actorIdentificador, fuente: 'actor_identificador' };
  }

  const bodyDni = texto(req.body?.comunicante_dni);
  if (bodyDni) {
    return { valor: bodyDni, fuente: 'body_comunicante_dni' };
  }

  return null;
}

function construirClaveRateLimit(req) {
  return (
    texto(req.actor?.uid) ||
    texto(req.actor?.identificador) ||
    texto(req.ip) ||
    'anonimo'
  );
}

function parseCoordinate(value) {
  if (value == null || value === '') {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function distanciaMetros(lat1, lng1, lat2, lng2) {
  const toRad = (degrees) => (degrees * Math.PI) / 180;
  const earthRadius = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadius * c;
}

function solicitanteCompatibleConIdentidad(body, identidad) {
  const solicitante = texto(body?.solicitante);
  if (!solicitante || !identidad) {
    return null;
  }
  const solicitanteNorm = normalizarComparable(solicitante);
  const identidadNorm = normalizarComparable(identidad);
  return solicitanteNorm.includes(identidadNorm) ? solicitante : null;
}

function construirRespuestaDedupe(row, metadata = {}) {
  return {
    status: 200,
    message: 'Incidencia de boton de panico ya registrada recientemente.',
    data: {
      ...row,
      incidencia_id: row.id,
      firestore_id: row.alerta_firestore_id
    },
    meta: {
      deduplicada: true,
      ...metadata
    },
    legacy: {
      id: row.id,
      incidencia_id: row.id,
      mensaje: 'Incidencia de boton de panico ya registrada recientemente.',
      ticket: row.ticket,
      numero_incidencia: row.numero_incidencia,
      firestore_id: row.alerta_firestore_id,
      deduplicada: true
    }
  };
}

async function buscarIncidenciaPanicoDuplicada(req) {
  const identidad = resolverIdentidadDedupe(req);
  if (!identidad) {
    return null;
  }

  const solicitanteMatch = solicitanteCompatibleConIdentidad(req.body, identidad.valor);
  const params = [DEDUPE_WINDOW_SECONDS, identidad.valor];
  let sql = `
    SELECT
      id,
      ticket,
      numero_incidencia,
      alerta_firestore_id,
      estado,
      fecha,
      comunicante_dni,
      solicitante,
      latitud,
      longitud
    FROM incidencias
    WHERE origen = 'boton_panico'
      AND fecha >= NOW() - ($1 * INTERVAL '1 second')
      AND estado NOT IN ('resuelta', 'cerrada', 'cancelada')
      AND TRIM(COALESCE(comunicante_dni, '')) = $2
  `;

  if (solicitanteMatch) {
    params.push(solicitanteMatch);
    sql += `
      OR (
        origen = 'boton_panico'
        AND fecha >= NOW() - ($1 * INTERVAL '1 second')
        AND estado NOT IN ('resuelta', 'cerrada', 'cancelada')
        AND TRIM(COALESCE(solicitante, '')) = $3
      )
    `;
  }

  sql += `
    ORDER BY fecha DESC
    LIMIT 5
  `;

  const result = await pool.query(sql, params);
  if (result.rows.length === 0) {
    return null;
  }

  const latReq = parseCoordinate(req.body?.latitud);
  const lngReq = parseCoordinate(req.body?.longitud);
  const tieneCoordsReq = latReq !== null && lngReq !== null;

  for (const row of result.rows) {
    const firestoreId = texto(row.alerta_firestore_id);
    if (!firestoreId) {
      continue;
    }

    const latRow = parseCoordinate(row.latitud);
    const lngRow = parseCoordinate(row.longitud);
    const tieneCoordsRow = latRow !== null && lngRow !== null;

    if (tieneCoordsReq && tieneCoordsRow) {
      const distancia = distanciaMetros(latReq, lngReq, latRow, lngRow);
      if (distancia > DEDUPE_MAX_DISTANCE_METERS) {
        continue;
      }
      return {
        row: {
          ...row,
          alerta_firestore_id: firestoreId
        },
        meta: {
          identidad_fuente: identidad.fuente,
          distancia_metros: Math.round(distancia),
          ventana_segundos: DEDUPE_WINDOW_SECONDS
        }
      };
    }

    return {
      row: {
        ...row,
        alerta_firestore_id: firestoreId
      },
      meta: {
        identidad_fuente: identidad.fuente,
        distancia_metros: null,
        ventana_segundos: DEDUPE_WINDOW_SECONDS
      }
    };
  }

  return null;
}

function limpiarTimestampsExpirados(timestamps, now) {
  return timestamps.filter((value) => now - value < RATE_LIMIT_WINDOW_MS);
}

function registrarIntentoRateLimit(key, now) {
  const actual = ACTIVE_BUCKETS.get(key) || [];
  const vigentes = limpiarTimestampsExpirados(actual, now);
  vigentes.push(now);
  ACTIVE_BUCKETS.set(key, vigentes);
  return vigentes;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of ACTIVE_BUCKETS.entries()) {
    const vigentes = limpiarTimestampsExpirados(timestamps, now);
    if (vigentes.length === 0) {
      ACTIVE_BUCKETS.delete(key);
      continue;
    }
    ACTIVE_BUCKETS.set(key, vigentes);
  }
}, RATE_LIMIT_WINDOW_MS).unref();

async function panicRateLimit(req, res, next) {
  if (!esSolicitudBotonPanico(req.body || {})) {
    return next();
  }

  try {
    const duplicada = await buscarIncidenciaPanicoDuplicada(req);
    if (duplicada) {
      return sendOk(res, construirRespuestaDedupe(duplicada.row, duplicada.meta));
    }

    const rateLimitKey = construirClaveRateLimit(req);
    const now = Date.now();
    const bucket = registrarIntentoRateLimit(rateLimitKey, now);

    if (bucket.length > RATE_LIMIT_MAX_REQUESTS) {
      return sendError(res, {
        status: 429,
        code: 'panic_rate_limited',
        message:
          'Demasiadas alertas de boton de panico en un periodo corto. Espere unos segundos e intente nuevamente.'
      });
    }

    return next();
  } catch (error) {
    console.error('[panicRateLimit] Error evaluando dedupe/rate limit:', error);
    return sendError(res, {
      status: 500,
      code: 'panic_guard_failed',
      message: 'No se pudo validar temporalmente la alerta de boton de panico.'
    });
  }
}

module.exports = panicRateLimit;

const admin = require('firebase-admin');

const dbFirestore = require('../config/firebase');
const { sendError } = require('../utils/apiResponse');

function bearerToken(req) {
  const raw = String(req.headers.authorization || '').trim();
  if (!raw) return null;
  if (!raw.toLowerCase().startsWith('bearer ')) {
    return null;
  }
  return raw.slice(7).trim() || null;
}

function texto(value) {
  const txt = String(value || '').trim();
  return txt || null;
}

function booleanoActivo(value) {
  return value !== false;
}

function estadoAccesoNormalizado(value) {
  const txt = texto(value);
  return txt ? txt.toLowerCase() : 'activo';
}

async function resolverActor(decodedToken) {
  const uid = texto(decodedToken?.uid);
  const email = texto(decodedToken?.email)?.toLowerCase() || null;

  if (!uid) {
    return null;
  }

  if (email && email.endsWith('@santaanita.gob.pe')) {
    const profileSnap = await dbFirestore.collection('usuarios_central').doc(email).get();
    const data = profileSnap.exists ? profileSnap.data() || {} : {};
    const dependencia = texto(data.dependencia);
    const esOperativo = dependencia === 'Serenazgo';

    if (profileSnap.exists) {
      const estadoAcceso = estadoAccesoNormalizado(data.estado_acceso);
      return {
        uid,
        email,
        identificador: texto(data.dni) || email.split('@')[0],
        dni: texto(data.dni),
        nombre: texto(data.nombres),
        tipo: esOperativo ? 'operativo' : 'central',
        rol: texto(data.rol) || (esOperativo ? 'operativo' : 'operador'),
        permisos: data.permisos && typeof data.permisos === 'object' ? data.permisos : null,
        dependencia,
        activo: booleanoActivo(data.activo) && estadoAcceso !== 'revocado',
        estado_acceso: estadoAcceso
      };
    }
  }

  if (email && email.endsWith('@ciudadano.sos')) {
    const identificador = email.split('@')[0];
    const citizenSnap = await dbFirestore.collection('ciudadanos').doc(identificador).get();
    const data = citizenSnap.exists ? citizenSnap.data() || {} : {};
    return {
      uid,
      email,
      identificador: texto(data.numero_doc) || identificador,
      dni: texto(data.numero_doc) || identificador,
      nombre: texto(data.nombre),
      tipo: 'ciudadano',
      rol: 'ciudadano',
      permisos: null,
      dependencia: null,
      activo: true,
      estado_acceso: 'activo'
    };
  }

  return {
    uid,
    email,
    identificador: email || uid,
    dni: null,
    nombre: null,
    tipo: 'autenticado',
    rol: null,
    permisos: null,
    dependencia: null,
    activo: true,
    estado_acceso: 'activo'
  };
}

async function attachActorContext(req, _res, next) {
  req.actor = null;
  req.actorAuthError = null;

  const token = bearerToken(req);
  if (!token) {
    return next();
  }

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.actor = await resolverActor(decoded);
  } catch (error) {
    req.actorAuthError = error;
  }

  return next();
}

function rechazarAuth(res, code, message) {
  return sendError(res, {
    status: 401,
    code,
    message
  });
}

function actorRevocadoOInactivo(actor) {
  if (!actor) return false;
  return actor.activo === false || actor.estado_acceso === 'revocado';
}

function rechazarAccesoRevocado(res) {
  return sendError(res, {
    status: 403,
    code: 'actor_access_revoked',
    message: 'La cuenta institucional no tiene acceso habilitado.'
  });
}

function requireAuthenticatedActor(req, res, next) {
  if (req.actor) {
    if (actorRevocadoOInactivo(req.actor)) {
      return rechazarAccesoRevocado(res);
    }
    return next();
  }
  if (req.actorAuthError) {
    return rechazarAuth(res, 'invalid_actor_token', 'Token de actor invalido o vencido.');
  }
  return rechazarAuth(res, 'actor_auth_required', 'Autenticacion de actor requerida.');
}

function requireInstitutionalActor(req, res, next) {
  if (!req.actor) {
    return requireAuthenticatedActor(req, res, next);
  }
  if (actorRevocadoOInactivo(req.actor)) {
    return rechazarAccesoRevocado(res);
  }
  if (req.actor.tipo === 'central' || req.actor.tipo === 'operativo') {
    return next();
  }
  return sendError(res, {
    status: 403,
    code: 'institutional_actor_required',
    message: 'Se requiere una cuenta institucional para esta operacion.'
  });
}

function requireCentralActor(req, res, next) {
  if (!req.actor) {
    return requireAuthenticatedActor(req, res, next);
  }
  if (actorRevocadoOInactivo(req.actor)) {
    return rechazarAccesoRevocado(res);
  }
  if (req.actor.tipo === 'central') {
    return next();
  }
  return sendError(res, {
    status: 403,
    code: 'central_actor_required',
    message: 'Se requiere un actor de central para esta operacion.'
  });
}

function requireOperativoActor(req, res, next) {
  if (!req.actor) {
    return requireAuthenticatedActor(req, res, next);
  }
  if (actorRevocadoOInactivo(req.actor)) {
    return rechazarAccesoRevocado(res);
  }
  if (req.actor.tipo === 'operativo') {
    return next();
  }
  return sendError(res, {
    status: 403,
    code: 'operativo_actor_required',
    message: 'Se requiere un actor operativo para esta operacion.'
  });
}

function requireUserAdminActor(req, res, next) {
  if (!req.actor) {
    return requireAuthenticatedActor(req, res, next);
  }
  if (actorRevocadoOInactivo(req.actor)) {
    return rechazarAccesoRevocado(res);
  }
  const esCentral = req.actor.tipo === 'central';
  const puedeGestionarUsuarios =
    req.actor.rol === 'jefe' || req.actor.permisos?.usuarios === true;

  if (esCentral && puedeGestionarUsuarios) {
    return next();
  }

  return sendError(res, {
    status: 403,
    code: 'user_admin_actor_required',
    message: 'Se requiere una cuenta con permisos de administracion de usuarios.'
  });
}

module.exports = {
  attachActorContext,
  requireAuthenticatedActor,
  requireInstitutionalActor,
  requireCentralActor,
  requireOperativoActor,
  requireUserAdminActor
};

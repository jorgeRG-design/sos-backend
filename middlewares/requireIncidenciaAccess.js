const pool = require('../config/db');
const { sendError } = require('../utils/apiResponse');

function textoNoVacio(value) {
  const txt = String(value || '').trim();
  return txt || null;
}

async function cargarIncidenciaPorId(id) {
  const result = await pool.query(
    `SELECT id, ticket, estado, alerta_firestore_id, efectivo_asignado_dni
     FROM incidencias
     WHERE id = $1
     LIMIT 1`,
    [id]
  );
  return result.rows[0] || null;
}

async function cargarIncidenciaPorTicket(ticket) {
  const result = await pool.query(
    `SELECT id, ticket, estado, alerta_firestore_id, efectivo_asignado_dni
     FROM incidencias
     WHERE ticket = $1
     LIMIT 1`,
    [ticket]
  );
  return result.rows[0] || null;
}

async function cargarIncidenciaPorAlerta(alertaId) {
  const result = await pool.query(
    `SELECT id, ticket, estado, alerta_firestore_id, efectivo_asignado_dni
     FROM incidencias
     WHERE alerta_firestore_id = $1
     ORDER BY id DESC
     LIMIT 1`,
    [alertaId]
  );
  return result.rows[0] || null;
}

async function operativoAsignadoPorDni(incidenciaId, actorDni) {
  try {
    const result = await pool.query(
      `SELECT 1
       FROM incidencia_efectivos
       WHERE incidencia_id = $1
         AND TRIM(COALESCE(dni::text, '')) = $2
       LIMIT 1`,
      [incidenciaId, actorDni]
    );
    return result.rows.length > 0;
  } catch (error) {
    if (error?.code === '42P01') {
      return false;
    }
    throw error;
  }
}

async function requireIncidenciaAccess(req, res, next) {
  try {
    const incidenciaId = textoNoVacio(req.params.id);
    const ticket = textoNoVacio(req.params.ticket);
    const alertaId = textoNoVacio(req.params.alertaId);

    let incidencia = null;

    if (incidenciaId) {
      incidencia = await cargarIncidenciaPorId(incidenciaId);
    } else if (ticket) {
      incidencia = await cargarIncidenciaPorTicket(decodeURIComponent(ticket));
    } else if (alertaId) {
      incidencia = await cargarIncidenciaPorAlerta(decodeURIComponent(alertaId));
    } else {
      return sendError(res, {
        status: 400,
        code: 'incidencia_reference_required',
        message: 'Se requiere una referencia valida de incidencia.'
      });
    }

    if (!incidencia) {
      return sendError(res, {
        status: 404,
        code: 'incidencia_not_found',
        message: 'Incidencia no encontrada'
      });
    }

    const actor = req.actor;
    if (!actor || (actor.tipo !== 'central' && actor.tipo !== 'operativo')) {
      return sendError(res, {
        status: 403,
        code: 'incidencia_access_forbidden',
        message: 'No tiene acceso a los adjuntos de esta incidencia.'
      });
    }

    if (actor.tipo === 'operativo') {
      const actorDni = textoNoVacio(actor.dni) || textoNoVacio(actor.identificador);
      if (!actorDni) {
        return sendError(res, {
          status: 403,
          code: 'incidencia_assignment_required',
          message: 'No tiene una asignacion valida para acceder a esta incidencia.'
        });
      }

      const asignadoPorTabla = await operativoAsignadoPorDni(
        incidencia.id,
        actorDni
      );
      const asignadoLegacy =
        textoNoVacio(incidencia.efectivo_asignado_dni) === actorDni;

      if (!asignadoPorTabla && !asignadoLegacy) {
        return sendError(res, {
          status: 403,
          code: 'incidencia_assignment_required',
          message: 'No tiene una asignacion valida para acceder a esta incidencia.'
        });
      }
    }

    req.incidenciaAccess = {
      incidenciaId: incidencia.id,
      ticket: textoNoVacio(incidencia.ticket),
      alertaId: textoNoVacio(incidencia.alerta_firestore_id),
      actorTipo: actor.tipo,
      incidencia
    };

    return next();
  } catch (error) {
    console.error('requireIncidenciaAccess', error);
    return sendError(res, {
      status: 500,
      code: 'incidencia_access_resolution_failed',
      message: 'No se pudo validar el acceso a la incidencia.'
    });
  }
}

module.exports = requireIncidenciaAccess;

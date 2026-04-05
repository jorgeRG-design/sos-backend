const admin = require('firebase-admin');

const pool = require('../config/db');
const dbFirestore = require('../config/firebase');

function crearAppError(status, code, message, details) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  if (details) {
    error.details = details;
  }
  return error;
}

function textoNoVacio(value) {
  const txt = String(value || '').trim();
  return txt ? txt : null;
}

function fechaComoDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function extraerUnidadesAsignadas(data = {}) {
  const raw = data.unidades_asignadas;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((value) => textoNoVacio(value))
    .filter(Boolean);
}

async function obtenerAlertaFirestore(alertaId) {
  const alertRef = dbFirestore.collection('alertas').doc(alertaId);
  const alertSnap = await alertRef.get();
  return { alertRef, alertSnap };
}

async function resolverIncidenciaPorAlertaId(client, alertaId) {
  const { alertRef, alertSnap } = await obtenerAlertaFirestore(alertaId);
  let incidenciaQuery = await client.query(
    `SELECT *
     FROM incidencias
     WHERE alerta_firestore_id = $1
     ORDER BY fecha DESC NULLS LAST, fecha_creacion DESC NULLS LAST
     LIMIT 1`,
    [alertaId]
  );

  if (incidenciaQuery.rows.length === 0 && alertSnap.exists) {
    const data = alertSnap.data() || {};
    const ticket = textoNoVacio(data.ticket);
    if (ticket) {
      incidenciaQuery = await client.query(
        `SELECT *
         FROM incidencias
         WHERE ticket = $1
         ORDER BY fecha DESC NULLS LAST, fecha_creacion DESC NULLS LAST
         LIMIT 1`,
        [ticket]
      );
    }
  }

  if (incidenciaQuery.rows.length === 0) {
    throw crearAppError(
      404,
      'incidencia_not_found',
      'No se encontro la incidencia asociada a la alerta.'
    );
  }

  const incidencia = incidenciaQuery.rows[0];
  if (String(incidencia.estado || '').trim().toLowerCase() === 'resuelta') {
    throw crearAppError(
      409,
      'incidencia_closed',
      'La incidencia ya se encuentra cerrada.'
    );
  }

  return {
    incidencia,
    alertRef,
    alertSnap,
    alertaData: alertSnap.exists ? alertSnap.data() || {} : {}
  };
}

async function obtenerOperacionUnidad(client, incidenciaId, unidadId) {
  const result = await client.query(
    `SELECT *
     FROM incidencia_unidades_operacion
     WHERE incidencia_id = $1 AND unidad_id = $2
     LIMIT 1`,
    [incidenciaId, unidadId]
  );
  return result.rows[0] || null;
}

async function upsertOperacionAsignada(
  client,
  incidenciaId,
  unidadId,
  fuenteAsignacion,
  fechaAsignacion,
) {
  const result = await client.query(
    `INSERT INTO incidencia_unidades_operacion (
       incidencia_id,
       unidad_id,
       estado_operacion,
       fuente_asignacion,
       fecha_asignacion,
       actualizado_en
     )
     VALUES ($1, $2, 'asignada', $3, $4, NOW())
     ON CONFLICT (incidencia_id, unidad_id)
     DO UPDATE SET
       estado_operacion = CASE
         WHEN incidencia_unidades_operacion.estado_operacion IN ('en_camino', 'cerrada', 'finalizada')
           THEN incidencia_unidades_operacion.estado_operacion
         ELSE 'asignada'
       END,
       fuente_asignacion = COALESCE(
         incidencia_unidades_operacion.fuente_asignacion,
         EXCLUDED.fuente_asignacion
       ),
       fecha_asignacion = COALESCE(
         incidencia_unidades_operacion.fecha_asignacion,
         EXCLUDED.fecha_asignacion
       ),
       actualizado_en = NOW()
     RETURNING *`,
    [incidenciaId, unidadId, fuenteAsignacion, fechaAsignacion]
  );
  return result.rows[0];
}

async function sincronizarAsignacionFirestore({
  alertRef,
  unidadId
}) {
  await alertRef.set(
    {
      unidades_asignadas: admin.firestore.FieldValue.arrayUnion([unidadId]),
      asignacion_central: true,
      fecha_asignacion: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );
}

async function sincronizarAceptacionFirestore({
  alertRef,
  unidadId,
  fechaAceptacion
}) {
  const payload = {
    estado: 'en_camino',
    unidades_asignadas: admin.firestore.FieldValue.arrayUnion([unidadId])
  };

  const fecha = fechaComoDate(fechaAceptacion);
  payload.hora_aceptacion = fecha
    ? admin.firestore.Timestamp.fromDate(fecha)
    : admin.firestore.FieldValue.serverTimestamp();

  await alertRef.set(payload, { merge: true });
}

async function sincronizarUnidadIntervencion({
  unidadId,
  ticket
}) {
  await dbFirestore.collection('unidades').doc(unidadId).set(
    {
      estado: 'en_intervencion',
      ticket_actual: ticket || null,
      fecha_actualizacion: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );
}

async function sincronizarApoyoFirestore({ alertRef }) {
  await alertRef.set(
    {
      requiere_apoyo: true
    },
    { merge: true }
  );
}

async function asignarUnidadPorAlertaId(alertaId, unidadId, fuenteAsignacion = 'central_mapa') {
  const client = await pool.connect();

  try {
    const contexto = await resolverIncidenciaPorAlertaId(client, alertaId);
    const fechaAsignacion = fechaComoDate(contexto.incidencia.fecha_asignacion) || new Date();

    await client.query('BEGIN');

    const operacion = await upsertOperacionAsignada(
      client,
      contexto.incidencia.id,
      unidadId,
      fuenteAsignacion,
      fechaAsignacion
    );

    await client.query(
      `UPDATE incidencias
       SET asignacion_central = TRUE,
           fecha_asignacion = COALESCE(fecha_asignacion, $2),
           ultima_actualizacion_operativa = NOW(),
           fecha_actualizacion = NOW()
       WHERE id = $1`,
      [contexto.incidencia.id, fechaAsignacion]
    );

    await client.query('COMMIT');

    try {
      await sincronizarAsignacionFirestore({
        alertRef: contexto.alertRef,
        unidadId
      });
    } catch (syncError) {
      throw crearAppError(
        502,
        'operacion_firestore_sync_failed',
        'La asignacion quedo registrada en PostgreSQL, pero Firestore no pudo sincronizarse.',
        syncError.message
      );
    }

    return {
      incidencia_id: contexto.incidencia.id,
      alerta_id: alertaId,
      unidad_id: unidadId,
      estado_operacion: operacion.estado_operacion
    };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

async function aceptarIncidenciaPorAlertaId(alertaId, unidadId) {
  const client = await pool.connect();

  try {
    const contexto = await resolverIncidenciaPorAlertaId(client, alertaId);
    const incidenciaId = contexto.incidencia.id;
    const unidadesAsignadas = extraerUnidadesAsignadas(contexto.alertaData);
    let operacionActual = await obtenerOperacionUnidad(client, incidenciaId, unidadId);

    const unidadAsignada =
      unidadesAsignadas.includes(unidadId) || Boolean(operacionActual);

    if (!unidadAsignada) {
      throw crearAppError(
        409,
        'unidad_not_assigned',
        'La unidad no esta asignada a esta incidencia.'
      );
    }

    if (
      operacionActual &&
      operacionActual.estado_operacion === 'en_camino' &&
      operacionActual.fecha_aceptacion
    ) {
      try {
        await sincronizarAceptacionFirestore({
          alertRef: contexto.alertRef,
          unidadId,
          fechaAceptacion: operacionActual.fecha_aceptacion
        });
        await sincronizarUnidadIntervencion({
          unidadId,
          ticket: contexto.incidencia.ticket
        });
      } catch (syncError) {
        throw crearAppError(
          502,
          'operacion_firestore_sync_failed',
          'La aceptacion ya estaba registrada en PostgreSQL, pero Firestore no pudo sincronizarse.',
          syncError.message
        );
      }

      return {
        incidencia_id: incidenciaId,
        alerta_id: alertaId,
        unidad_id: unidadId,
        estado_operacion: operacionActual.estado_operacion,
        fecha_aceptacion: operacionActual.fecha_aceptacion,
        idempotente: true
      };
    }

    await client.query('BEGIN');

    if (!operacionActual) {
      operacionActual = await upsertOperacionAsignada(
        client,
        incidenciaId,
        unidadId,
        'central_preexistente',
        fechaComoDate(contexto.incidencia.fecha_asignacion) || new Date()
      );
    }

    const aceptacionResult = await client.query(
      `UPDATE incidencia_unidades_operacion
       SET estado_operacion = 'en_camino',
           fecha_aceptacion = COALESCE(fecha_aceptacion, NOW()),
           actualizado_en = NOW()
       WHERE incidencia_id = $1
         AND unidad_id = $2
       RETURNING *`,
      [incidenciaId, unidadId]
    );
    const operacionAceptada = aceptacionResult.rows[0];

    await client.query(
      `UPDATE incidencias
       SET estado = CASE WHEN estado = 'resuelta' THEN estado ELSE 'en_camino' END,
           hora_aceptacion = COALESCE(hora_aceptacion, $2),
           ultima_actualizacion_operativa = NOW(),
           fecha_actualizacion = NOW()
       WHERE id = $1`,
      [incidenciaId, operacionAceptada.fecha_aceptacion]
    );

    await client.query('COMMIT');

    try {
      await sincronizarAceptacionFirestore({
        alertRef: contexto.alertRef,
        unidadId,
        fechaAceptacion: operacionAceptada.fecha_aceptacion
      });
      await sincronizarUnidadIntervencion({
        unidadId,
        ticket: contexto.incidencia.ticket
      });
    } catch (syncError) {
      throw crearAppError(
        502,
        'operacion_firestore_sync_failed',
        'La aceptacion quedo registrada en PostgreSQL, pero Firestore no pudo sincronizarse.',
        syncError.message
      );
    }

    return {
      incidencia_id: incidenciaId,
      alerta_id: alertaId,
      unidad_id: unidadId,
      estado_operacion: operacionAceptada.estado_operacion,
      fecha_aceptacion: operacionAceptada.fecha_aceptacion,
      idempotente: false
    };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

async function solicitarApoyoPorAlertaId(alertaId, unidadId) {
  const client = await pool.connect();

  try {
    const contexto = await resolverIncidenciaPorAlertaId(client, alertaId);
    const incidenciaId = contexto.incidencia.id;
    const unidadesAsignadas = extraerUnidadesAsignadas(contexto.alertaData);
    let operacionActual = await obtenerOperacionUnidad(client, incidenciaId, unidadId);

    const unidadAsignada =
      unidadesAsignadas.includes(unidadId) || Boolean(operacionActual);

    if (!unidadAsignada) {
      throw crearAppError(
        409,
        'unidad_not_assigned',
        'La unidad no esta asignada a esta incidencia.'
      );
    }

    await client.query('BEGIN');

    if (!operacionActual) {
      operacionActual = await upsertOperacionAsignada(
        client,
        incidenciaId,
        unidadId,
        'central_preexistente',
        fechaComoDate(contexto.incidencia.fecha_asignacion) || new Date()
      );
    }

    const apoyoResult = await client.query(
      `UPDATE incidencia_unidades_operacion
       SET requiere_apoyo = TRUE,
           fecha_solicitud_apoyo = COALESCE(fecha_solicitud_apoyo, NOW()),
           actualizado_en = NOW()
       WHERE incidencia_id = $1
         AND unidad_id = $2
       RETURNING *`,
      [incidenciaId, unidadId]
    );
    const operacionApoyo = apoyoResult.rows[0];

    await client.query(
      `UPDATE incidencias
       SET requiere_apoyo = TRUE,
           ultima_actualizacion_operativa = NOW(),
           fecha_actualizacion = NOW()
       WHERE id = $1`,
      [incidenciaId]
    );

    await client.query('COMMIT');

    try {
      await sincronizarApoyoFirestore({ alertRef: contexto.alertRef });
    } catch (syncError) {
      throw crearAppError(
        502,
        'operacion_firestore_sync_failed',
        'La solicitud de apoyo quedo registrada en PostgreSQL, pero Firestore no pudo sincronizarse.',
        syncError.message
      );
    }

    return {
      incidencia_id: incidenciaId,
      alerta_id: alertaId,
      unidad_id: unidadId,
      requiere_apoyo: true,
      fecha_solicitud_apoyo: operacionApoyo.fecha_solicitud_apoyo
    };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  crearAppError,
  resolverIncidenciaPorAlertaId,
  asignarUnidadPorAlertaId,
  aceptarIncidenciaPorAlertaId,
  solicitarApoyoPorAlertaId
};

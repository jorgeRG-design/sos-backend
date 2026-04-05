const { sendOk, sendError } = require('../utils/apiResponse');
const { registrarEventoSeguro } = require('../services/auditoriaService');
const { AUDIT_ACTIONS } = require('../utils/auditCatalog');
const { validarPayloadUnidad } = require('../validators/incidenciaOperacionValidator');
const {
  asignarUnidadPorAlertaId,
  aceptarIncidenciaPorAlertaId,
  solicitarApoyoPorAlertaId
} = require('../services/incidenciaOperacionService');

function enviarErrorOperacion(res, error) {
  const status = Number(error?.status) || 500;
  const message =
    status >= 400 && status < 500
      ? error.message || 'No se pudo procesar la operacion.'
      : 'No se pudo procesar la operacion.';

  return sendError(res, {
    status,
    code: error.code || 'operacion_incidencia_failed',
    message
  });
}

exports.asignarUnidad = async (req, res) => {
  const alertaId = String(req.params.alertaId || '').trim();
  const { errores, unidadId } = validarPayloadUnidad(req.body || {});

  if (!alertaId) {
    await registrarEventoSeguro({
      req,
      accion: AUDIT_ACTIONS.UNIDAD_ASSIGN,
      objetoTipo: 'alerta',
      resultado: 'error',
      detalle: 'Intento de asignacion sin alertaId.'
    });
    return sendError(res, {
      status: 400,
      code: 'missing_alerta_id',
      message: 'La alerta es obligatoria.'
    });
  }

  if (errores.length > 0) {
    await registrarEventoSeguro({
      req,
      accion: AUDIT_ACTIONS.UNIDAD_ASSIGN,
      objetoTipo: 'alerta',
      objetoId: alertaId || null,
      resultado: 'error',
      detalle: errores[0]
    });
    return sendError(res, {
      status: 400,
      code: 'invalid_operacion_payload',
      message: errores[0]
    });
  }

  try {
    const data = await asignarUnidadPorAlertaId(
      alertaId,
      unidadId,
      String(req.body?.fuente_asignacion || 'central_mapa').trim() || 'central_mapa'
    );

    await registrarEventoSeguro({
      req,
      accion: AUDIT_ACTIONS.UNIDAD_ASSIGN,
      objetoTipo: 'incidencia',
      objetoId: String(data.incidencia_id),
      resultado: 'success',
      detalle: `Unidad ${unidadId} asignada a la incidencia.`,
      metadata: {
        alerta_id: alertaId,
        unidad_id: unidadId
      }
    });

    return sendOk(res, {
      message: `Incidencia asignada a la unidad ${unidadId}.`,
      data
    });
  } catch (error) {
    await registrarEventoSeguro({
      req,
      accion: AUDIT_ACTIONS.UNIDAD_ASSIGN,
      objetoTipo: 'alerta',
      objetoId: alertaId || null,
      resultado: 'error',
      detalle: error.message || 'No se pudo asignar la unidad.',
      metadata: {
        unidad_id: unidadId
      }
    });
    return enviarErrorOperacion(res, error);
  }
};

exports.aceptar = async (req, res) => {
  const alertaId = String(req.params.alertaId || '').trim();
  const { errores, unidadId } = validarPayloadUnidad(req.body || {});

  if (!alertaId) {
    await registrarEventoSeguro({
      req,
      accion: AUDIT_ACTIONS.INCIDENCIA_ACCEPT,
      objetoTipo: 'alerta',
      resultado: 'error',
      detalle: 'Intento de aceptacion sin alertaId.'
    });
    return sendError(res, {
      status: 400,
      code: 'missing_alerta_id',
      message: 'La alerta es obligatoria.'
    });
  }

  if (errores.length > 0) {
    await registrarEventoSeguro({
      req,
      accion: AUDIT_ACTIONS.INCIDENCIA_ACCEPT,
      objetoTipo: 'alerta',
      objetoId: alertaId || null,
      resultado: 'error',
      detalle: errores[0]
    });
    return sendError(res, {
      status: 400,
      code: 'invalid_operacion_payload',
      message: errores[0]
    });
  }

  try {
    const data = await aceptarIncidenciaPorAlertaId(alertaId, unidadId);
    const mensaje = data.idempotente
      ? `La unidad ${unidadId} ya habia aceptado esta incidencia.`
      : `La unidad ${unidadId} acepto la incidencia.`;

    await registrarEventoSeguro({
      req,
      accion: AUDIT_ACTIONS.INCIDENCIA_ACCEPT,
      objetoTipo: 'incidencia',
      objetoId: String(data.incidencia_id),
      resultado: 'success',
      detalle: mensaje,
      metadata: {
        alerta_id: alertaId,
        unidad_id: unidadId,
        idempotente: Boolean(data.idempotente)
      }
    });

    return sendOk(res, {
      message: mensaje,
      data
    });
  } catch (error) {
    await registrarEventoSeguro({
      req,
      accion: AUDIT_ACTIONS.INCIDENCIA_ACCEPT,
      objetoTipo: 'alerta',
      objetoId: alertaId || null,
      resultado: 'error',
      detalle: error.message || 'No se pudo aceptar la incidencia.',
      metadata: {
        unidad_id: unidadId
      }
    });
    return enviarErrorOperacion(res, error);
  }
};

exports.solicitarApoyo = async (req, res) => {
  const alertaId = String(req.params.alertaId || '').trim();
  const { errores, unidadId } = validarPayloadUnidad(req.body || {});

  if (!alertaId) {
    await registrarEventoSeguro({
      req,
      accion: AUDIT_ACTIONS.INCIDENCIA_SUPPORT_REQUEST,
      objetoTipo: 'alerta',
      resultado: 'error',
      detalle: 'Intento de solicitud de apoyo sin alertaId.'
    });
    return sendError(res, {
      status: 400,
      code: 'missing_alerta_id',
      message: 'La alerta es obligatoria.'
    });
  }

  if (errores.length > 0) {
    await registrarEventoSeguro({
      req,
      accion: AUDIT_ACTIONS.INCIDENCIA_SUPPORT_REQUEST,
      objetoTipo: 'alerta',
      objetoId: alertaId || null,
      resultado: 'error',
      detalle: errores[0]
    });
    return sendError(res, {
      status: 400,
      code: 'invalid_operacion_payload',
      message: errores[0]
    });
  }

  try {
    const data = await solicitarApoyoPorAlertaId(alertaId, unidadId);
    await registrarEventoSeguro({
      req,
      accion: AUDIT_ACTIONS.INCIDENCIA_SUPPORT_REQUEST,
      objetoTipo: 'incidencia',
      objetoId: String(data.incidencia_id),
      resultado: 'success',
      detalle: `La unidad ${unidadId} solicito apoyo.`,
      metadata: {
        alerta_id: alertaId,
        unidad_id: unidadId,
        fecha_solicitud_apoyo: data.fecha_solicitud_apoyo || null
      }
    });
    return sendOk(res, {
      message: `La unidad ${unidadId} solicito apoyo.`,
      data
    });
  } catch (error) {
    await registrarEventoSeguro({
      req,
      accion: AUDIT_ACTIONS.INCIDENCIA_SUPPORT_REQUEST,
      objetoTipo: 'alerta',
      objetoId: alertaId || null,
      resultado: 'error',
      detalle: error.message || 'No se pudo solicitar apoyo.',
      metadata: {
        unidad_id: unidadId
      }
    });
    return enviarErrorOperacion(res, error);
  }
};

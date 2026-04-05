const { sendOk, sendError } = require('../utils/apiResponse');
const { registrarEventoSeguro } = require('../services/auditoriaService');
const { AUDIT_ACTIONS } = require('../utils/auditCatalog');
const {
  listarUsuarios,
  crearUsuario,
  actualizarUsuario,
  revocarUsuario,
  reactivarUsuario
} = require('../services/adminUsuariosService');
const {
  parseBoolean,
  validarPayloadUsuario
} = require('../validators/adminUsuariosValidator');

function mapError(error, fallbackCode) {
  return {
    status: error.status || 500,
    code: error.code || fallbackCode,
    message: error.status && error.status < 500
      ? error.message
      : 'Error interno del servidor'
  };
}

exports.listarUsuarios = async (req, res) => {
  const includeRevocados = parseBoolean(req.query?.include_revocados, false);

  try {
    const data = await listarUsuarios({ includeRevocados });
    return sendOk(res, { data });
  } catch (error) {
    return sendError(res, mapError(error, 'admin_user_list_failed'));
  }
};

exports.crearUsuario = async (req, res) => {
  const { errores, data } = validarPayloadUsuario(req.body || {}, {
    requirePassword: true
  });

  if (errores.length > 0) {
    await registrarEventoSeguro({
      req,
      accion: AUDIT_ACTIONS.ADMIN_USER_CREATE,
      objetoTipo: 'usuario',
      resultado: 'error',
      detalle: 'Payload invalido para crear usuario institucional.',
      metadata: { errores }
    });
    return sendError(res, {
      status: 400,
      code: 'invalid_admin_user_payload',
      message: errores[0]
    });
  }

  try {
    const usuario = await crearUsuario(data, req.actor);
    await registrarEventoSeguro({
      req,
      accion: AUDIT_ACTIONS.ADMIN_USER_CREATE,
      objetoTipo: 'usuario',
      objetoId: usuario.correo,
      resultado: 'success',
      detalle: 'Nuevo usuario institucional creado.',
      metadata: {
        rol: usuario.rol,
        dependencia: usuario.dependencia
      }
    });
    return sendOk(res, {
      status: 201,
      message: 'Usuario institucional creado correctamente.',
      data: usuario
    });
  } catch (error) {
    await registrarEventoSeguro({
      req,
      accion: AUDIT_ACTIONS.ADMIN_USER_CREATE,
      objetoTipo: 'usuario',
      objetoId: data.correo,
      resultado: 'error',
      detalle: error.message || 'No se pudo crear el usuario institucional.',
      metadata: {
        rol: data.rol,
        dependencia: data.dependencia
      }
    });
    return sendError(res, mapError(error, 'admin_user_create_failed'));
  }
};

exports.actualizarUsuario = async (req, res) => {
  const correo = String(req.params.correo || '').trim().toLowerCase();
  if (!correo) {
    return sendError(res, {
      status: 400,
      code: 'admin_user_email_required',
      message: 'El correo del usuario es obligatorio.'
    });
  }

  const { errores, data } = validarPayloadUsuario(req.body || {}, {
    requirePassword: false
  });

  const correoBody = String(req.body?.correo || '').trim().toLowerCase();
  if (correoBody && correoBody !== correo) {
    errores.push('El correo del payload no coincide con la ruta.');
  }

  if (errores.length > 0) {
    await registrarEventoSeguro({
      req,
      accion: AUDIT_ACTIONS.ADMIN_USER_UPDATE,
      objetoTipo: 'usuario',
      objetoId: correo,
      resultado: 'error',
      detalle: 'Payload invalido para actualizar usuario institucional.',
      metadata: { errores }
    });
    return sendError(res, {
      status: 400,
      code: 'invalid_admin_user_payload',
      message: errores[0]
    });
  }

  try {
    const usuario = await actualizarUsuario(correo, data, req.actor);
    await registrarEventoSeguro({
      req,
      accion: AUDIT_ACTIONS.ADMIN_USER_UPDATE,
      objetoTipo: 'usuario',
      objetoId: correo,
      resultado: 'success',
      detalle: 'Usuario institucional actualizado.',
      metadata: {
        rol: usuario.rol,
        dependencia: usuario.dependencia
      }
    });
    return sendOk(res, {
      message: 'Usuario institucional actualizado correctamente.',
      data: usuario
    });
  } catch (error) {
    await registrarEventoSeguro({
      req,
      accion: AUDIT_ACTIONS.ADMIN_USER_UPDATE,
      objetoTipo: 'usuario',
      objetoId: correo,
      resultado: 'error',
      detalle: error.message || 'No se pudo actualizar el usuario institucional.',
      metadata: {
        rol: data.rol,
        dependencia: data.dependencia
      }
    });
    return sendError(res, mapError(error, 'admin_user_update_failed'));
  }
};

exports.revocarUsuario = async (req, res) => {
  const correo = String(req.params.correo || '').trim().toLowerCase();
  if (!correo) {
    return sendError(res, {
      status: 400,
      code: 'admin_user_email_required',
      message: 'El correo del usuario es obligatorio.'
    });
  }

  try {
    const usuario = await revocarUsuario(correo, req.actor);
    await registrarEventoSeguro({
      req,
      accion: AUDIT_ACTIONS.ADMIN_USER_REVOKE,
      objetoTipo: 'usuario',
      objetoId: correo,
      resultado: 'success',
      detalle: 'Acceso institucional revocado.',
      metadata: {
        estado_acceso: usuario.estado_acceso,
        revocado_por: usuario.revocado_por
      }
    });
    return sendOk(res, {
      message: 'Acceso institucional revocado correctamente.',
      data: usuario
    });
  } catch (error) {
    await registrarEventoSeguro({
      req,
      accion: AUDIT_ACTIONS.ADMIN_USER_REVOKE,
      objetoTipo: 'usuario',
      objetoId: correo,
      resultado: 'error',
      detalle: error.message || 'No se pudo revocar el acceso institucional.'
    });
    return sendError(res, mapError(error, 'admin_user_revoke_failed'));
  }
};

exports.reactivarUsuario = async (req, res) => {
  const correo = String(req.params.correo || '').trim().toLowerCase();
  if (!correo) {
    return sendError(res, {
      status: 400,
      code: 'admin_user_email_required',
      message: 'El correo del usuario es obligatorio.'
    });
  }

  try {
    const usuario = await reactivarUsuario(correo, req.actor);
    await registrarEventoSeguro({
      req,
      accion: AUDIT_ACTIONS.ADMIN_USER_REACTIVATE,
      objetoTipo: 'usuario',
      objetoId: correo,
      resultado: 'success',
      detalle: 'Acceso institucional reactivado.',
      metadata: {
        estado_acceso: usuario.estado_acceso,
        reactivado_por: usuario.reactivado_por,
        fecha_reactivacion: usuario.fecha_reactivacion
      }
    });
    return sendOk(res, {
      message: 'Acceso institucional reactivado correctamente.',
      data: usuario
    });
  } catch (error) {
    await registrarEventoSeguro({
      req,
      accion: AUDIT_ACTIONS.ADMIN_USER_REACTIVATE,
      objetoTipo: 'usuario',
      objetoId: correo,
      resultado: 'error',
      detalle: error.message || 'No se pudo reactivar el acceso institucional.'
    });
    return sendError(res, mapError(error, 'admin_user_reactivate_failed'));
  }
};

const verificationCodeService = require('../services/verificationCodeService');
const { sendOk, sendError } = require('../utils/apiResponse');
const {
  validarEnvioCodigo,
  validarVerificacionCodigo
} = require('../validators/verificationValidator');

exports.enviarCodigo = async (req, res) => {
  try {
    const erroresValidacion = validarEnvioCodigo(req.body || {});
    if (erroresValidacion.length > 0) {
      return sendError(res, {
        status: 400,
        code: 'invalid_verification_payload',
        message: erroresValidacion[0]
      });
    }

    const { purpose, channel, target, metadata } = req.body || {};
    const result = await verificationCodeService.enviarCodigo({
      purpose,
      channel,
      target,
      metadata,
      actor: req.actor,
      actorAuthError: req.actorAuthError,
    });

    const data = {
      delivery: result.delivery,
      expires_in_minutes: result.expiresInMinutes,
      ...(result.debugCode ? { debug_code: result.debugCode } : {}),
    };

    return sendOk(res, {
      message: 'Codigo enviado correctamente.',
      data,
      legacy: data
    });
  } catch (error) {
    const status = Number(error?.statusCode) || 500;
    if (status === 429 && Number(error?.retryAfterSeconds) > 0) {
      res.set('Retry-After', String(Number(error.retryAfterSeconds)));
    }
    return sendError(res, {
      status,
      code:
        status >= 400 && status < 500
          ? String(
              error?.errorCode ||
                (status === 429
                  ? 'verification_send_cooldown_active'
                  : 'verification_send_failed')
            )
          : 'verification_send_failed',
      message:
        status >= 400 && status < 500
          ? error.message || 'No se pudo enviar el codigo.'
          : 'No se pudo enviar el codigo.'
    });
  }
};

exports.verificarCodigo = async (req, res) => {
  try {
    const erroresValidacion = validarVerificacionCodigo(req.body || {});
    if (erroresValidacion.length > 0) {
      return sendError(res, {
        status: 400,
        code: 'invalid_verification_payload',
        message: erroresValidacion[0]
      });
    }

    const { purpose, channel, target, code } = req.body || {};
    const result = await verificationCodeService.verificarCodigo({
      purpose,
      channel,
      target,
      code,
      ip: req.ip,
      actor: req.actor,
      actorAuthError: req.actorAuthError,
    });

    if (!result.ok) {
      return sendError(res, {
        status: 400,
        code: 'verification_code_invalid',
        message: 'Codigo invalido o vencido.',
      });
    }

    return sendOk(res, {
      message: 'Codigo verificado correctamente.',
      data: { verified: true }
    });
  } catch (error) {
    const status = Number(error?.statusCode) || 500;
    if (status === 429 && Number(error?.retryAfterSeconds) > 0) {
      res.set('Retry-After', String(Number(error.retryAfterSeconds)));
    }
    return sendError(res, {
      status,
      code:
        status >= 400 && status < 500
          ? String(
              error?.errorCode ||
                (status === 429
                  ? 'verification_verify_rate_limited'
                  : 'verification_check_failed')
            )
          : 'verification_check_failed',
      message:
        status >= 400 && status < 500
          ? error.message || 'No se pudo verificar el codigo.'
          : 'No se pudo verificar el codigo.'
    });
  }
};

const { sendError } = require('../utils/apiResponse');

const DEBUG_FALLBACK_SENTINEL = 'DEBUG-LOCAL-ONLY-NEVER-DEPLOY';

const apiKeyMiddleware = (req, res, next) => {
  const expectedApiKey = String(process.env.API_KEY || '').trim();
  if (!expectedApiKey) {
    return sendError(res, {
      status: 500,
      code: 'api_key_missing',
      message: 'API_KEY del servidor no configurada.'
    });
  }

  const apiKey = String(req.headers['x-api-key'] || '').trim();

  if (
    process.env.NODE_ENV === 'production' &&
    apiKey === DEBUG_FALLBACK_SENTINEL
  ) {
    console.warn(
      '[auth] rechazo: se intento usar la API key de debug contra produccion',
      { ip: req.ip, path: req.path, ua: req.headers['user-agent'] }
    );
    return sendError(res, {
      status: 403,
      code: 'debug_key_forbidden_in_production',
      message: 'La API key de desarrollo no puede usarse en produccion.'
    });
  }

  if (!apiKey || apiKey !== expectedApiKey) {
    return sendError(res, {
      status: 401,
      code: 'invalid_api_key',
      message: 'Acceso denegado. API Key invalida.'
    });
  }

  next();
};

module.exports = apiKeyMiddleware;

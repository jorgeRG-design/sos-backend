const { sendError } = require('../utils/apiResponse');

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

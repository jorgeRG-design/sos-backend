function sendOk(
  res,
  {
    status = 200,
    message = null,
    data = undefined,
    meta = undefined,
    legacy = {}
  } = {}
) {
  const payload = { ok: true };
  if (message) payload.message = message;
  if (data !== undefined) payload.data = data;
  if (meta !== undefined) payload.meta = meta;
  return res.status(status).json({ ...payload, ...legacy });
}

function sendError(
  res,
  {
    status = 500,
    code = 'internal_error',
    message = 'Error interno del servidor'
  } = {}
) {
  return res.status(status).json({
    ok: false,
    error: message,
    code
  });
}

module.exports = {
  sendOk,
  sendError
};

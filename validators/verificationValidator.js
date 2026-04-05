function textoNoVacio(value) {
  if (value == null) return '';
  return String(value).trim();
}

function validarCamposBase({ purpose, channel, target }) {
  const errores = [];
  if (!textoNoVacio(purpose)) {
    errores.push('El purpose es obligatorio.');
  }
  if (!textoNoVacio(channel)) {
    errores.push('El channel es obligatorio.');
  }
  if (!textoNoVacio(target)) {
    errores.push('El target es obligatorio.');
  }
  return errores;
}

function validarEnvioCodigo(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return ['El cuerpo de la solicitud es invalido.'];
  }
  return validarCamposBase(body);
}

function validarVerificacionCodigo(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return ['El cuerpo de la solicitud es invalido.'];
  }
  const errores = validarCamposBase(body);
  if (!textoNoVacio(body.code)) {
    errores.push('El codigo es obligatorio.');
  }
  return errores;
}

module.exports = {
  validarEnvioCodigo,
  validarVerificacionCodigo
};

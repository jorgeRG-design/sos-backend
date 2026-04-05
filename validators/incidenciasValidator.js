function textoNoVacio(value) {
  if (value == null) return '';
  return String(value).trim();
}

function numeroFinito(value) {
  if (value == null) return false;
  const parsed = Number(value);
  return Number.isFinite(parsed);
}

function validarCreacionIncidencia(body = {}) {
  const errores = [];

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return ['El cuerpo de la solicitud es invalido.'];
  }

  if (!textoNoVacio(body.fuente)) {
    errores.push('La fuente es obligatoria.');
  }
  if (!textoNoVacio(body.origen)) {
    errores.push('El origen es obligatorio.');
  }
  if (
    !textoNoVacio(body.tipologia_tipo) &&
    !textoNoVacio(body.tipificacion) &&
    !textoNoVacio(body.tipo)
  ) {
    errores.push('Se requiere al menos un tipo o tipificacion de incidencia.');
  }
  if (!numeroFinito(body.latitud) || !numeroFinito(body.longitud)) {
    errores.push('La latitud y la longitud son obligatorias y deben ser numericas.');
  }

  return errores;
}

function validarCierreIncidencia(body = {}) {
  const errores = [];

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return ['El cuerpo de la solicitud es invalido.'];
  }

  if (!textoNoVacio(body.ticket)) {
    errores.push('El ticket es obligatorio.');
  }
  if (body.involucrados != null && !Array.isArray(body.involucrados)) {
    errores.push('El campo involucrados debe ser un arreglo.');
  }
  if (body.apoyo_pnp != null && !Array.isArray(body.apoyo_pnp)) {
    errores.push('El campo apoyo_pnp debe ser un arreglo.');
  }

  return errores;
}

module.exports = {
  validarCreacionIncidencia,
  validarCierreIncidencia
};

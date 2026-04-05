function validarImportacionGps(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return ['El cuerpo de la solicitud es invalido.'];
  }

  const { registros } = body;
  if (!Array.isArray(registros) || registros.length === 0) {
    return ['Formato de datos invalido: no se recibieron registros.'];
  }

  const hayRegistroInvalido = registros.some(
    (item) => item == null || typeof item !== 'object' || Array.isArray(item)
  );
  if (hayRegistroInvalido) {
    return ['Cada registro GPS debe ser un objeto valido.'];
  }

  return [];
}

module.exports = {
  validarImportacionGps
};

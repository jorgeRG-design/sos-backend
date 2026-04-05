function validarUnidadId(unidadId) {
  const txt = String(unidadId || '').trim();
  return txt.length > 0 ? txt : null;
}

function validarPayloadUnidad(body = {}) {
  const unidadId = validarUnidadId(body.unidad_id);
  if (!unidadId) {
    return {
      errores: ['La unidad es obligatoria.'],
      unidadId: null
    };
  }

  return {
    errores: [],
    unidadId
  };
}

module.exports = {
  validarPayloadUnidad
};

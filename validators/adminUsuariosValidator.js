const ROLES_PERMITIDOS = new Set(['operador', 'supervisor', 'jefe']);

function texto(value) {
  return String(value || '').trim();
}

function parseBoolean(value, defaultValue = false) {
  if (value === true || value === false) {
    return value;
  }
  if (value == null) {
    return defaultValue;
  }
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

function validarDni(dni) {
  return /^\d{8}$/.test(texto(dni));
}

function validarCorreoInstitucional(correo) {
  const normalized = texto(correo).toLowerCase();
  return /^[a-z0-9._%+-]+@santaanita\.gob\.pe$/.test(normalized);
}

function validarCelular(celular) {
  const normalized = texto(celular);
  if (!normalized) {
    return true;
  }
  return /^\d{9}$/.test(normalized);
}

function permisosNormalizados(permisos = {}) {
  const raw = permisos && typeof permisos === 'object' && !Array.isArray(permisos)
    ? permisos
    : {};

  const personalOperativo = parseBoolean(
    raw.personal_operativo,
    parseBoolean(raw.alta, false)
  );
  const personalAdministrativo = parseBoolean(
    raw.personal_administrativo,
    parseBoolean(raw.usuarios, false)
  );
  const videovigilancia = parseBoolean(raw.videovigilancia, false);

  return {
    mapa: parseBoolean(raw.mapa, true),
    directorio: parseBoolean(raw.directorio, true),
    estadisticas: parseBoolean(raw.estadisticas, false),
    incidencias: parseBoolean(raw.incidencias, true),
    videovigilancia,
    personal_operativo: personalOperativo,
    personal_administrativo: personalAdministrativo,
    alta: personalOperativo,
    usuarios: personalAdministrativo,
    historial: false
  };
}

function validarPayloadUsuario(body = {}, { requirePassword = false } = {}) {
  const errores = [];

  const dni = texto(body.dni);
  const nombres = texto(body.nombres);
  const celular = texto(body.celular);
  const rol = texto(body.rol).toLowerCase() || 'operador';
  const dependencia = texto(body.dependencia);
  const password = texto(body.password);
  const correoCalculado = `${dni}@santaanita.gob.pe`.toLowerCase();
  const correoIngresado = texto(body.correo).toLowerCase();
  const correo = correoIngresado || correoCalculado;

  if (!validarDni(dni)) {
    errores.push('El DNI debe tener 8 digitos.');
  }
  if (!nombres) {
    errores.push('Los nombres son obligatorios.');
  }
  if (!validarCelular(celular)) {
    errores.push('El celular debe tener 9 digitos.');
  }
  if (!ROLES_PERMITIDOS.has(rol)) {
    errores.push('El rol no es valido.');
  }
  if (!dependencia) {
    errores.push('La dependencia es obligatoria.');
  }
  if (!validarCorreoInstitucional(correo)) {
    errores.push('El correo institucional no es valido.');
  }
  if (correoIngresado && correoIngresado !== correoCalculado) {
    errores.push('El correo institucional debe corresponder al DNI.');
  }
  if (requirePassword && password.length < 6) {
    errores.push('La contrasena temporal debe tener al menos 6 caracteres.');
  }

  return {
    errores,
    data: {
      dni,
      nombres,
      celular: celular || null,
      rol,
      dependencia,
      correo,
      password: password || null,
      permisos: permisosNormalizados(body.permisos)
    }
  };
}

module.exports = {
  parseBoolean,
  validarPayloadUsuario
};

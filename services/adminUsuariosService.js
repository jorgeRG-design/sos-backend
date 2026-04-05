const admin = require('firebase-admin');

const dbFirestore = require('../config/firebase');

function texto(value) {
  const txt = String(value || '').trim();
  return txt || null;
}

function booleano(value, defaultValue = false) {
  return value === undefined ? defaultValue : value === true;
}

function normalizarFecha(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') {
    try {
      return value.toDate().toISOString();
    } catch (_) {
      return null;
    }
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return texto(value);
}

function esAreaExterna(dependencia) {
  return dependencia !== 'Observatorio' && dependencia !== 'Serenazgo';
}

function normalizarPermisos(permisos = {}, dependencia) {
  const externa = esAreaExterna(dependencia);
  const personalOperativo = externa
    ? false
    : booleano(permisos.personal_operativo, booleano(permisos.alta, false));
  const personalAdministrativo = externa
    ? false
    : booleano(permisos.personal_administrativo, booleano(permisos.usuarios, false));
  const videovigilancia = externa
    ? false
    : ('videovigilancia' in permisos
      ? booleano(permisos.videovigilancia, false)
      : dependencia === 'Observatorio');

  return {
    mapa: externa ? false : booleano(permisos.mapa, true),
    directorio: externa ? false : booleano(permisos.directorio, true),
    estadisticas: externa ? false : booleano(permisos.estadisticas, false),
    incidencias: externa ? true : booleano(permisos.incidencias, true),
    videovigilancia,
    personal_operativo: personalOperativo,
    personal_administrativo: personalAdministrativo,
    alta: personalOperativo,
    usuarios: personalAdministrativo,
    historial: false
  };
}

function usuarioDesdeDoc(docSnap) {
  const data = docSnap.data() || {};
  const dependencia = texto(data.dependencia) || 'Observatorio';
  return {
    correo: docSnap.id,
    uid: texto(data.uid),
    dni: texto(data.dni),
    nombres: texto(data.nombres),
    celular: texto(data.celular),
    rol: texto(data.rol) || 'operador',
    dependencia,
    permisos: normalizarPermisos(
      data.permisos && typeof data.permisos === 'object' && !Array.isArray(data.permisos)
        ? data.permisos
        : {},
      dependencia
    ),
    activo: data.activo !== false,
    estado_acceso: texto(data.estado_acceso) || 'activo',
    fecha_creacion: normalizarFecha(data.fecha_creacion),
    fecha_actualizacion: normalizarFecha(data.fecha_actualizacion),
    fecha_revocacion: normalizarFecha(data.fecha_revocacion),
    fecha_reactivacion: normalizarFecha(data.fecha_reactivacion),
    creado_por: texto(data.creado_por),
    actualizado_por: texto(data.actualizado_por),
    revocado_por: texto(data.revocado_por),
    reactivado_por: texto(data.reactivado_por)
  };
}

function actorIdentificador(actor) {
  return (
    texto(actor?.identificador) ||
    texto(actor?.email) ||
    texto(actor?.uid) ||
    'sistema'
  );
}

async function obtenerDocUsuario(correo) {
  return dbFirestore.collection('usuarios_central').doc(correo).get();
}

async function listarUsuarios({ includeRevocados = false } = {}) {
  const snap = await dbFirestore.collection('usuarios_central').get();
  const usuarios = snap.docs
    .map(usuarioDesdeDoc)
    .filter((usuario) => includeRevocados || usuario.activo !== false)
    .sort((a, b) => {
      const nombreA = `${a.nombres || ''} ${a.correo || ''}`.trim().toLowerCase();
      const nombreB = `${b.nombres || ''} ${b.correo || ''}`.trim().toLowerCase();
      return nombreA.localeCompare(nombreB, 'es');
    });

  return {
    usuarios,
    total: usuarios.length,
    include_revocados: includeRevocados
  };
}

async function crearUsuario(payload, actor) {
  const correo = String(payload.correo).trim().toLowerCase();
  const docRef = dbFirestore.collection('usuarios_central').doc(correo);
  const existente = await docRef.get();
  if (existente.exists && existente.data()?.activo !== false) {
    const error = new Error('Ya existe un usuario institucional con ese correo.');
    error.status = 409;
    error.code = 'admin_user_already_exists';
    throw error;
  }

  let authUser = null;
  try {
    authUser = await admin.auth().createUser({
      email: correo,
      password: payload.password,
      displayName: payload.nombres,
      disabled: false
    });

    const ahora = admin.firestore.FieldValue.serverTimestamp();
    await docRef.set({
      uid: authUser.uid,
      dni: payload.dni,
      nombres: payload.nombres.toUpperCase(),
      celular: payload.celular,
      rol: payload.rol,
      dependencia: payload.dependencia,
      permisos: normalizarPermisos(payload.permisos, payload.dependencia),
      activo: true,
      estado_acceso: 'activo',
      fecha_creacion: ahora,
      fecha_actualizacion: ahora,
      creado_por: actorIdentificador(actor),
      actualizado_por: actorIdentificador(actor),
      fecha_revocacion: null,
      revocado_por: null
    }, { merge: true });

    const finalSnap = await docRef.get();
    return usuarioDesdeDoc(finalSnap);
  } catch (error) {
    if (authUser?.uid) {
      try {
        await admin.auth().deleteUser(authUser.uid);
      } catch (compensationError) {
        console.error(
          '[admin-user] Fallo la compensacion tras error al crear usuario:',
          compensationError
        );
      }
    }
    if (error.code === 'auth/email-already-exists') {
      error.status = 409;
      error.code = 'admin_user_auth_email_exists';
      error.message = 'Ya existe una cuenta de autenticacion con ese correo.';
    }
    throw error;
  }
}

async function actualizarUsuario(correo, payload, actor) {
  const docRef = dbFirestore.collection('usuarios_central').doc(correo);
  const actualSnap = await docRef.get();
  if (!actualSnap.exists) {
    const error = new Error('Usuario institucional no encontrado.');
    error.status = 404;
    error.code = 'admin_user_not_found';
    throw error;
  }

  const actual = usuarioDesdeDoc(actualSnap);
  if (actual.activo === false || actual.estado_acceso === 'revocado') {
    const error = new Error('No se puede actualizar un usuario revocado.');
    error.status = 409;
    error.code = 'admin_user_revoked';
    throw error;
  }

  if (actual.uid) {
    await admin.auth().updateUser(actual.uid, {
      displayName: payload.nombres,
      disabled: false
    });
  }

  await docRef.set({
    dni: payload.dni,
    nombres: payload.nombres.toUpperCase(),
    celular: payload.celular,
    rol: payload.rol,
    dependencia: payload.dependencia,
    permisos: normalizarPermisos(payload.permisos, payload.dependencia),
    activo: true,
    estado_acceso: 'activo',
    fecha_actualizacion: admin.firestore.FieldValue.serverTimestamp(),
    actualizado_por: actorIdentificador(actor)
  }, { merge: true });

  const finalSnap = await docRef.get();
  return usuarioDesdeDoc(finalSnap);
}

async function revocarUsuario(correo, actor) {
  const docRef = dbFirestore.collection('usuarios_central').doc(correo);
  const actualSnap = await docRef.get();
  if (!actualSnap.exists) {
    const error = new Error('Usuario institucional no encontrado.');
    error.status = 404;
    error.code = 'admin_user_not_found';
    throw error;
  }

  const actual = usuarioDesdeDoc(actualSnap);

  if (actual.uid) {
    await admin.auth().updateUser(actual.uid, {
      disabled: true
    });
  } else {
    try {
      const authUser = await admin.auth().getUserByEmail(correo);
      await admin.auth().updateUser(authUser.uid, { disabled: true });
    } catch (error) {
      if (error.code !== 'auth/user-not-found') {
        throw error;
      }
    }
  }

  await docRef.set({
    activo: false,
    estado_acceso: 'revocado',
    fecha_revocacion: admin.firestore.FieldValue.serverTimestamp(),
    revocado_por: actorIdentificador(actor),
    fecha_actualizacion: admin.firestore.FieldValue.serverTimestamp(),
    actualizado_por: actorIdentificador(actor)
  }, { merge: true });

  const finalSnap = await docRef.get();
  return usuarioDesdeDoc(finalSnap);
}

async function reactivarUsuario(correo, actor) {
  const docRef = dbFirestore.collection('usuarios_central').doc(correo);
  const actualSnap = await docRef.get();
  if (!actualSnap.exists) {
    const error = new Error('Usuario institucional no encontrado.');
    error.status = 404;
    error.code = 'admin_user_not_found';
    throw error;
  }

  const actual = usuarioDesdeDoc(actualSnap);
  if (actual.activo !== false && actual.estado_acceso !== 'revocado') {
    const error = new Error('El usuario ya se encuentra activo.');
    error.status = 409;
    error.code = 'admin_user_already_active';
    throw error;
  }

  if (actual.uid) {
    await admin.auth().updateUser(actual.uid, {
      disabled: false
    });
  } else {
    try {
      const authUser = await admin.auth().getUserByEmail(correo);
      await admin.auth().updateUser(authUser.uid, { disabled: false });
    } catch (error) {
      if (error.code === 'auth/user-not-found') {
        const authError = new Error(
          'No existe una cuenta de autenticacion asociada a este usuario.'
        );
        authError.status = 409;
        authError.code = 'admin_user_auth_not_found';
        throw authError;
      }
      throw error;
    }
  }

  await docRef.set({
    activo: true,
    estado_acceso: 'activo',
    fecha_reactivacion: admin.firestore.FieldValue.serverTimestamp(),
    reactivado_por: actorIdentificador(actor),
    fecha_actualizacion: admin.firestore.FieldValue.serverTimestamp(),
    actualizado_por: actorIdentificador(actor)
  }, { merge: true });

  const finalSnap = await docRef.get();
  return usuarioDesdeDoc(finalSnap);
}

module.exports = {
  listarUsuarios,
  crearUsuario,
  actualizarUsuario,
  revocarUsuario,
  reactivarUsuario
};

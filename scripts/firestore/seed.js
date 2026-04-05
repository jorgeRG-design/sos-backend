const path = require('path');
const admin = require('firebase-admin');

require('dotenv').config({
  path: path.resolve(__dirname, '..', '..', '.env'),
});

const db = require(path.resolve(__dirname, '..', '..', 'config', 'firebase.js'));

function text(value) {
  const trimmed = String(value || '').trim();
  return trimmed || null;
}

function normalizePermisos(dependencia, role = 'operador') {
  const isObservatorio = dependencia === 'Observatorio';
  const isSerenazgo = dependencia === 'Serenazgo';
  const isJefe = role === 'jefe';

  return {
    mapa: isObservatorio || isSerenazgo,
    directorio: isObservatorio || isSerenazgo,
    estadisticas: isObservatorio,
    incidencias: true,
    videovigilancia: isObservatorio,
    personal_operativo: isSerenazgo && isJefe,
    personal_administrativo: isObservatorio && isJefe,
    alta: isSerenazgo && isJefe,
    usuarios: isObservatorio && isJefe,
    historial: false,
  };
}

async function ensureAuthUser({ email, password, displayName }) {
  if (!email) {
    return null;
  }

  try {
    const existing = await admin.auth().getUserByEmail(email);
    if (displayName) {
      await admin.auth().updateUser(existing.uid, {
        displayName,
        disabled: false,
      });
    }
    return existing.uid;
  } catch (error) {
    if (error.code !== 'auth/user-not-found') {
      throw error;
    }
  }

  if (!password) {
    return null;
  }

  const created = await admin.auth().createUser({
    email,
    password,
    displayName: displayName || undefined,
    disabled: false,
  });
  return created.uid;
}

async function seedInstitutionalProfile(prefix, defaults) {
  const email = text(process.env[`${prefix}_EMAIL`]);
  if (!email) {
    return null;
  }

  const password = text(process.env[`${prefix}_PASSWORD`]);
  const dni = text(process.env[`${prefix}_DNI`]);
  const nombres = text(process.env[`${prefix}_NOMBRES`]) || defaults.nombres;
  const celular = text(process.env[`${prefix}_CELULAR`]);
  const rol = text(process.env[`${prefix}_ROL`]) || defaults.rol;
  const dependencia = text(process.env[`${prefix}_DEPENDENCIA`]) || defaults.dependencia;

  const uid = await ensureAuthUser({
    email,
    password,
    displayName: nombres,
  });

  const docRef = db.collection('usuarios_central').doc(email.toLowerCase());
  await docRef.set(
    {
      uid: uid || null,
      dni,
      nombres: nombres ? nombres.toUpperCase() : null,
      celular,
      rol,
      dependencia,
      permisos: normalizePermisos(dependencia, rol),
      activo: true,
      estado_acceso: 'activo',
      fecha_creacion: admin.firestore.FieldValue.serverTimestamp(),
      fecha_actualizacion: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  if (dependencia === 'Serenazgo' && dni) {
    await db.collection('unidades').doc(dni).set(
      {
        codigo: dni,
        alias: nombres || dni,
        estado: 'patrullando',
        dependencia: 'Serenazgo',
        fecha_actualizacion: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }

  return {
    tipo: 'institucional',
    email: email.toLowerCase(),
    uid: uid || null,
    dependencia,
    dni,
  };
}

async function seedCitizenProfile() {
  const dni = text(process.env.DEMO_CIUDADANO_DNI);
  if (!dni) {
    return null;
  }

  const password = text(process.env.DEMO_CIUDADANO_PASSWORD);
  const nombre = text(process.env.DEMO_CIUDADANO_NOMBRE) || 'CIUDADANO DEMO';
  const telefono = text(process.env.DEMO_CIUDADANO_TELEFONO);
  const email = `${dni}@ciudadano.sos`;

  const uid = await ensureAuthUser({
    email,
    password,
    displayName: nombre,
  });

  await db.collection('ciudadanos').doc(dni).set(
    {
      uid: uid || null,
      numero_doc: dni,
      nombre,
      telefono,
      accepted_privacy_policy: true,
      accepted_privacy_policy_at: admin.firestore.FieldValue.serverTimestamp(),
      privacy_policy_version: text(process.env.DEMO_PRIVACY_POLICY_VERSION) || 'v1',
      fecha_actualizacion: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return {
    tipo: 'ciudadano',
    email,
    uid: uid || null,
    dni,
  };
}

async function main() {
  const seeded = [];

  const central = await seedInstitutionalProfile('DEMO_CENTRAL', {
    nombres: 'USUARIO CENTRAL DEMO',
    rol: 'jefe',
    dependencia: 'Observatorio',
  });
  if (central) seeded.push(central);

  const operativo = await seedInstitutionalProfile('DEMO_OPERATIVO', {
    nombres: 'USUARIO OPERATIVO DEMO',
    rol: 'operativo',
    dependencia: 'Serenazgo',
  });
  if (operativo) seeded.push(operativo);

  const ciudadano = await seedCitizenProfile();
  if (ciudadano) seeded.push(ciudadano);

  if (!seeded.length) {
    process.stdout.write(
      `${JSON.stringify({
        success: true,
        seeded: [],
        warnings: [
          'No se encontraron variables DEMO_* configuradas. No se genero data demo en Firestore.',
        ],
      })}\n`
    );
    return;
  }

  process.stdout.write(
    `${JSON.stringify({
      success: true,
      seeded,
    })}\n`
  );
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      success: false,
      error: {
        message: error.message,
        code: error.code || null,
      },
    })}\n`
  );
  process.exit(1);
});


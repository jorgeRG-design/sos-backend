const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

function esProduccion() {
  return String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
}

function permitirFallbackLocal() {
  if (!esProduccion()) {
    return true;
  }
  return String(process.env.FIREBASE_ALLOW_LOCAL_FILE_FALLBACK || '').trim().toLowerCase() === 'true';
}

function cargarCredencialDesdeEntorno() {
  const rawJson = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  if (rawJson) {
    return JSON.parse(rawJson);
  }

  const credentialsPath = String(
    process.env.GOOGLE_APPLICATION_CREDENTIALS || ''
  ).trim();
  if (!credentialsPath) {
    return null;
  }

  const resolvedPath = path.resolve(credentialsPath);
  return JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
}

function cargarCredencialLocal() {
  if (!permitirFallbackLocal()) {
    return null;
  }

  const fallbackPath = path.resolve(__dirname, '..', 'firebase-key.json');
  if (!fs.existsSync(fallbackPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(fallbackPath, 'utf8'));
}

function resolverServiceAccount() {
  const fromEnv = cargarCredencialDesdeEntorno();
  if (fromEnv) {
    return fromEnv;
  }

  const localFallback = cargarCredencialLocal();
  if (localFallback) {
    return localFallback;
  }

  const mensajeProduccion = esProduccion()
    ? ' En produccion, el fallback local esta deshabilitado salvo que FIREBASE_ALLOW_LOCAL_FILE_FALLBACK=true.'
    : '';

  throw new Error(
    'No se encontraron credenciales de Firebase. Configure FIREBASE_SERVICE_ACCOUNT_JSON o GOOGLE_APPLICATION_CREDENTIALS.' +
      mensajeProduccion
  );
}

if (!admin.apps.length) {
  const serviceAccount = resolverServiceAccount();
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const dbFirestore = admin.firestore();
module.exports = dbFirestore;

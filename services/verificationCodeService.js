const crypto = require('crypto');
const nodemailer = require('nodemailer');
const admin = require('firebase-admin');

const dbFirestore = require('../config/firebase');

const COLLECTION_NAME = 'verification_codes';
const ALLOWED_PURPOSES = new Set(['citizen-registration', 'password-change']);
const DEFAULT_EXPIRY_MINUTES = 10;
const DEFAULT_SEND_COOLDOWN_SECONDS = 60;
const DEFAULT_VERIFY_MAX_ATTEMPTS = 5;
const DEFAULT_VERIFY_LOCK_MINUTES = 15;
const DEFAULT_VERIFY_IP_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_VERIFY_IP_MAX_ATTEMPTS = 30;
const verifyIpBuckets = new Map();

function parsePositiveInt(value, defaultValue) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return Math.trunc(parsed);
}

function buildVerificationError(message, options = {}) {
  const error = new Error(message);
  error.statusCode = Number(options.statusCode) || 500;
  if (options.code) {
    error.errorCode = options.code;
  }
  if (options.retryAfterSeconds != null) {
    error.retryAfterSeconds = Math.max(
      1,
      Math.trunc(Number(options.retryAfterSeconds) || 0)
    );
  }
  return error;
}

function esProduccion() {
  return String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
}

function normalizarPurpose(purpose) {
  return String(purpose || '').trim().toLowerCase();
}

function normalizarCanal(channel) {
  return String(channel || '').trim().toLowerCase();
}

function normalizarTarget(channel, target) {
  const raw = String(target || '').trim();
  if (!raw) return '';
  if (channel === 'email') {
    return raw.toLowerCase();
  }
  if (channel === 'sms') {
    return raw.replace(/\s+/g, '');
  }
  return raw;
}

function buildDocId({ purpose, channel, target }) {
  const normalized = `${purpose}::${channel}::${target}`;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function generarCodigo() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function hashCodigo(code) {
  return crypto.createHash('sha256').update(String(code || '').trim()).digest('hex');
}

function obtenerMinutosExpiracion() {
  const fromEnv = Number(process.env.VERIFICATION_CODE_EXPIRY_MINUTES || 0);
  return fromEnv > 0 ? fromEnv : DEFAULT_EXPIRY_MINUTES;
}

function obtenerSegundosCooldownEnvio() {
  return parsePositiveInt(
    process.env.VERIFICATION_SEND_COOLDOWN_SECONDS,
    DEFAULT_SEND_COOLDOWN_SECONDS
  );
}

function obtenerMaxIntentosVerificacion() {
  return parsePositiveInt(
    process.env.VERIFICATION_VERIFY_MAX_ATTEMPTS,
    DEFAULT_VERIFY_MAX_ATTEMPTS
  );
}

function obtenerMinutosBloqueoVerificacion() {
  return parsePositiveInt(
    process.env.VERIFICATION_VERIFY_LOCK_MINUTES,
    DEFAULT_VERIFY_LOCK_MINUTES
  );
}

function obtenerVentanaIpVerificacionMs() {
  return parsePositiveInt(
    process.env.VERIFICATION_VERIFY_IP_WINDOW_MS,
    DEFAULT_VERIFY_IP_WINDOW_MS
  );
}

function obtenerMaxIntentosIpVerificacion() {
  return parsePositiveInt(
    process.env.VERIFICATION_VERIFY_IP_MAX_ATTEMPTS,
    DEFAULT_VERIFY_IP_MAX_ATTEMPTS
  );
}

function timestampToDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === 'function') {
    return value.toDate();
  }
  return null;
}

function clearVerificationThrottleState() {
  return {
    failed_attempts: 0,
    last_failed_at: admin.firestore.FieldValue.delete(),
    locked_until: admin.firestore.FieldValue.delete(),
  };
}

function normalizeFailedAttempts(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return Math.trunc(parsed);
}

function normalizarIp(ip) {
  return String(ip || '').trim();
}

function limpiarIntentosIpExpirados(ip, nowMs) {
  const windowMs = obtenerVentanaIpVerificacionMs();
  const current = verifyIpBuckets.get(ip) || [];
  const filtered = current.filter((value) => nowMs - value < windowMs);
  if (filtered.length > 0) {
    verifyIpBuckets.set(ip, filtered);
  } else {
    verifyIpBuckets.delete(ip);
  }
  return filtered;
}

function registrarIntentoIpVerificacion(ip, nowMs) {
  const normalizedIp = normalizarIp(ip);
  if (!normalizedIp) {
    return [];
  }

  const filtered = limpiarIntentosIpExpirados(normalizedIp, nowMs);
  filtered.push(nowMs);
  verifyIpBuckets.set(normalizedIp, filtered);

  const windowMs = obtenerVentanaIpVerificacionMs();
  setTimeout(() => {
    limpiarIntentosIpExpirados(normalizedIp, Date.now());
  }, windowMs).unref?.();

  return filtered;
}

function validarRateLimitIpVerificacion(ip) {
  const normalizedIp = normalizarIp(ip);
  if (!normalizedIp) {
    return;
  }

  const maxAttempts = obtenerMaxIntentosIpVerificacion();
  if (maxAttempts <= 0) {
    return;
  }

  const nowMs = Date.now();
  const bucket = registrarIntentoIpVerificacion(normalizedIp, nowMs);
  if (bucket.length <= maxAttempts) {
    return;
  }

  const retryAfterMs =
    bucket[0] + obtenerVentanaIpVerificacionMs() - nowMs;
  throw buildVerificationError(
    'Demasiados intentos de verificacion. Espere antes de intentar nuevamente.',
    {
      statusCode: 429,
      code: 'verification_verify_rate_limited',
      retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
    }
  );
}

function smtpConfigurado() {
  return Boolean(
    process.env.SMTP_HOST &&
      process.env.SMTP_PORT &&
      process.env.SMTP_USER &&
      process.env.SMTP_PASS
  );
}

function buildTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

function debugFallbackHabilitado() {
  if (esProduccion()) {
    return false;
  }
  const configured = String(process.env.VERIFICATION_DEBUG_FALLBACK || '').trim();
  if (!configured) {
    return true;
  }
  return configured.toLowerCase() === 'true';
}

function exponerCodigoDebug() {
  if (esProduccion()) {
    return false;
  }
  return String(process.env.VERIFICATION_DEBUG_EXPOSE_CODE || 'false') === 'true';
}

function actorRevocadoOInactivo(actor) {
  if (!actor || typeof actor !== 'object') {
    return false;
  }
  return actor.activo === false || String(actor.estado_acceso || '').trim().toLowerCase() === 'revocado';
}

async function resolverTelefonoActor(actor) {
  if (!actor || typeof actor !== 'object') {
    return '';
  }

  if (actor.tipo === 'central' || actor.tipo === 'operativo') {
    const email = normalizarTarget('email', actor.email);
    if (!email) return '';
    const snap = await dbFirestore.collection('usuarios_central').doc(email).get();
    return normalizarTarget('sms', snap.data()?.celular);
  }

  if (actor.tipo === 'ciudadano') {
    const dni = String(actor.dni || actor.identificador || '').trim();
    if (!dni) return '';
    const snap = await dbFirestore.collection('ciudadanos').doc(dni).get();
    return normalizarTarget('sms', snap.data()?.telefono);
  }

  return '';
}

async function validarContextoSegunPurpose({
  purpose,
  channel,
  target,
  actor = null,
  actorAuthError = null,
}) {
  const normalizedPurpose = normalizarPurpose(purpose);
  const normalizedChannel = normalizarCanal(channel);
  const normalizedTarget = normalizarTarget(normalizedChannel, target);

  if (!ALLOWED_PURPOSES.has(normalizedPurpose)) {
    throw buildVerificationError('El purpose de verificacion no es valido.', {
      statusCode: 400,
      code: 'invalid_verification_purpose',
    });
  }

  if (normalizedPurpose !== 'password-change') {
    return {
      normalizedPurpose,
      normalizedChannel,
      normalizedTarget,
    };
  }

  if (actorAuthError && !actor) {
    throw buildVerificationError('Token de actor invalido o vencido.', {
      statusCode: 401,
      code: 'invalid_actor_token',
    });
  }

  if (!actor) {
    throw buildVerificationError(
      'Se requiere autenticacion del actor para este proceso.',
      {
        statusCode: 401,
        code: 'actor_auth_required',
      }
    );
  }

  if (actorRevocadoOInactivo(actor)) {
    throw buildVerificationError(
      'La cuenta institucional no tiene acceso habilitado.',
      {
        statusCode: 403,
        code: 'actor_access_revoked',
      }
    );
  }

  if (normalizedChannel === 'email') {
    const actorEmail = normalizarTarget('email', actor.email);
    if (!actorEmail || actorEmail !== normalizedTarget) {
      throw buildVerificationError(
        'El objetivo de verificacion no pertenece al actor autenticado.',
        {
          statusCode: 403,
          code: 'verification_target_forbidden',
        }
      );
    }
    return {
      normalizedPurpose,
      normalizedChannel,
      normalizedTarget,
    };
  }

  if (normalizedChannel === 'sms') {
    const actorPhone = await resolverTelefonoActor(actor);
    if (!actorPhone || actorPhone !== normalizedTarget) {
      throw buildVerificationError(
        'El objetivo de verificacion no pertenece al actor autenticado.',
        {
          statusCode: 403,
          code: 'verification_target_forbidden',
        }
      );
    }
  }

  return {
    normalizedPurpose,
    normalizedChannel,
    normalizedTarget,
  };
}

async function entregarPorEmail({ target, code, purpose }) {
  if (smtpConfigurado()) {
    const transporter = buildTransporter();
    await transporter.sendMail({
      from:
        process.env.SMTP_FROM ||
        '"SOS Santa Anita" <no-reply@santaanita.gob.pe>',
      to: target,
      subject: 'Codigo de verificacion - SOS Santa Anita',
      text: [
        'Se solicito un codigo de verificacion para SOS Santa Anita.',
        '',
        `Codigo: ${code}`,
        `Motivo: ${purpose}`,
        `Vigencia: ${obtenerMinutosExpiracion()} minutos.`,
      ].join('\n'),
    });
    return {
      delivery: 'email',
      debugCode: null,
    };
  }

  if (!debugFallbackHabilitado()) {
    const error = new Error('El proveedor de correo no esta configurado.');
    error.statusCode = 503;
    throw error;
  }

  console.log(
    `[verification-code][debug] purpose=${purpose} channel=email target=${target} code=${code}`
  );

  return {
    delivery: 'debug',
    debugCode: exponerCodigoDebug() ? code : null,
  };
}

async function entregarPorSms({ target, code, purpose }) {
  if (!debugFallbackHabilitado()) {
    const error = new Error(
      'El proveedor SMS no esta configurado. Use email o desactive la validacion por SMS.'
    );
    error.statusCode = 503;
    throw error;
  }

  console.log(
    `[verification-code][debug] purpose=${purpose} channel=sms target=${target} code=${code}`
  );

  return {
    delivery: 'debug',
    debugCode: exponerCodigoDebug() ? code : null,
  };
}

async function enviarCodigo({
  purpose,
  channel,
  target,
  metadata = {},
  actor = null,
  actorAuthError = null,
}) {
  const {
    normalizedPurpose,
    normalizedChannel,
    normalizedTarget,
  } = await validarContextoSegunPurpose({
    purpose,
    channel,
    target,
    actor,
    actorAuthError,
  });

  if (!normalizedPurpose || !normalizedChannel || !normalizedTarget) {
    const error = new Error('purpose, channel y target son obligatorios.');
    error.statusCode = 400;
    throw error;
  }

  const docId = buildDocId({
    purpose: normalizedPurpose,
    channel: normalizedChannel,
    target: normalizedTarget,
  });
  const ref = dbFirestore.collection(COLLECTION_NAME).doc(docId);
  const snap = await ref.get();
  const data = snap.data() || {};
  const now = new Date();
  const cooldownSeconds = obtenerSegundosCooldownEnvio();
  const lastSentAt = timestampToDate(data.last_sent_at);

  if (lastSentAt instanceof Date && cooldownSeconds > 0) {
    const availableAt = lastSentAt.getTime() + cooldownSeconds * 1000;
    if (availableAt > now.getTime()) {
      throw buildVerificationError(
        'Espere antes de solicitar un nuevo codigo.',
        {
          statusCode: 429,
          code: 'verification_send_cooldown_active',
          retryAfterSeconds: Math.ceil((availableAt - now.getTime()) / 1000),
        }
      );
    }
  }

  const code = generarCodigo();
  const expiresAt = new Date(
    Date.now() + obtenerMinutosExpiracion() * 60 * 1000
  );

  let deliveryResult;
  if (normalizedChannel === 'email') {
    deliveryResult = await entregarPorEmail({
      target: normalizedTarget,
      code,
      purpose: normalizedPurpose,
    });
  } else if (normalizedChannel === 'sms') {
    deliveryResult = await entregarPorSms({
      target: normalizedTarget,
      code,
      purpose: normalizedPurpose,
    });
  } else {
    const error = new Error('Canal de verificacion no soportado.');
    error.statusCode = 400;
    throw error;
  }

  await ref.set({
    purpose: normalizedPurpose,
    channel: normalizedChannel,
    target: normalizedTarget,
    code_hash: hashCodigo(code),
    metadata,
    used: false,
    created_at: admin.firestore.FieldValue.serverTimestamp(),
    expires_at: admin.firestore.Timestamp.fromDate(expiresAt),
    last_sent_at: admin.firestore.Timestamp.fromDate(now),
    verified_at: admin.firestore.FieldValue.delete(),
    code: admin.firestore.FieldValue.delete(),
    ...clearVerificationThrottleState(),
  });

  return {
    delivery: deliveryResult.delivery,
    expiresInMinutes: obtenerMinutosExpiracion(),
    debugCode: deliveryResult.debugCode,
  };
}

async function verificarCodigo({
  purpose,
  channel,
  target,
  code,
  ip,
  actor = null,
  actorAuthError = null,
}) {
  const {
    normalizedPurpose,
    normalizedChannel,
    normalizedTarget,
  } = await validarContextoSegunPurpose({
    purpose,
    channel,
    target,
    actor,
    actorAuthError,
  });
  const normalizedCode = String(code || '').trim();

  if (!normalizedPurpose || !normalizedChannel || !normalizedTarget || !normalizedCode) {
    return { ok: false, reason: 'missing-params' };
  }

  validarRateLimitIpVerificacion(ip);

  const docId = buildDocId({
    purpose: normalizedPurpose,
    channel: normalizedChannel,
    target: normalizedTarget,
  });
  const ref = dbFirestore.collection(COLLECTION_NAME).doc(docId);
  const snap = await ref.get();
  const now = new Date();
  const data = snap.data() || {};
  const lockedUntil = timestampToDate(data.locked_until);

  if (lockedUntil instanceof Date && lockedUntil > now) {
    throw buildVerificationError(
      'Demasiados intentos de verificacion. Espere antes de intentar nuevamente.',
      {
        statusCode: 429,
        code: 'verification_verify_rate_limited',
        retryAfterSeconds: Math.ceil(
          (lockedUntil.getTime() - now.getTime()) / 1000
        ),
      }
    );
  }

  const expiresAt = timestampToDate(data.expires_at);
  const storedHash = String(data.code_hash || '').trim();
  const submittedHash = hashCodigo(normalizedCode);
  const legacyPlainCode = String(data.code || '').trim();
  const codigoValido =
    snap.exists &&
    !data.used &&
    !(expiresAt instanceof Date && expiresAt < now) &&
    (storedHash
      ? storedHash === submittedHash
      : legacyPlainCode === normalizedCode);

  if (!codigoValido) {
    const failedAttempts = normalizeFailedAttempts(data.failed_attempts);
    const nextFailedAttempts = failedAttempts + 1;
    const maxAttempts = obtenerMaxIntentosVerificacion();
    const updateData = {
      purpose: normalizedPurpose,
      channel: normalizedChannel,
      target: normalizedTarget,
      failed_attempts: nextFailedAttempts,
      last_failed_at: admin.firestore.Timestamp.fromDate(now),
    };

    if (maxAttempts > 0 && nextFailedAttempts >= maxAttempts) {
      const lockedUntilDate = new Date(
        now.getTime() + obtenerMinutosBloqueoVerificacion() * 60 * 1000
      );
      await ref.set(
        {
          ...updateData,
          locked_until: admin.firestore.Timestamp.fromDate(lockedUntilDate),
        },
        { merge: true }
      );

      throw buildVerificationError(
        'Demasiados intentos de verificacion. Espere antes de intentar nuevamente.',
        {
          statusCode: 429,
          code: 'verification_verify_rate_limited',
          retryAfterSeconds: Math.ceil(
            (lockedUntilDate.getTime() - now.getTime()) / 1000
          ),
        }
      );
    }

    await ref.set(updateData, { merge: true });
    return { ok: false, reason: 'invalid-code' };
  }

  await ref.set(
    {
      used: true,
      verified_at: admin.firestore.FieldValue.serverTimestamp(),
      code: admin.firestore.FieldValue.delete(),
      ...clearVerificationThrottleState(),
    },
    { merge: true }
  );

  return { ok: true };
}

module.exports = {
  enviarCodigo,
  verificarCodigo,
};

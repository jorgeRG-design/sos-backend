const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const admin = require('firebase-admin');

require('dotenv').config({
  path: path.resolve(__dirname, '..', '..', '.env'),
});

const DEFAULT_BACKUP_ROOT = path.resolve(__dirname, '..', '..', 'runtime_backups');
const DEFAULT_COLLECTIONS = [
  'ciudadanos',
  'usuarios_central',
  'alertas',
  'recorridos_gps',
  'bitacora_camaras',
  'reportes_diarios_camaras',
];

function parseArgs(argv) {
  const parsed = {};
  for (const arg of argv.slice(2)) {
    if (!String(arg).startsWith('--')) {
      continue;
    }
    const raw = String(arg).slice(2);
    const separatorIndex = raw.indexOf('=');
    if (separatorIndex === -1) {
      parsed[raw] = true;
      continue;
    }
    const key = raw.slice(0, separatorIndex);
    const value = raw.slice(separatorIndex + 1);
    parsed[key] = value;
  }
  return parsed;
}

function resolveMode(rawMode, defaultMode = 'execute') {
  const mode = String(rawMode || defaultMode).trim().toLowerCase();
  if (mode !== 'dry-run' && mode !== 'execute') {
    throw new Error('Parametro --mode invalido. Use dry-run o execute.');
  }
  return mode;
}

function parsePositiveInt(value, defaultValue) {
  if (value == null || String(value).trim() === '') {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return Math.trunc(parsed);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function resolveEnv(names, defaultValue = '') {
  for (const name of names) {
    const value = process.env[name];
    if (value != null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return defaultValue;
}

function resolveBackupRootDir(rawValue) {
  return path.resolve(rawValue || resolveEnv(['BACKUP_ROOT_DIR'], DEFAULT_BACKUP_ROOT));
}

function resolveLogDir(rawValue, backupRootDir) {
  return path.resolve(rawValue || resolveEnv(['LOG_DIR'], path.join(backupRootDir, 'logs')));
}

function sanitizeFileName(value) {
  return String(value)
    .replace(/[\\/:*?"<>|]+/g, '__')
    .replace(/\s+/g, '_');
}

function timestampCompact(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  const second = String(date.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}_${hour}${minute}${second}`;
}

function dateStamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function createExecutionContext(job, options = {}) {
  const startedAt = new Date();
  const backupRootDir = ensureDir(resolveBackupRootDir(options.backupRootDir));
  const logDir = ensureDir(resolveLogDir(options.logDir, backupRootDir));
  const timestamp = timestampCompact(startedAt);
  const runId = `${job}-${timestamp}-${crypto.randomUUID()}`;
  return {
    job,
    mode: resolveMode(options.mode, options.defaultMode || 'execute'),
    startedAt,
    backupRootDir,
    logDir,
    timestampCompact: timestamp,
    dateStamp: dateStamp(startedAt),
    runId,
  };
}

function createLogger(ctx) {
  const logPath = path.join(ctx.logDir, `${ctx.job}_${ctx.timestampCompact}.log`);
  function log(payload) {
    const line = JSON.stringify(payload);
    fs.appendFileSync(logPath, `${line}\n`, 'utf8');
    process.stdout.write(`${line}\n`);
  }
  return { logPath, log };
}

function createSummary(ctx, extra = {}) {
  return {
    run_id: ctx.runId,
    job: ctx.job,
    mode: ctx.mode,
    started_at: ctx.startedAt.toISOString(),
    ended_at: null,
    duration_ms: 0,
    success: false,
    errors: [],
    warnings: [],
    ...extra,
  };
}

function completeSummary(ctx, summary, success) {
  const endedAt = new Date();
  return {
    ...summary,
    ended_at: endedAt.toISOString(),
    duration_ms: endedAt.getTime() - ctx.startedAt.getTime(),
    success,
  };
}

function errorToJson(error) {
  if (!error) {
    return { message: 'Unknown error' };
  }
  return {
    message: String(error.message || error),
    code: error.code || null,
    stack: process.env.NODE_ENV === 'production' ? undefined : error.stack || null,
  };
}

function resolveCollections(rawCollections, fallback = DEFAULT_COLLECTIONS) {
  const raw = rawCollections || resolveEnv(['FIRESTORE_COLLECTIONS'], '');
  if (!raw) {
    return [...fallback];
  }
  return String(raw)
    .split(/[,\n;]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.replace(/^\/+|\/+$/g, ''));
}

function prepareFirebaseCredentialsEnv() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const fallback = resolveEnv(['FIREBASE_CREDENTIALS_PATH'], '');
    if (fallback) {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = fallback;
    }
  }
}

function getFirestoreDb() {
  prepareFirebaseCredentialsEnv();
  return require(path.resolve(__dirname, '..', '..', 'config', 'firebase.js'));
}

function serializeFirestoreValue(value) {
  if (value instanceof admin.firestore.Timestamp) {
    return {
      __backupType: 'timestamp',
      seconds: value.seconds,
      nanoseconds: value.nanoseconds,
    };
  }

  if (value instanceof admin.firestore.GeoPoint) {
    return {
      __backupType: 'geopoint',
      latitude: value.latitude,
      longitude: value.longitude,
    };
  }

  if (value instanceof admin.firestore.DocumentReference) {
    return {
      __backupType: 'reference',
      path: value.path,
    };
  }

  if (Buffer.isBuffer(value)) {
    return {
      __backupType: 'bytes',
      base64: value.toString('base64'),
    };
  }

  if (value instanceof Uint8Array) {
    return {
      __backupType: 'bytes',
      base64: Buffer.from(value).toString('base64'),
    };
  }

  if (value instanceof Date) {
    return {
      __backupType: 'date',
      value: value.toISOString(),
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => serializeFirestoreValue(item));
  }

  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      output[key] = serializeFirestoreValue(nestedValue);
    }
    return output;
  }

  return value;
}

function deserializeFirestoreValue(value, db) {
  if (Array.isArray(value)) {
    return value.map((item) => deserializeFirestoreValue(item, db));
  }

  if (value && typeof value === 'object') {
    if (value.__backupType === 'timestamp') {
      return new admin.firestore.Timestamp(value.seconds, value.nanoseconds);
    }

    if (value.__backupType === 'geopoint') {
      return new admin.firestore.GeoPoint(value.latitude, value.longitude);
    }

    if (value.__backupType === 'reference') {
      return db.doc(value.path);
    }

    if (value.__backupType === 'bytes') {
      return Buffer.from(value.base64 || '', 'base64');
    }

    if (value.__backupType === 'date') {
      return new Date(value.value);
    }

    const output = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      output[key] = deserializeFirestoreValue(nestedValue, db);
    }
    return output;
  }

  return value;
}

function writeJsonFile(filePath, payload) {
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

async function readNdjson(filePath, onLine) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const reader = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  for await (const line of reader) {
    const trimmed = String(line).trim();
    if (!trimmed) {
      continue;
    }
    await onLine(JSON.parse(trimmed));
  }
}

module.exports = {
  completeSummary,
  createExecutionContext,
  createLogger,
  createSummary,
  deserializeFirestoreValue,
  ensureDir,
  errorToJson,
  getFirestoreDb,
  parseArgs,
  parsePositiveInt,
  readNdjson,
  resolveCollections,
  resolveMode,
  sanitizeFileName,
  serializeFirestoreValue,
  timestampCompact,
  writeJsonFile,
};

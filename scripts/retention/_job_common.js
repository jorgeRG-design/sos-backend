const crypto = require('crypto');
const path = require('path');

require('dotenv').config({
  path: path.resolve(__dirname, '..', '..', '.env'),
});

const DEFAULT_DELETE_CAP = 500;

function parseBoolean(value, defaultValue = false) {
  if (value == null || String(value).trim() === '') {
    return defaultValue;
  }
  const normalized = String(value).trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
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

function parseArgs(argv) {
  const parsed = {};
  for (const arg of argv.slice(2)) {
    if (!String(arg).startsWith('--')) {
      continue;
    }
    const withoutPrefix = String(arg).slice(2);
    const separatorIndex = withoutPrefix.indexOf('=');
    if (separatorIndex === -1) {
      parsed[withoutPrefix] = true;
      continue;
    }
    const key = withoutPrefix.slice(0, separatorIndex);
    const value = withoutPrefix.slice(separatorIndex + 1);
    parsed[key] = value;
  }
  return parsed;
}

function resolveMode(rawMode) {
  const mode = String(rawMode || 'dry-run').trim().toLowerCase();
  if (mode !== 'dry-run' && mode !== 'execute') {
    throw new Error('Parametro --mode invalido. Use dry-run o execute.');
  }
  return mode;
}

function resolveCutoff(rawCutoff, fallbackDate) {
  if (rawCutoff == null || String(rawCutoff).trim() === '') {
    return new Date(fallbackDate.getTime());
  }
  const parsed = new Date(String(rawCutoff).trim());
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('Parametro --cutoff invalido. Use una fecha ISO-8601.');
  }
  return parsed;
}

function getDeleteCap() {
  return parsePositiveInt(
    process.env.RETENTION_MAX_DELETE_PER_RUN,
    DEFAULT_DELETE_CAP
  );
}

function resolveDeleteLimit(rawLimit, defaultLimit) {
  const cap = getDeleteCap();
  const requested = parsePositiveInt(rawLimit, defaultLimit);
  return Math.max(1, Math.min(requested, cap));
}

function resolveScanLimit(rawLimit, defaultLimit) {
  return Math.max(1, parsePositiveInt(rawLimit, defaultLimit));
}

function isPruneEnabled() {
  return parseBoolean(process.env.RETENTION_ENABLE_PRUNE, false);
}

function iso(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    return null;
  }
  return value.toISOString();
}

function createExecutionContext(job, options = {}) {
  const startedAt = new Date();
  const runId = `${job}-${startedAt.getTime()}-${crypto.randomUUID()}`;
  return {
    job,
    mode: resolveMode(options.mode),
    limit: options.limit,
    cutoff: resolveCutoff(options.cutoff, options.defaultCutoff || startedAt),
    startedAt,
    runId,
  };
}

function createSummary(ctx, extra = {}) {
  const endedAt = new Date();
  return {
    run_id: ctx.runId,
    execution_id: ctx.runId,
    job: ctx.job,
    mode: ctx.mode,
    cutoff_ts: iso(ctx.cutoff),
    started_at: iso(ctx.startedAt),
    ended_at: iso(endedAt),
    duration_ms: endedAt.getTime() - ctx.startedAt.getTime(),
    scanned: 0,
    candidates: 0,
    affected: 0,
    batches_executed: 0,
    errors: [],
    warnings: [],
    ...extra,
  };
}

function logJson(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
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

module.exports = {
  createExecutionContext,
  createSummary,
  errorToJson,
  getDeleteCap,
  isPruneEnabled,
  iso,
  logJson,
  parseArgs,
  parsePositiveInt,
  resolveDeleteLimit,
  resolveScanLimit,
};

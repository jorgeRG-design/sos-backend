const { Pool } = require('pg');
require('dotenv').config();

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

const useSsl = parseBoolean(process.env.PG_SSL, false);
const rejectUnauthorized = parseBoolean(
  process.env.PG_SSL_REJECT_UNAUTHORIZED,
  true
);

const poolConfig = {
  user: process.env.PG_USER,
  host: process.env.PG_HOST,
  database: process.env.PG_DATABASE,
  password: process.env.PG_PASSWORD,
  port: Number(process.env.PG_PORT || 5432),
  max: parsePositiveInt(process.env.PG_POOL_MAX, 20),
  idleTimeoutMillis: parsePositiveInt(process.env.PG_POOL_IDLE_TIMEOUT_MS, 10000),
  connectionTimeoutMillis: parsePositiveInt(
    process.env.PG_POOL_CONNECTION_TIMEOUT_MS,
    5000
  ),
  maxUses: parsePositiveInt(process.env.PG_POOL_MAX_USES, 7500),
  statement_timeout: parsePositiveInt(process.env.PG_STATEMENT_TIMEOUT_MS, 15000),
  query_timeout: parsePositiveInt(process.env.PG_QUERY_TIMEOUT_MS, 20000),
  idle_in_transaction_session_timeout: parsePositiveInt(
    process.env.PG_IDLE_IN_TX_TIMEOUT_MS,
    15000
  ),
};

if (useSsl) {
  poolConfig.ssl = {
    rejectUnauthorized,
  };
}

const pool = new Pool(poolConfig);

pool.on('error', (error) => {
  console.error('[pg-pool] Error en cliente inactivo del pool:', error);
});

module.exports = pool;

const pool = require('../../config/db');
const {
  createExecutionContext,
  createSummary,
  errorToJson,
  isPruneEnabled,
  logJson,
  parseArgs,
  resolveDeleteLimit,
} = require('./_job_common');
const {
  dbFirestore,
  deleteFirestoreDocsInBatches,
  fetchUniqueFirestoreDocs,
  timestampToDate,
  toTimestamp,
} = require('./_firestore_retention_common');

const JOB_NAME = 'gps_retention_prune';
const FIRESTORE_COLLECTION = 'recorridos_gps';
const SQL_TABLE = 'public.recorridos_gps';
const DEFAULT_FIRESTORE_RETENTION_DAYS = 365;
const DEFAULT_SQL_RETENTION_DAYS = 730;

function defaultFirestoreCutoffDate() {
  return new Date(Date.now() - DEFAULT_FIRESTORE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

function defaultSqlCutoffDate() {
  return new Date(Date.now() - DEFAULT_SQL_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

function resolveSqlCutoff(ctx, rawCutoff) {
  if (rawCutoff != null && String(rawCutoff).trim() !== '') {
    return new Date(ctx.cutoff.getTime());
  }
  return defaultSqlCutoffDate();
}

function allocateSurfaceLimits(totalLimit, firestoreCount, sqlCount) {
  let firestoreLimit = Math.min(firestoreCount, Math.ceil(totalLimit / 2));
  let sqlLimit = Math.min(sqlCount, Math.floor(totalLimit / 2));
  let remaining = totalLimit - firestoreLimit - sqlLimit;

  while (remaining > 0 && (firestoreLimit < firestoreCount || sqlLimit < sqlCount)) {
    if (firestoreLimit < firestoreCount) {
      firestoreLimit += 1;
      remaining -= 1;
    }
    if (remaining > 0 && sqlLimit < sqlCount) {
      sqlLimit += 1;
      remaining -= 1;
    }
  }

  return { firestoreLimit, sqlLimit };
}

async function fetchFirestoreCandidates(limit, cutoff) {
  const cutoffTimestamp = toTimestamp(cutoff);
  const result = await fetchUniqueFirestoreDocs({
    limit,
    queries: [
      {
        name: 'fecha_importacion',
        query: dbFirestore
          .collection(FIRESTORE_COLLECTION)
          .where('fecha_importacion', '<', cutoffTimestamp)
          .orderBy('fecha_importacion', 'asc'),
        matches(data) {
          const importedAt = timestampToDate(data.fecha_importacion);
          return (
            importedAt instanceof Date &&
            importedAt.getTime() < cutoff.getTime()
          );
        },
      },
    ],
  });

  return {
    docs: result.docs,
    candidatePoolBeforeLimit: result.unique_candidate_pool_before_limit,
    totalCandidatesBeforeLimit:
      result.perQuery.fecha_importacion?.total_candidates_before_limit,
    scannedDocs: result.perQuery.fecha_importacion?.matched_in_sample || 0,
  };
}

async function fetchSqlCandidates(client, limit, cutoff) {
  const totals = await client.query(
    `SELECT COUNT(*)::int AS total
     FROM ${SQL_TABLE}
     WHERE fecha_importacion < $1`,
    [cutoff]
  );

  const sample = await client.query(
    `SELECT id, fecha_importacion
     FROM ${SQL_TABLE}
     WHERE fecha_importacion < $1
     ORDER BY fecha_importacion ASC, id ASC
     LIMIT $2`,
    [cutoff, limit]
  );

  const rows = sample.rows || [];
  return {
    rows,
    candidateIds: rows.map((row) => String(row.id)),
    rowsCandidate: rows.length,
    totalCandidates: Number(totals.rows[0]?.total || 0),
    minFechaImportacion: rows[0]?.fecha_importacion || null,
    maxFechaImportacion: rows[rows.length - 1]?.fecha_importacion || null,
  };
}

async function deleteSqlCandidates(client, candidateIds) {
  if (!candidateIds.length) {
    return 0;
  }
  const result = await client.query(
    `DELETE FROM ${SQL_TABLE}
     WHERE id = ANY($1::uuid[])
     RETURNING id`,
    [candidateIds]
  );
  return result.rowCount || 0;
}

async function main() {
  const args = parseArgs(process.argv);
  const ctx = createExecutionContext(JOB_NAME, {
    mode: args.mode,
    limit: resolveDeleteLimit(args.limit, 500),
    cutoff: args.cutoff,
    defaultCutoff: defaultFirestoreCutoffDate(),
  });
  const sqlCutoff = resolveSqlCutoff(ctx, args.cutoff);

  logJson({
    level: 'info',
    event: 'job_started',
    job: JOB_NAME,
    run_id: ctx.runId,
    mode: ctx.mode,
    cutoff_ts: ctx.cutoff.toISOString(),
    firestore_cutoff_ts: ctx.cutoff.toISOString(),
    sql_cutoff_ts: sqlCutoff.toISOString(),
    limit: ctx.limit,
  });

  const client = await pool.connect();
  let firestoreDeleted = 0;
  let sqlDeleted = 0;
  let batchesExecuted = 0;
  const errors = [];

  try {
    const [firestoreStats, sqlStats] = await Promise.all([
      fetchFirestoreCandidates(ctx.limit, ctx.cutoff),
      fetchSqlCandidates(client, ctx.limit, sqlCutoff),
    ]);

    const warnings = [];
    if (
      typeof firestoreStats.totalCandidatesBeforeLimit === 'number' &&
      firestoreStats.totalCandidatesBeforeLimit > firestoreStats.docs.length
    ) {
      warnings.push(
        `Firestore se procesaria en ventana parcial: ${firestoreStats.docs.length}/${firestoreStats.totalCandidatesBeforeLimit} candidatos dentro del cutoff.`
      );
    }
    if (sqlStats.totalCandidates > sqlStats.rowsCandidate) {
      warnings.push(
        `PostgreSQL se procesaria en ventana parcial: ${sqlStats.rowsCandidate}/${sqlStats.totalCandidates} filas candidatas dentro del cutoff.`
      );
    }

    if (ctx.mode === 'execute' && !isPruneEnabled()) {
      warnings.push('RETENTION_ENABLE_PRUNE != true; no se eliminaron recorridos GPS.');
    } else if (ctx.mode === 'execute') {
      const allocation = allocateSurfaceLimits(
        ctx.limit,
        firestoreStats.docs.length,
        sqlStats.candidateIds.length
      );

      const firestoreDocsToDelete = firestoreStats.docs.slice(0, allocation.firestoreLimit);
      const sqlIdsToDelete = sqlStats.candidateIds.slice(0, allocation.sqlLimit);

      try {
        if (firestoreDocsToDelete.length > 0) {
          const deletion = await deleteFirestoreDocsInBatches(firestoreDocsToDelete);
          firestoreDeleted = deletion.deletedDocs;
          batchesExecuted += deletion.batchesExecuted;
        }
      } catch (error) {
        errors.push({
          surface: 'firestore',
          ...errorToJson(error),
        });
      }

      try {
        if (sqlIdsToDelete.length > 0) {
          sqlDeleted = await deleteSqlCandidates(client, sqlIdsToDelete);
          if (sqlDeleted > 0) {
            batchesExecuted += 1;
          }
        }
      } catch (error) {
        errors.push({
          surface: 'postgresql',
          ...errorToJson(error),
        });
      }
    }

    const summary = createSummary(ctx, {
      scanned: firestoreStats.scannedDocs + sqlStats.rowsCandidate,
      candidates: firestoreStats.docs.length + sqlStats.rowsCandidate,
      affected: firestoreDeleted + sqlDeleted,
      batches_executed: batchesExecuted,
      errors,
      warnings,
      firestore_cutoff_ts: ctx.cutoff.toISOString(),
      sql_cutoff_ts: sqlCutoff.toISOString(),
      scanned_firestore: firestoreStats.scannedDocs,
      candidates_firestore: firestoreStats.docs.length,
      deleted_firestore: firestoreDeleted,
      firestore_total_candidates_before_limit:
        firestoreStats.totalCandidatesBeforeLimit,
      firestore_candidate_pool_before_limit:
        firestoreStats.candidatePoolBeforeLimit,
      scanned_sql: sqlStats.rowsCandidate,
      candidates_sql: sqlStats.rowsCandidate,
      deleted_sql: sqlDeleted,
      sql_total_candidates_before_limit: sqlStats.totalCandidates,
      sql_min_fecha_importacion:
        sqlStats.minFechaImportacion instanceof Date
          ? sqlStats.minFechaImportacion.toISOString()
          : null,
      sql_max_fecha_importacion:
        sqlStats.maxFechaImportacion instanceof Date
          ? sqlStats.maxFechaImportacion.toISOString()
          : null,
      prune_enabled: isPruneEnabled(),
    });

    logJson(summary);
    if (errors.length > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    const summary = createSummary(ctx, {
      firestore_cutoff_ts: ctx.cutoff.toISOString(),
      sql_cutoff_ts: sqlCutoff.toISOString(),
      errors: [errorToJson(error)],
      warnings: [],
    });
    logJson(summary);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
}

main();

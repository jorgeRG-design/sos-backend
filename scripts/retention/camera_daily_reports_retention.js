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
  isoDay,
  timestampToDate,
  toTimestamp,
} = require('./_firestore_retention_common');

const JOB_NAME = 'camera_daily_reports_retention';
const COLLECTION_NAME = 'reportes_diarios_camaras';
const DEFAULT_RETENTION_MONTHS = 24;

function defaultCutoffDate() {
  const now = new Date();
  const cutoff = new Date(now.getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - DEFAULT_RETENTION_MONTHS);
  return cutoff;
}

async function fetchCandidates(limit, cutoff) {
  const cutoffTimestamp = toTimestamp(cutoff);
  const cutoffDay = isoDay(cutoff);
  const result = await fetchUniqueFirestoreDocs({
    limit,
    queries: [
      {
        name: 'fecha_hora',
        query: dbFirestore
          .collection(COLLECTION_NAME)
          .where('fecha_hora', '<', cutoffTimestamp)
          .orderBy('fecha_hora', 'asc'),
        matches(data) {
          const fechaHora = timestampToDate(data.fecha_hora);
          return fechaHora instanceof Date && fechaHora.getTime() < cutoff.getTime();
        },
      },
      {
        name: 'fecha_dia',
        query: dbFirestore
          .collection(COLLECTION_NAME)
          .where('fecha_dia', '<', cutoffDay)
          .orderBy('fecha_dia', 'asc'),
        matches(data) {
          const fechaDia = String(data.fecha_dia || '').trim();
          return Boolean(fechaDia) && fechaDia < cutoffDay;
        },
      },
    ],
  });

  const docs = result.docs;
  const sortedDates = docs
    .map((doc) => {
      const data = doc.data() || {};
      const fechaHora = timestampToDate(data.fecha_hora);
      if (fechaHora instanceof Date) {
        return fechaHora;
      }
      const fechaDia = String(data.fecha_dia || '').trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(fechaDia)) {
        return new Date(`${fechaDia}T00:00:00.000Z`);
      }
      return null;
    })
    .filter((value) => value instanceof Date)
    .sort((a, b) => a.getTime() - b.getTime());

  return {
    docs,
    scannedDocs:
      (result.perQuery.fecha_hora?.matched_in_sample || 0) +
      (result.perQuery.fecha_dia?.matched_in_sample || 0),
    totalFechaHora: result.perQuery.fecha_hora?.total_candidates_before_limit,
    totalFechaDia: result.perQuery.fecha_dia?.total_candidates_before_limit,
    candidatePoolBeforeLimit: result.unique_candidate_pool_before_limit,
    oldestCandidate: sortedDates[0] || null,
    newestCandidate: sortedDates[sortedDates.length - 1] || null,
    cutoffDay,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const ctx = createExecutionContext(JOB_NAME, {
    mode: args.mode,
    limit: resolveDeleteLimit(args.limit, 500),
    cutoff: args.cutoff,
    defaultCutoff: defaultCutoffDate(),
  });

  logJson({
    level: 'info',
    event: 'job_started',
    job: JOB_NAME,
    run_id: ctx.runId,
    mode: ctx.mode,
    cutoff_ts: ctx.cutoff.toISOString(),
    cutoff_day: isoDay(ctx.cutoff),
    limit: ctx.limit,
    collection: COLLECTION_NAME,
  });

  try {
    const stats = await fetchCandidates(ctx.limit, ctx.cutoff);
    const warnings = [];
    if (stats.candidatePoolBeforeLimit > stats.docs.length) {
      warnings.push(
        `Se procesaria una ventana parcial: ${stats.docs.length}/${stats.candidatePoolBeforeLimit} documentos unicos candidatos dentro del cutoff.`
      );
    }

    let deletedDocs = 0;
    let batchesExecuted = 0;
    if (ctx.mode === 'execute' && !isPruneEnabled()) {
      warnings.push('RETENTION_ENABLE_PRUNE != true; no se eliminaron reportes diarios de camaras.');
    } else if (ctx.mode === 'execute' && stats.docs.length > 0) {
      const deletion = await deleteFirestoreDocsInBatches(stats.docs);
      deletedDocs = deletion.deletedDocs;
      batchesExecuted = deletion.batchesExecuted;
    }

    const summary = createSummary(ctx, {
      scanned: stats.scannedDocs,
      candidates: stats.docs.length,
      affected: deletedDocs,
      batches_executed: batchesExecuted,
      warnings,
      collection: COLLECTION_NAME,
      cutoff_day: stats.cutoffDay,
      scanned_docs: stats.scannedDocs,
      candidates_docs: stats.docs.length,
      candidates_fecha_hora: stats.totalFechaHora,
      candidates_fecha_dia: stats.totalFechaDia,
      deleted_docs: deletedDocs,
      candidate_pool_before_limit: stats.candidatePoolBeforeLimit,
      oldest_candidate_ts:
        stats.oldestCandidate instanceof Date
          ? stats.oldestCandidate.toISOString()
          : null,
      newest_candidate_ts:
        stats.newestCandidate instanceof Date
          ? stats.newestCandidate.toISOString()
          : null,
      prune_enabled: isPruneEnabled(),
    });

    logJson(summary);
  } catch (error) {
    const summary = createSummary(ctx, {
      collection: COLLECTION_NAME,
      errors: [errorToJson(error)],
      warnings: [],
    });
    logJson(summary);
    process.exitCode = 1;
  }
}

main();

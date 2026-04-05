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

const JOB_NAME = 'camera_log_prune';
const COLLECTION_NAME = 'bitacora_camaras';
const DEFAULT_RETENTION_DAYS = 365;

function defaultCutoffDate() {
  return new Date(Date.now() - DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

async function fetchCandidates(limit, cutoff) {
  const cutoffTimestamp = toTimestamp(cutoff);
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
    ],
  });

  const docs = result.docs;
  const sortedDates = docs
    .map((doc) => timestampToDate((doc.data() || {}).fecha_hora))
    .filter((value) => value instanceof Date)
    .sort((a, b) => a.getTime() - b.getTime());

  return {
    docs,
    scannedDocs: result.perQuery.fecha_hora?.matched_in_sample || 0,
    totalCandidatesBeforeLimit: result.perQuery.fecha_hora?.total_candidates_before_limit,
    candidatePoolBeforeLimit: result.unique_candidate_pool_before_limit,
    oldestCandidate: sortedDates[0] || null,
    newestCandidate: sortedDates[sortedDates.length - 1] || null,
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
    limit: ctx.limit,
    collection: COLLECTION_NAME,
  });

  try {
    const stats = await fetchCandidates(ctx.limit, ctx.cutoff);
    const warnings = [];
    if (
      typeof stats.totalCandidatesBeforeLimit === 'number' &&
      stats.totalCandidatesBeforeLimit > stats.docs.length
    ) {
      warnings.push(
        `Se procesaria una ventana parcial: ${stats.docs.length}/${stats.totalCandidatesBeforeLimit} documentos candidatos dentro del cutoff.`
      );
    }

    let deletedDocs = 0;
    let batchesExecuted = 0;
    if (ctx.mode === 'execute' && !isPruneEnabled()) {
      warnings.push('RETENTION_ENABLE_PRUNE != true; no se eliminaron logs de camaras.');
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
      scanned_docs: stats.scannedDocs,
      candidates_fecha_hora: stats.docs.length,
      deleted_docs: deletedDocs,
      total_candidates_before_limit: stats.totalCandidatesBeforeLimit,
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

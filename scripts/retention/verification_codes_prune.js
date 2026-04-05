const admin = require('firebase-admin');

const dbFirestore = require('../../config/firebase');
const {
  createExecutionContext,
  createSummary,
  errorToJson,
  isPruneEnabled,
  logJson,
  parseArgs,
  resolveDeleteLimit,
} = require('./_job_common');

const JOB_NAME = 'verification_codes_prune';
const COLLECTION_NAME = 'verification_codes';
const DEFAULT_RETENTION_HOURS = 72;
const FIRESTORE_BATCH_SIZE = 250;

function defaultCutoffDate() {
  return new Date(Date.now() - DEFAULT_RETENTION_HOURS * 60 * 60 * 1000);
}

function timestampToDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === 'function') return value.toDate();
  return null;
}

async function fetchCandidates(limit, cutoff) {
  const cutoffTimestamp = admin.firestore.Timestamp.fromDate(cutoff);

  const [usedSnapshot, expiredSnapshot] = await Promise.all([
    dbFirestore
      .collection(COLLECTION_NAME)
      .where('verified_at', '<', cutoffTimestamp)
      .orderBy('verified_at', 'asc')
      .limit(limit)
      .get(),
    dbFirestore
      .collection(COLLECTION_NAME)
      .where('expires_at', '<', cutoffTimestamp)
      .orderBy('expires_at', 'asc')
      .limit(limit)
      .get(),
  ]);

  const uniqueDocs = new Map();
  let usedCandidates = 0;
  let expiredCandidates = 0;

  for (const doc of usedSnapshot.docs) {
    const data = doc.data() || {};
    const verifiedAt = timestampToDate(data.verified_at);
    const matchesUsed =
      data.used === true &&
      verifiedAt instanceof Date &&
      verifiedAt.getTime() < cutoff.getTime();

    if (!matchesUsed) {
      continue;
    }

    usedCandidates += 1;
    if (!uniqueDocs.has(doc.id)) {
      uniqueDocs.set(doc.id, doc);
    }
  }

  for (const doc of expiredSnapshot.docs) {
    const data = doc.data() || {};
    const expiresAt = timestampToDate(data.expires_at);
    const matchesExpired =
      expiresAt instanceof Date && expiresAt.getTime() < cutoff.getTime();

    if (!matchesExpired) {
      continue;
    }

    expiredCandidates += 1;
    if (!uniqueDocs.has(doc.id)) {
      uniqueDocs.set(doc.id, doc);
    }
  }

  return {
    scannedDocs: uniqueDocs.size,
    usedCandidates,
    expiredCandidates,
    docs: Array.from(uniqueDocs.values()).slice(0, limit),
  };
}

async function deleteDocsInBatches(docs) {
  let deletedDocs = 0;
  let batchesExecuted = 0;

  for (let index = 0; index < docs.length; index += FIRESTORE_BATCH_SIZE) {
    const batchDocs = docs.slice(index, index + FIRESTORE_BATCH_SIZE);
    if (batchDocs.length === 0) {
      continue;
    }
    const batch = dbFirestore.batch();
    for (const doc of batchDocs) {
      batch.delete(doc.ref);
    }
    await batch.commit();
    deletedDocs += batchDocs.length;
    batchesExecuted += 1;
  }

  return { deletedDocs, batchesExecuted };
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
  });

  try {
    const {
      scannedDocs,
      usedCandidates,
      expiredCandidates,
      docs,
    } = await fetchCandidates(ctx.limit, ctx.cutoff);

    const warnings = [];
    if (scannedDocs > docs.length) {
      warnings.push(
        `Se aplico el limite de ejecucion: ${docs.length}/${scannedDocs} candidatos unicos dentro del cutoff.`
      );
    }
    let deletedDocs = 0;
    let batchesExecuted = 0;

    if (ctx.mode === 'execute' && !isPruneEnabled()) {
      warnings.push('RETENTION_ENABLE_PRUNE != true; no se eliminaron documentos.');
    } else if (ctx.mode === 'execute' && docs.length > 0) {
      const deletion = await deleteDocsInBatches(docs);
      deletedDocs = deletion.deletedDocs;
      batchesExecuted = deletion.batchesExecuted;
    }

    const summary = createSummary(ctx, {
      scanned: scannedDocs,
      candidates: docs.length,
      affected: deletedDocs,
      batches_executed: batchesExecuted,
      warnings,
      scanned_docs: scannedDocs,
      expired_candidates: expiredCandidates,
      used_candidates: usedCandidates,
      deleted_docs: deletedDocs,
      candidate_pool_before_limit: scannedDocs,
      limit_applied: ctx.limit,
      prune_enabled: isPruneEnabled(),
    });

    logJson(summary);
  } catch (error) {
    const summary = createSummary(ctx, {
      errors: [errorToJson(error)],
      warnings: [],
    });
    logJson(summary);
    process.exitCode = 1;
  }
}

main();

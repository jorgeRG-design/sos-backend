const admin = require('firebase-admin');

const dbFirestore = require('../../config/firebase');

const FIRESTORE_BATCH_SIZE = 250;

function timestampToDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === 'function') return value.toDate();
  return null;
}

function isoDay(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    return null;
  }
  return value.toISOString().slice(0, 10);
}

function toTimestamp(date) {
  return admin.firestore.Timestamp.fromDate(date);
}

async function safeCount(query) {
  try {
    const snapshot = await query.count().get();
    return Number(snapshot.data()?.count || 0);
  } catch (_error) {
    return null;
  }
}

async function fetchUniqueFirestoreDocs({ queries, limit }) {
  const uniqueDocs = new Map();
  const perQuery = {};

  for (const spec of queries) {
    const [countResult, snapshot] = await Promise.all([
      safeCount(spec.query),
      spec.query.limit(limit).get(),
    ]);

    let matched = 0;
    for (const doc of snapshot.docs) {
      const data = doc.data() || {};
      const isMatch = typeof spec.matches === 'function' ? spec.matches(data, doc) : true;
      if (!isMatch) {
        continue;
      }
      matched += 1;
      if (!uniqueDocs.has(doc.id)) {
        uniqueDocs.set(doc.id, doc);
      }
    }

    perQuery[spec.name] = {
      total_candidates_before_limit: countResult,
      fetched_docs: snapshot.size,
      matched_in_sample: matched,
    };
  }

  return {
    docs: Array.from(uniqueDocs.values()).slice(0, limit),
    unique_candidate_pool_before_limit: uniqueDocs.size,
    perQuery,
  };
}

async function deleteFirestoreDocsInBatches(docs) {
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

module.exports = {
  dbFirestore,
  deleteFirestoreDocsInBatches,
  fetchUniqueFirestoreDocs,
  isoDay,
  timestampToDate,
  toTimestamp,
};

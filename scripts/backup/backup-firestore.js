const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const {
  completeSummary,
  createExecutionContext,
  createLogger,
  createSummary,
  ensureDir,
  errorToJson,
  getFirestoreDb,
  parseArgs,
  parsePositiveInt,
  resolveCollections,
  sanitizeFileName,
  serializeFirestoreValue,
  writeJsonFile,
} = require('./_backup_common');

const DEFAULT_PAGE_SIZE = 500;

async function exportCollection(db, collectionPath, outputFilePath, pageSize) {
  const stream = fs.createWriteStream(outputFilePath, { encoding: 'utf8' });
  let exportedDocs = 0;
  let lastDocumentId = null;

  try {
    while (true) {
      let query = db
        .collection(collectionPath)
        .orderBy(admin.firestore.FieldPath.documentId())
        .limit(pageSize);

      if (lastDocumentId) {
        query = query.startAfter(lastDocumentId);
      }

      const snapshot = await query.get();
      if (snapshot.empty) {
        break;
      }

      for (const doc of snapshot.docs) {
        const record = {
          collection_path: collectionPath,
          document_id: doc.id,
          document_path: doc.ref.path,
          data: serializeFirestoreValue(doc.data()),
        };
        stream.write(`${JSON.stringify(record)}\n`);
        exportedDocs += 1;
        lastDocumentId = doc.id;
      }

      if (snapshot.size < pageSize) {
        break;
      }
    }
  } finally {
    await new Promise((resolve, reject) => {
      stream.end((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  return exportedDocs;
}

async function main() {
  const args = parseArgs(process.argv);
  const ctx = createExecutionContext('backup_firestore', {
    mode: 'execute',
    backupRootDir: args['backup-root'],
    logDir: args['log-dir'],
  });
  const { logPath, log } = createLogger(ctx);
  const summary = createSummary(ctx, {
    operation: 'backup',
    log_path: logPath,
    backup_root: ctx.backupRootDir,
    collections_requested: [],
    collections_exported: [],
    documents_exported: 0,
    errors: [],
    warnings: [],
  });

  log({
    level: 'info',
    event: 'backup_firestore_started',
    run_id: ctx.runId,
    started_at: ctx.startedAt.toISOString(),
    backup_root: ctx.backupRootDir,
  });

  try {
    const pageSize = parsePositiveInt(args['page-size'], DEFAULT_PAGE_SIZE);
    const collections = resolveCollections(args.collections);
    if (!collections.length) {
      throw new Error('No se definieron colecciones a exportar. Configure FIRESTORE_COLLECTIONS o use --collections.');
    }

    summary.collections_requested = collections;

    const db = getFirestoreDb();
    const backupDir = ensureDir(
      path.join(ctx.backupRootDir, 'firestore', ctx.dateStamp, `firestore_${ctx.timestampCompact}`)
    );
    const collectionsDir = ensureDir(path.join(backupDir, 'collections'));
    const manifestPath = path.join(backupDir, 'manifest.json');

    for (const collectionPath of collections) {
      const normalized = String(collectionPath).replace(/^\/+|\/+$/g, '');
      const fileName = `${sanitizeFileName(normalized)}.ndjson`;
      const outputFilePath = path.join(collectionsDir, fileName);

      try {
        const exportedDocs = await exportCollection(db, normalized, outputFilePath, pageSize);
        summary.collections_exported.push({
          collection_path: normalized,
          file: path.relative(backupDir, outputFilePath),
          documents: exportedDocs,
        });
        summary.documents_exported += exportedDocs;
      } catch (error) {
        summary.errors.push({
          collection_path: normalized,
          error: errorToJson(error),
        });
      }
    }

    const manifest = {
      run_id: ctx.runId,
      backup_type: 'firestore',
      created_at: new Date().toISOString(),
      backup_dir: backupDir,
      collections: summary.collections_exported,
      documents_exported: summary.documents_exported,
    };
    writeJsonFile(manifestPath, manifest);

    summary.backup_dir = backupDir;
    summary.manifest_path = manifestPath;
    const finalSummary = completeSummary(ctx, summary, summary.errors.length === 0);
    log(finalSummary);
    process.exit(finalSummary.success ? 0 : 1);
  } catch (error) {
    summary.errors.push(errorToJson(error));
    log(completeSummary(ctx, summary, false));
    process.exit(1);
  }
}

main();

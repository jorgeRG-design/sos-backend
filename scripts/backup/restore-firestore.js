const fs = require('fs');
const path = require('path');

const {
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
} = require('./_backup_common');

const DEFAULT_BATCH_SIZE = 200;

function loadManifest(inputDir) {
  const manifestPath = path.join(inputDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  return {
    manifestPath,
    manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
  };
}

function discoverCollectionFiles(inputDir) {
  const collectionsDir = path.join(inputDir, 'collections');
  if (!fs.existsSync(collectionsDir)) {
    throw new Error(`No se encontro el directorio de colecciones en el respaldo: ${collectionsDir}`);
  }

  return fs
    .readdirSync(collectionsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ndjson'))
    .map((entry) => ({
      collection_path: entry.name.replace(/\.ndjson$/i, ''),
      file: path.join('collections', entry.name),
    }));
}

async function countRecords(filePath) {
  let count = 0;
  await readNdjson(filePath, async () => {
    count += 1;
  });
  return count;
}

async function commitBatch(db, records) {
  if (!records.length) {
    return 0;
  }

  const batch = db.batch();
  for (const record of records) {
    batch.set(
      db.doc(record.document_path),
      deserializeFirestoreValue(record.data, db)
    );
  }
  await batch.commit();
  return records.length;
}

async function main() {
  const args = parseArgs(process.argv);
  const ctx = createExecutionContext('restore_firestore', {
    mode: args.mode,
    defaultMode: 'dry-run',
    backupRootDir: args['backup-root'],
    logDir: args['log-dir'],
  });
  const { logPath, log } = createLogger(ctx);
  const summary = createSummary(ctx, {
    operation: 'restore',
    log_path: logPath,
    input_dir: null,
    manifest_path: null,
    selected_collections: [],
    scanned_documents: 0,
    restored_documents: 0,
    batches_executed: 0,
    errors: [],
    warnings: [],
  });

  log({
    level: 'info',
    event: 'restore_firestore_started',
    run_id: ctx.runId,
    mode: ctx.mode,
    started_at: ctx.startedAt.toISOString(),
  });

  try {
    const inputDirRaw = String(args['input-dir'] || '').trim();
    if (!inputDirRaw) {
      throw new Error('Parametro requerido: --input-dir=<ruta_del_backup_firestore>.');
    }

    const inputDir = path.resolve(inputDirRaw);
    if (!fs.existsSync(inputDir)) {
      throw new Error(`No se encontro el directorio de respaldo: ${inputDir}`);
    }

    ensureDir(path.dirname(logPath));
    summary.input_dir = inputDir;

    const loadedManifest = loadManifest(inputDir);
    const requestedCollections = resolveCollections(args.collections, []);
    const selectedCollectionSet = new Set(requestedCollections);

    const collectionEntries = loadedManifest
      ? loadedManifest.manifest.collections || []
      : discoverCollectionFiles(inputDir);

    const selectedEntries = collectionEntries.filter((entry) => {
      if (!selectedCollectionSet.size) {
        return true;
      }
      return selectedCollectionSet.has(entry.collection_path);
    });

    if (!selectedEntries.length) {
      throw new Error('No se encontraron colecciones para restaurar con los filtros actuales.');
    }

    summary.manifest_path = loadedManifest ? loadedManifest.manifestPath : null;
    summary.selected_collections = selectedEntries.map((entry) => entry.collection_path);

    if (ctx.mode === 'dry-run') {
      for (const entry of selectedEntries) {
        const filePath = path.join(inputDir, entry.file);
        const docCount = await countRecords(filePath);
        summary.scanned_documents += docCount;
      }
      log(completeSummary(ctx, summary, true));
      process.exit(0);
    }

    const db = getFirestoreDb();
    const batchSize = parsePositiveInt(args['batch-size'], DEFAULT_BATCH_SIZE);

    for (const entry of selectedEntries) {
      const filePath = path.join(inputDir, entry.file);
      let pendingRecords = [];

      await readNdjson(filePath, async (record) => {
        summary.scanned_documents += 1;
        pendingRecords.push(record);

        if (pendingRecords.length >= batchSize) {
          summary.restored_documents += await commitBatch(db, pendingRecords);
          summary.batches_executed += 1;
          pendingRecords = [];
        }
      });

      if (pendingRecords.length) {
        summary.restored_documents += await commitBatch(db, pendingRecords);
        summary.batches_executed += 1;
      }
    }

    log(completeSummary(ctx, summary, true));
    process.exit(0);
  } catch (error) {
    summary.errors.push(errorToJson(error));
    log(completeSummary(ctx, summary, false));
    process.exit(1);
  }
}

main();

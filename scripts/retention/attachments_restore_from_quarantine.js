const fs = require('fs');
const path = require('path');

const {
  createExecutionContext,
  createSummary,
  errorToJson,
  logJson,
  parseArgs,
} = require('./_job_common');
const {
  QUARANTINE_ROOT,
  UPLOAD_ROOT,
  buildOrphanQuarantineRunPaths,
  ensureDirectory,
  isWithinQuarantineRoot,
  isWithinUploadRoot,
  normalizeFsPath,
  relativeFrom,
} = require('./_attachments_common');

const JOB_NAME = 'attachments_restore_from_quarantine';
const EXAMPLE_LIMIT = 20;

function pushExample(list, value) {
  if (list.length < EXAMPLE_LIMIT) {
    list.push(value);
  }
}

function requireRunId(rawRunId) {
  const runId = String(rawRunId || '').trim();
  if (!runId) {
    throw new Error('Parametro --run-id es obligatorio.');
  }
  return runId;
}

async function readManifest(manifestPath) {
  const raw = await fs.promises.readFile(manifestPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
    throw new Error('Manifest de cuarentena invalido.');
  }
  return parsed;
}

function normalizeFileSelector(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  return raw.replace(/\//g, '\\').toLowerCase();
}

function filterEntries(entries, selector) {
  if (!selector) {
    return entries;
  }

  const normalizedSelector = normalizeFileSelector(selector);
  return entries.filter((entry) => {
    const candidates = [
      entry.original_relative_path,
      entry.quarantine_relative_path,
      entry.original_absolute_path,
      entry.quarantine_absolute_path,
    ];

    return candidates.some((candidate) => {
      if (!candidate) return false;
      return normalizeFileSelector(candidate) === normalizedSelector;
    });
  });
}

async function inspectRestoreEntry(entry) {
  const sourcePath = normalizeFsPath(entry.quarantine_absolute_path);
  const destinationPath = normalizeFsPath(entry.original_absolute_path);

  if (!isWithinQuarantineRoot(sourcePath)) {
    return {
      status: 'skipped_invalid_quarantine_path',
      warning: `Origen fuera de la cuarentena controlada: ${sourcePath}`,
    };
  }

  if (!isWithinUploadRoot(destinationPath)) {
    return {
      status: 'skipped_invalid_destination_path',
      warning: `Destino fuera de UPLOAD_ROOT: ${destinationPath}`,
    };
  }

  if (!fs.existsSync(sourcePath)) {
    return {
      status: 'skipped_source_missing',
      warning: `Archivo faltante en cuarentena: ${sourcePath}`,
    };
  }

  if (fs.existsSync(destinationPath)) {
    return {
      status: 'skipped_destination_exists',
      warning: `Destino original ocupado, no se sobreescribe: ${destinationPath}`,
    };
  }

  return {
    status: 'ready_to_restore',
    detail: {
      source_absolute_path: sourcePath,
      destination_absolute_path: destinationPath,
      destination_relative_path: relativeFrom(UPLOAD_ROOT, destinationPath),
      size_bytes: fs.statSync(sourcePath).size,
    },
  };
}

async function restoreFile(entry) {
  const inspection = await inspectRestoreEntry(entry);
  if (inspection.status !== 'ready_to_restore') {
    return inspection;
  }

  const sourcePath = inspection.detail.source_absolute_path;
  const destinationPath = inspection.detail.destination_absolute_path;

  await ensureDirectory(path.dirname(destinationPath));
  await fs.promises.copyFile(sourcePath, destinationPath);

  const sourceStat = await fs.promises.stat(sourcePath);
  await fs.promises.utimes(destinationPath, new Date(), sourceStat.mtime);

  return {
    status: 'restored',
    detail: {
      source_absolute_path: sourcePath,
      destination_absolute_path: destinationPath,
      destination_relative_path: relativeFrom(UPLOAD_ROOT, destinationPath),
      size_bytes: sourceStat.size,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const quarantineRunId = requireRunId(args['run-id']);
  const fileSelector = String(args.file || '').trim();
  const ctx = createExecutionContext(JOB_NAME, {
    mode: args.mode,
    defaultCutoff: new Date(),
  });

  const runPaths = buildOrphanQuarantineRunPaths(quarantineRunId);

  logJson({
    level: 'info',
    event: 'job_started',
    job: JOB_NAME,
    run_id: ctx.runId,
    source_run_id: quarantineRunId,
    mode: ctx.mode,
    manifest_path: runPaths.manifestPath,
    file_selector: fileSelector || null,
    upload_root: UPLOAD_ROOT,
    quarantine_root: QUARANTINE_ROOT,
  });

  try {
    if (!fs.existsSync(runPaths.manifestPath)) {
      throw new Error(`Manifest no encontrado para run-id ${quarantineRunId}`);
    }

    const manifest = await readManifest(runPaths.manifestPath);
    const selectedEntries = filterEntries(manifest.entries, fileSelector);
    const warnings = [];
    const restoredExamples = [];

    if (fileSelector && selectedEntries.length === 0) {
      warnings.push(`No se encontraron entradas en el manifest para --file=${fileSelector}`);
    }

    let restoredFiles = 0;
    let readyToRestore = 0;
    let skippedSourceMissing = 0;
    let skippedDestinationExists = 0;
    let skippedInvalidPaths = 0;
    let batchesExecuted = 0;

    for (const entry of selectedEntries) {
      const outcome =
        ctx.mode === 'execute'
          ? await restoreFile(entry)
          : await inspectRestoreEntry(entry);

      switch (outcome.status) {
        case 'ready_to_restore':
          readyToRestore += 1;
          pushExample(restoredExamples, outcome.detail);
          break;
        case 'restored':
          restoredFiles += 1;
          readyToRestore += 1;
          pushExample(restoredExamples, outcome.detail);
          break;
        case 'skipped_source_missing':
          skippedSourceMissing += 1;
          warnings.push(outcome.warning);
          break;
        case 'skipped_destination_exists':
          skippedDestinationExists += 1;
          warnings.push(outcome.warning);
          break;
        case 'skipped_invalid_quarantine_path':
        case 'skipped_invalid_destination_path':
          skippedInvalidPaths += 1;
          warnings.push(outcome.warning);
          break;
        default:
          warnings.push(`Estado inesperado durante restore: ${outcome.status}`);
          break;
      }
    }

    if (selectedEntries.length > 0) {
      batchesExecuted = 1;
    }

    const summary = createSummary(ctx, {
      scanned: manifest.entries.length,
      candidates: selectedEntries.length,
      affected: restoredFiles,
      batches_executed: batchesExecuted,
      warnings,
      source_run_id: quarantineRunId,
      file_selector: fileSelector || null,
      manifest_path: runPaths.manifestPath,
      upload_root: UPLOAD_ROOT,
      quarantine_root: QUARANTINE_ROOT,
      manifest_entries: manifest.entries.length,
      selected_entries: selectedEntries.length,
      ready_to_restore: readyToRestore,
      restored_files: restoredFiles,
      skipped_source_missing: skippedSourceMissing,
      skipped_destination_exists: skippedDestinationExists,
      skipped_invalid_paths: skippedInvalidPaths,
      restored_examples: restoredExamples,
      restore_strategy: 'copy_only_no_overwrite',
    });

    logJson(summary);
  } catch (error) {
    const summary = createSummary(ctx, {
      source_run_id: quarantineRunId,
      file_selector: fileSelector || null,
      manifest_path: runPaths.manifestPath,
      upload_root: UPLOAD_ROOT,
      quarantine_root: QUARANTINE_ROOT,
      errors: [errorToJson(error)],
      warnings: [],
    });
    logJson(summary);
    process.exitCode = 1;
  }
}

main();

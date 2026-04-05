const fs = require('fs');
const path = require('path');

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
  QUARANTINE_ROOT,
  UPLOAD_ROOT,
  buildOrphanQuarantineRunPaths,
  ensureDirectory,
  isWithinQuarantineRoot,
  isWithinUploadRoot,
  normalizeFsPath,
  relativeFrom,
  walkFilesRecursively,
} = require('./_attachments_common');

const JOB_NAME = 'attachments_quarantine_orphans';
const DEFAULT_ORPHAN_AGE_DAYS = 30;
const CANDIDATE_BATCH_SIZE = 100;
const MOVE_BATCH_SIZE = 25;
const EXAMPLE_LIMIT = 20;

function defaultCutoffDate() {
  return new Date(Date.now() - DEFAULT_ORPHAN_AGE_DAYS * 24 * 60 * 60 * 1000);
}

function pushExample(list, value) {
  if (list.length < EXAMPLE_LIMIT) {
    list.push(value);
  }
}

async function fetchMetadataReferencesForPaths(paths) {
  if (!paths.length) {
    return new Set();
  }

  const result = await pool.query(
    `SELECT ruta_archivo
     FROM incidencia_archivos
     WHERE ruta_archivo = ANY($1::text[])`,
    [paths]
  );

  return new Set(
    result.rows.map((row) => normalizeFsPath(row.ruta_archivo))
  );
}

async function hasMetadataReference(absolutePath) {
  const result = await pool.query(
    `SELECT id
     FROM incidencia_archivos
     WHERE lower(translate(ruta_archivo, '/', E'\\\\')) =
           lower(translate($1, '/', E'\\\\'))
     LIMIT 1`,
    [absolutePath]
  );
  return result.rows.length > 0;
}

async function detectOrphanCandidates(fileScan) {
  const orphanCandidates = [];
  let referencedMatches = 0;

  for (let index = 0; index < fileScan.files.length; index += CANDIDATE_BATCH_SIZE) {
    const batch = fileScan.files.slice(index, index + CANDIDATE_BATCH_SIZE);
    const references = await fetchMetadataReferencesForPaths(
      batch.map((file) => normalizeFsPath(file.absolute_path))
    );

    for (const file of batch) {
      const absolutePath = normalizeFsPath(file.absolute_path);
      if (references.has(absolutePath)) {
        referencedMatches += 1;
        continue;
      }
      orphanCandidates.push(file);
    }
  }

  return {
    orphanCandidates,
    referencedMatches,
  };
}

async function moveOrphanFile(file, runPaths, ctx) {
  const originalPath = normalizeFsPath(file.absolute_path);
  const relativePath = relativeFrom(UPLOAD_ROOT, originalPath);
  const quarantinePath = path.join(runPaths.filesRoot, relativePath);
  const quarantineDir = path.dirname(quarantinePath);

  if (!isWithinUploadRoot(originalPath)) {
    return {
      status: 'skipped_out_of_root',
      warning: `Archivo fuera de UPLOAD_ROOT omitido: ${originalPath}`,
    };
  }

  if (isWithinQuarantineRoot(originalPath)) {
    return {
      status: 'skipped_already_quarantined',
      warning: `Archivo ya ubicado en cuarentena omitido: ${originalPath}`,
    };
  }

  if (!fs.existsSync(originalPath)) {
    return {
      status: 'skipped_missing_before_move',
      warning: `Archivo faltante antes del movimiento: ${originalPath}`,
    };
  }

  const stillReferenced = await hasMetadataReference(originalPath);
  if (stillReferenced) {
    return {
      status: 'skipped_referenced_during_recheck',
      warning: `Referencia metadata detectada durante revalidacion: ${originalPath}`,
    };
  }

  await ensureDirectory(quarantineDir);
  await fs.promises.rename(originalPath, quarantinePath);

  const movedAt = new Date();
  return {
    status: 'moved',
    manifestEntry: {
      run_id: ctx.runId,
      reason: 'orphan_file_no_metadata_reference',
      moved_at: movedAt.toISOString(),
      original_absolute_path: originalPath,
      original_relative_path: relativePath,
      quarantine_absolute_path: quarantinePath,
      quarantine_relative_path: relativeFrom(UPLOAD_ROOT, quarantinePath),
      size_bytes: file.size_bytes,
      original_mtime: file.mtime.toISOString(),
    },
  };
}

async function writeManifest(manifestPath, manifest) {
  await ensureDirectory(path.dirname(manifestPath));
  await fs.promises.writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  );
}

async function main() {
  const args = parseArgs(process.argv);
  const ctx = createExecutionContext(JOB_NAME, {
    mode: args.mode,
    limit: resolveDeleteLimit(args.limit, 100),
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
    upload_root: UPLOAD_ROOT,
    quarantine_root: QUARANTINE_ROOT,
  });

  try {
    const warnings = [];
    const fileScan = await walkFilesRecursively(UPLOAD_ROOT, {
      cutoff: ctx.cutoff,
      limit: ctx.limit,
      excludeRoots: [QUARANTINE_ROOT],
    });

    if (fileScan.uploadRootMissing) {
      warnings.push(`UPLOAD_ROOT no existe: ${UPLOAD_ROOT}`);
    }
    if (fileScan.truncated) {
      warnings.push(`Exploracion parcial de disco: se alcanzo el limite de ${ctx.limit} archivos.`);
    }
    if (fileScan.skippedExcludedDirs > 0) {
      warnings.push(`Se excluyeron ${fileScan.skippedExcludedDirs} directorios de cuarentena del escaneo.`);
    }

    const { orphanCandidates, referencedMatches } = await detectOrphanCandidates(fileScan);

    const orphanExamples = orphanCandidates.slice(0, EXAMPLE_LIMIT).map((file) => ({
      absolute_path: normalizeFsPath(file.absolute_path),
      relative_path: file.relative_path,
      mtime: file.mtime.toISOString(),
      size_bytes: file.size_bytes,
    }));

    let quarantinedFiles = 0;
    let batchesExecuted = 0;
    let manifestPath = null;
    let skippedReferencedDuringRecheck = 0;
    let skippedMissingBeforeMove = 0;
    let skippedOutOfRoot = 0;
    let skippedAlreadyQuarantined = 0;
    const manifestEntries = [];

    if (ctx.mode === 'execute' && !isPruneEnabled()) {
      warnings.push('RETENTION_ENABLE_PRUNE != true; no se movieron archivos a cuarentena.');
    } else if (ctx.mode === 'execute' && orphanCandidates.length > 0) {
      const runPaths = buildOrphanQuarantineRunPaths(ctx.runId);
      manifestPath = runPaths.manifestPath;

      for (let index = 0; index < orphanCandidates.length; index += MOVE_BATCH_SIZE) {
        const batch = orphanCandidates.slice(index, index + MOVE_BATCH_SIZE);
        if (batch.length === 0) {
          continue;
        }
        batchesExecuted += 1;

        for (const file of batch) {
          const outcome = await moveOrphanFile(file, runPaths, ctx);
          switch (outcome.status) {
            case 'moved':
              quarantinedFiles += 1;
              manifestEntries.push(outcome.manifestEntry);
              break;
            case 'skipped_referenced_during_recheck':
              skippedReferencedDuringRecheck += 1;
              warnings.push(outcome.warning);
              break;
            case 'skipped_missing_before_move':
              skippedMissingBeforeMove += 1;
              warnings.push(outcome.warning);
              break;
            case 'skipped_out_of_root':
              skippedOutOfRoot += 1;
              warnings.push(outcome.warning);
              break;
            case 'skipped_already_quarantined':
              skippedAlreadyQuarantined += 1;
              warnings.push(outcome.warning);
              break;
            default:
              warnings.push(`Estado inesperado durante cuarentena: ${outcome.status}`);
              break;
          }
        }
      }

      if (manifestEntries.length > 0) {
        const manifest = {
          run_id: ctx.runId,
          job: JOB_NAME,
          mode: ctx.mode,
          cutoff_ts: ctx.cutoff.toISOString(),
          generated_at: new Date().toISOString(),
          upload_root: UPLOAD_ROOT,
          quarantine_root: QUARANTINE_ROOT,
          files_root: buildOrphanQuarantineRunPaths(ctx.runId).filesRoot,
          total_entries: manifestEntries.length,
          entries: manifestEntries,
        };
        await writeManifest(manifestPath, manifest);
      } else {
        manifestPath = null;
      }
    }

    const summary = createSummary(ctx, {
      scanned: fileScan.files.length,
      candidates: orphanCandidates.length,
      affected: quarantinedFiles,
      batches_executed: batchesExecuted,
      warnings,
      upload_root: UPLOAD_ROOT,
      quarantine_root: QUARANTINE_ROOT,
      manifest_path: manifestPath,
      scanned_files: fileScan.files.length,
      orphan_files: orphanCandidates.length,
      referenced_matches: referencedMatches,
      quarantined_files: quarantinedFiles,
      skipped_referenced_during_recheck: skippedReferencedDuringRecheck,
      skipped_missing_before_move: skippedMissingBeforeMove,
      skipped_out_of_root: skippedOutOfRoot,
      skipped_already_quarantined: skippedAlreadyQuarantined,
      skipped_excluded_dirs: fileScan.skippedExcludedDirs,
      upload_root_exists: !fileScan.uploadRootMissing,
      orphan_file_examples: orphanExamples,
      prune_enabled: isPruneEnabled(),
    });

    logJson(summary);
  } catch (error) {
    const summary = createSummary(ctx, {
      errors: [errorToJson(error)],
      warnings: [],
      upload_root: UPLOAD_ROOT,
      quarantine_root: QUARANTINE_ROOT,
    });
    logJson(summary);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

main();

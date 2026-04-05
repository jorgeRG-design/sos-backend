const pool = require('../../config/db');
const {
  createExecutionContext,
  createSummary,
  errorToJson,
  logJson,
  parseArgs,
  resolveScanLimit,
} = require('./_job_common');
const {
  QUARANTINE_ROOT,
  UPLOAD_ROOT,
  isWithinUploadRoot,
  normalizeFsPath,
  walkFilesRecursively,
} = require('./_attachments_common');

const JOB_NAME = 'attachments_reconcile_report';
const DEFAULT_SCAN_LIMIT = 10000;
const EXAMPLE_LIMIT = 20;

async function countDbRows(cutoff) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM incidencia_archivos
     WHERE fecha_subida <= $1`,
    [cutoff]
  );
  return Number(result.rows[0]?.total || 0);
}

async function fetchDbRows(cutoff, limit) {
  const result = await pool.query(
    `SELECT id, incidencia_id, ruta_archivo, activo, fecha_subida
     FROM incidencia_archivos
     WHERE fecha_subida <= $1
     ORDER BY fecha_subida ASC, id ASC
     LIMIT $2`,
    [cutoff, limit]
  );
  return result.rows;
}

function pushExample(list, value) {
  if (list.length < EXAMPLE_LIMIT) {
    list.push(value);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const ctx = createExecutionContext(JOB_NAME, {
    mode: args.mode,
    limit: resolveScanLimit(args.limit, DEFAULT_SCAN_LIMIT),
    cutoff: args.cutoff,
    defaultCutoff: new Date(),
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
  });

  try {
    const warnings = [];
    if (ctx.mode === 'execute') {
      warnings.push('attachments_reconcile_report es solo informativo; no modifica archivos ni metadata.');
    }

    const [totalDbRows, dbRows, fileScan] = await Promise.all([
      countDbRows(ctx.cutoff),
      fetchDbRows(ctx.cutoff, ctx.limit),
      walkFilesRecursively(UPLOAD_ROOT, {
        cutoff: ctx.cutoff,
        limit: ctx.limit,
        excludeRoots: [QUARANTINE_ROOT],
      }),
    ]);

    if (totalDbRows > dbRows.length) {
      warnings.push(
        `Exploracion parcial de metadata: ${dbRows.length}/${totalDbRows} filas dentro del cutoff.`
      );
    }
    if (fileScan.truncated) {
      warnings.push(`Exploracion parcial de disco: se alcanzo el limite de ${ctx.limit} archivos.`);
    }
    if (fileScan.uploadRootMissing) {
      warnings.push(`UPLOAD_ROOT no existe: ${UPLOAD_ROOT}`);
    }
    if (fileScan.skippedExcludedDirs > 0) {
      warnings.push(`Se excluyeron ${fileScan.skippedExcludedDirs} directorios de cuarentena del escaneo.`);
    }

    const referencedPaths = new Set();
    const activeMissingExamples = [];
    const inactiveMissingExamples = [];
    const outOfRootExamples = [];

    let activeRefs = 0;
    let inactiveRefs = 0;
    let missingFiles = 0;

    for (const row of dbRows) {
      const absolutePath = normalizeFsPath(row.ruta_archivo);
      const rowLabel = {
        id: row.id,
        incidencia_id: row.incidencia_id,
        ruta_archivo: row.ruta_archivo,
      };

      if (!isWithinUploadRoot(absolutePath)) {
        warnings.push(`Referencia fuera de UPLOAD_ROOT detectada en incidencia_archivos.id=${row.id}`);
        pushExample(outOfRootExamples, rowLabel);
        continue;
      }

      referencedPaths.add(absolutePath);

      if (row.activo) {
        activeRefs += 1;
      } else {
        inactiveRefs += 1;
      }

      if (!fs.existsSync(absolutePath)) {
        missingFiles += 1;
        if (row.activo) {
          pushExample(activeMissingExamples, rowLabel);
        } else {
          pushExample(inactiveMissingExamples, rowLabel);
        }
      }
    }

    const orphanFileExamples = [];
    let orphanFiles = 0;

    for (const file of fileScan.files) {
      const absolutePath = normalizeFsPath(file.absolute_path);
      if (!referencedPaths.has(absolutePath)) {
        orphanFiles += 1;
        pushExample(orphanFileExamples, {
          absolute_path: absolutePath,
          relative_path: file.relative_path,
          mtime: file.mtime.toISOString(),
          size_bytes: file.size_bytes,
        });
      }
    }

    const summary = createSummary(ctx, {
      scanned: dbRows.length + fileScan.files.length,
      candidates: missingFiles + orphanFiles,
      affected: 0,
      batches_executed: 0,
      warnings,
      scanned_db_rows: dbRows.length,
      scanned_files: fileScan.files.length,
      active_refs: activeRefs,
      inactive_refs: inactiveRefs,
      missing_files: missingFiles,
      orphan_files: orphanFiles,
      upload_root: UPLOAD_ROOT,
      quarantine_root: QUARANTINE_ROOT,
      upload_root_exists: !fileScan.uploadRootMissing,
      skipped_excluded_dirs: fileScan.skippedExcludedDirs,
      metadata_rows_total_before_limit: totalDbRows,
      missing_file_examples_active: activeMissingExamples,
      missing_file_examples_inactive: inactiveMissingExamples,
      orphan_file_examples: orphanFileExamples,
      out_of_root_examples: outOfRootExamples,
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

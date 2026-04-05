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

const JOB_NAME = 'audit_events_archive_rollover';
const HOT_TABLE = 'public.auditoria_eventos';
const ARCHIVE_TABLE = 'public.auditoria_eventos_archive';
const DEFAULT_HOT_RETENTION_DAYS = 365;

function defaultCutoffDate() {
  return new Date(Date.now() - DEFAULT_HOT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

async function archiveTableExists(client) {
  const result = await client.query(
    `SELECT to_regclass($1) AS table_name`,
    [ARCHIVE_TABLE]
  );
  return Boolean(result.rows[0]?.table_name);
}

async function fetchCandidateStats(client, cutoff, limit) {
  const totals = await client.query(
    `SELECT COUNT(*)::int AS total
     FROM ${HOT_TABLE}
     WHERE creado_en < $1`,
    [cutoff]
  );

  const sample = await client.query(
    `SELECT id, creado_en
     FROM ${HOT_TABLE}
     WHERE creado_en < $1
     ORDER BY creado_en ASC, id ASC
     LIMIT $2`,
    [cutoff, limit]
  );

  const rows = sample.rows;
  return {
    totalCandidates: Number(totals.rows[0]?.total || 0),
    rowsCandidate: rows.length,
    candidateIds: rows.map((row) => Number(row.id)),
    minCreadoEn: rows[0]?.creado_en || null,
    maxCreadoEn: rows[rows.length - 1]?.creado_en || null,
  };
}

async function executeArchive(client, candidateIds) {
  const insertResult = await client.query(
    `INSERT INTO ${ARCHIVE_TABLE} (
       id,
       actor_uid,
       actor_identificador,
       actor_rol,
       actor_tipo,
       accion,
       objeto_tipo,
       objeto_id,
       resultado,
       detalle,
       ip_origen,
       user_agent,
       canal,
       metadata,
       creado_en,
       archived_at
     )
     SELECT
       id,
       actor_uid,
       actor_identificador,
       actor_rol,
       actor_tipo,
       accion,
       objeto_tipo,
       objeto_id,
       resultado,
       detalle,
       ip_origen,
       user_agent,
       canal,
       metadata,
       creado_en,
       NOW()
     FROM ${HOT_TABLE}
     WHERE id = ANY($1::bigint[])
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [candidateIds]
  );

  const deleteResult = await client.query(
    `DELETE FROM ${HOT_TABLE}
     WHERE id = ANY($1::bigint[])
     RETURNING id`,
    [candidateIds]
  );

  return {
    rowsArchived: insertResult.rowCount,
    rowsDeletedFromHot: deleteResult.rowCount,
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
    archive_table: ARCHIVE_TABLE,
  });

  const client = await pool.connect();
  try {
    const warnings = [];
    const archiveExists = await archiveTableExists(client);
    const stats = await fetchCandidateStats(client, ctx.cutoff, ctx.limit);

    if (!archiveExists) {
      warnings.push(
        `La tabla ${ARCHIVE_TABLE} no existe. Aplique primero la migracion propuesta antes de ejecutar el rollover.`
      );
    }
    if (stats.totalCandidates > stats.rowsCandidate) {
      warnings.push(
        `Se procesara una ventana parcial: ${stats.rowsCandidate}/${stats.totalCandidates} filas candidatas dentro del cutoff.`
      );
    }

    let rowsArchived = 0;
    let rowsDeletedFromHot = 0;
    let batchesExecuted = 0;

    if (ctx.mode === 'execute' && !isPruneEnabled()) {
      warnings.push('RETENTION_ENABLE_PRUNE != true; no se movieron filas a archivo.');
    } else if (ctx.mode === 'execute' && !archiveExists) {
      warnings.push('Ejecucion omitida porque la tabla de archivo no existe.');
    } else if (ctx.mode === 'execute' && stats.candidateIds.length > 0) {
      await client.query('BEGIN');
      const execution = await executeArchive(client, stats.candidateIds);
      await client.query('COMMIT');
      rowsArchived = execution.rowsArchived;
      rowsDeletedFromHot = execution.rowsDeletedFromHot;
      batchesExecuted = 1;
    }

    const summary = createSummary(ctx, {
      scanned: stats.rowsCandidate,
      candidates: stats.rowsCandidate,
      affected: rowsDeletedFromHot,
      batches_executed: batchesExecuted,
      warnings,
      archive_table: ARCHIVE_TABLE,
      archive_table_exists: archiveExists,
      rows_candidate: stats.rowsCandidate,
      total_candidates_before_limit: stats.totalCandidates,
      rows_archived: rowsArchived,
      rows_deleted_from_hot: rowsDeletedFromHot,
      min_creado_en:
        stats.minCreadoEn instanceof Date
          ? stats.minCreadoEn.toISOString()
          : null,
      max_creado_en:
        stats.maxCreadoEn instanceof Date
          ? stats.maxCreadoEn.toISOString()
          : null,
      prune_enabled: isPruneEnabled(),
    });

    logJson(summary);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    const summary = createSummary(ctx, {
      errors: [errorToJson(error)],
      warnings: [],
      archive_table: ARCHIVE_TABLE,
    });
    logJson(summary);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
}

main();

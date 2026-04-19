/**
 * mapaDelitoController.js
 * Produce estadísticas por zona para el Mapa del Delito.
 * Dos fuentes separadas: CEMVI (incidencias) y PNP (incidencias_pnp).
 */

const db = require('../config/db');
const { sendOk, sendError } = require('../utils/apiResponse');

function parseFiltros(query) {
  const { fechaInicio, fechaFin, zonaId } = query;
  return {
    fechaInicio: fechaInicio || null,
    fechaFin:    fechaFin    || null,
    zonaId:      zonaId ? parseInt(zonaId, 10) : null,
  };
}

/**
 * GET /api/mapa-delito/cemvi
 * Incidencias del sistema CEMVI agrupadas por zona.
 * Devuelve:
 *   - zonas: lista de zonas con total y top5 tipos de delito
 *   - total_global
 */
async function estadisticasCemvi(req, res) {
  try {
    const { fechaInicio, fechaFin, zonaId } = parseFiltros(req.query);

    const conditions = [`i.estado = 'resuelta'`];
    const params = [];

    if (fechaInicio) {
      params.push(fechaInicio);
      conditions.push(`i.fecha_creacion >= $${params.length}::date`);
    }
    if (fechaFin) {
      params.push(fechaFin);
      conditions.push(`i.fecha_creacion < ($${params.length}::date + INTERVAL '1 day')`);
    }
    if (zonaId) {
      params.push(zonaId);
      conditions.push(`i.sector_id = $${params.length}`);
    }

    const where = conditions.join(' AND ');

    // Totales por zona
    const { rows: zonas } = await db.query(
      `SELECT
         i.sector_id                         AS zona_id,
         COALESCE(i.sector_nombre, 'Sin zona') AS zona_nombre,
         COUNT(*)::int                        AS total
       FROM public.incidencias i
       WHERE ${where}
         AND i.sector_id IS NOT NULL
       GROUP BY i.sector_id, i.sector_nombre
       ORDER BY total DESC`,
      params
    );

    // Top 5 tipos por zona (usando tipologia_tipo o tipo)
    const zonaIds = zonas.map(z => z.zona_id).filter(Boolean);
    const top5Map = {};

    if (zonaIds.length > 0) {
      const top5Params = [zonaIds];
      const top5Cond = [];
      if (fechaInicio) { top5Params.push(fechaInicio); top5Cond.push(`AND fecha_creacion >= $${top5Params.length}::date`); }
      if (fechaFin)    { top5Params.push(fechaFin);    top5Cond.push(`AND fecha_creacion < ($${top5Params.length}::date + INTERVAL '1 day')`); }

      const { rows: top5 } = await db.query(
        `SELECT
           sector_id AS zona_id,
           COALESCE(tipologia_tipo, tipo, 'Sin clasificar') AS tipo_nombre,
           COUNT(*)::int AS cantidad
         FROM public.incidencias
         WHERE estado = 'resuelta'
           AND sector_id = ANY($1)
           ${top5Cond.join('\n           ')}
         GROUP BY sector_id, tipo_nombre
         ORDER BY sector_id, cantidad DESC`,
        top5Params
      );

      for (const row of top5) {
        if (!top5Map[row.zona_id]) top5Map[row.zona_id] = [];
        if (top5Map[row.zona_id].length < 5) {
          top5Map[row.zona_id].push({ tipo: row.tipo_nombre, cantidad: row.cantidad });
        }
      }
    }

    const resultado = zonas.map(z => ({
      ...z,
      top5_tipos: top5Map[z.zona_id] || [],
    }));

    const total_global = resultado.reduce((s, z) => s + z.total, 0);

    return sendOk(res, { data: { fuente: 'CEMVI', zonas: resultado, total_global } });
  } catch (err) {
    console.error('[mapaDelitoController.estadisticasCemvi]', err);
    return sendError(res, { status: 500, code: 'mapa_delito_cemvi_error', message: err.message });
  }
}

/**
 * GET /api/mapa-delito/pnp
 * Incidencias PNP agrupadas por zona.
 */
async function estadisticasPnp(req, res) {
  try {
    const { fechaInicio, fechaFin, zonaId } = parseFiltros(req.query);
    const { lote } = req.query;

    const conditions = ['1=1'];
    const params = [];

    if (fechaInicio) {
      params.push(fechaInicio);
      conditions.push(`p.fecha_ocurrencia >= $${params.length}::date`);
    }
    if (fechaFin) {
      params.push(fechaFin);
      conditions.push(`p.fecha_ocurrencia <= $${params.length}::date`);
    }
    if (zonaId) {
      params.push(zonaId);
      conditions.push(`p.zona_id = $${params.length}`);
    }
    if (lote) {
      params.push(lote);
      conditions.push(`p.lote_carga = $${params.length}`);
    }

    const where = conditions.join(' AND ');

    // Totales por zona
    const { rows: zonas } = await db.query(
      `SELECT
         p.zona_id,
         COALESCE(p.zona_nombre, 'Sin zona') AS zona_nombre,
         COUNT(*)::int                         AS total
       FROM public.incidencias_pnp p
       WHERE ${where}
         AND p.zona_id IS NOT NULL
       GROUP BY p.zona_id, p.zona_nombre
       ORDER BY total DESC`,
      params
    );

    const zonaIds = zonas.map(z => z.zona_id).filter(Boolean);
    const top5Map = {};

    if (zonaIds.length > 0) {
      const top5Params = [zonaIds];
      const top5Cond = [];
      if (fechaInicio) { top5Params.push(fechaInicio); top5Cond.push(`AND fecha_ocurrencia >= $${top5Params.length}::date`); }
      if (fechaFin)    { top5Params.push(fechaFin);    top5Cond.push(`AND fecha_ocurrencia <= $${top5Params.length}::date`); }
      if (lote)        { top5Params.push(lote);         top5Cond.push(`AND lote_carga = $${top5Params.length}`); }

      const { rows: top5 } = await db.query(
        `SELECT
           zona_id,
           nivel3_nombre AS tipo_nombre,
           COUNT(*)::int AS cantidad
         FROM public.incidencias_pnp
         WHERE zona_id = ANY($1)
           ${top5Cond.join('\n           ')}
         GROUP BY zona_id, nivel3_nombre
         ORDER BY zona_id, cantidad DESC`,
        top5Params
      );

      for (const row of top5) {
        if (!top5Map[row.zona_id]) top5Map[row.zona_id] = [];
        if (top5Map[row.zona_id].length < 5) {
          top5Map[row.zona_id].push({ tipo: row.tipo_nombre, cantidad: row.cantidad });
        }
      }
    }

    const resultado = zonas.map(z => ({
      ...z,
      top5_tipos: top5Map[z.zona_id] || [],
    }));

    const total_global = resultado.reduce((s, z) => s + z.total, 0);

    return sendOk(res, { data: { fuente: 'PNP', zonas: resultado, total_global } });
  } catch (err) {
    console.error('[mapaDelitoController.estadisticasPnp]', err);
    return sendError(res, { status: 500, code: 'mapa_delito_pnp_error', message: err.message });
  }
}

module.exports = { estadisticasCemvi, estadisticasPnp };

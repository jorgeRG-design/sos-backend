/**
 * pnpController.js
 * Carga de datos PNP desde Excel.
 * Los registros se almacenan en `incidencias_pnp`, separados del sistema CEMVI.
 * La zona se asigna automáticamente via PostGIS.
 */

const db = require('../config/db');
const { sendOk, sendError } = require('../utils/apiResponse');
const zonificacionService = require('../services/zonificacionService');
// Columnas esperadas (índice 0-based). El Excel puede tener encabezados en fila 1.
const COL = {
  FECHA:        0,
  HORA:         1,
  NIVEL1_COD:   2,
  NIVEL1_NOM:   3,
  NIVEL2_COD:   4,
  NIVEL2_NOM:   5,
  NIVEL3_COD:   6,
  NIVEL3_NOM:   7,
  LATITUD:      8,
  LONGITUD:     9,
  DIRECCION:    10,
  DISTRITO:     11,
  COMISARIA:    12,
  DESCRIPCION:  13,
};

function parseFecha(raw) {
  if (!raw) return null;
  const s = String(raw).trim();

  // Formato dd/mm/yyyy o dd-mm-yyyy
  const match = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (match) {
    const [, d, m, y] = match;
    return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
  }
  // ISO o similar
  const d = new Date(s);
  if (!isNaN(d)) return d.toISOString().substring(0, 10);
  return null;
}

function parseHora(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const match = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (match) {
    const [, h, m, sec] = match;
    return `${h.padStart(2,'0')}:${m}:${sec ?? '00'}`;
  }
  return null;
}

function parseNum(raw) {
  if (raw == null) return null;
  const n = parseFloat(String(raw).replace(',', '.'));
  return isNaN(n) ? null : n;
}

function celda(row, col) {
  const cell = row?.[col];
  if (cell == null) return null;
  const v = cell?.v ?? cell;
  return v != null ? String(v).trim() || null : null;
}

/**
 * POST /api/pnp/importar
 * Body: { registros: [...], nombreArchivo: string }
 * El frontend parsea el Excel y envía los registros como JSON.
 */
async function importarDesdeExcel(req, res) {
  try {
    const { registros, nombreArchivo, lote } = req.body ?? {};
    if (!Array.isArray(registros) || registros.length === 0) {
      return sendError(res, {
        status: 400,
        code: 'registros_vacios',
        message: 'Se requiere el campo "registros" con al menos un elemento.'
      });
    }
    if (registros.length > 5000) {
      return sendError(res, {
        status: 400,
        code: 'registros_exceden_limite',
        message: 'El archivo no puede superar 5 000 registros por lote.'
      });
    }

    const loteId = lote || `PNP-${Date.now()}`;
    const usuario = req.actor?.email || req.actor?.uid || 'sistema';

    let insertados = 0;
    let errores = 0;
    const detalleErrores = [];

    for (let i = 0; i < registros.length; i++) {
      const row = registros[i];
      try {
        const nivel3Nombre = String(row.nivel3_nombre || row[COL.NIVEL3_NOM] || '').trim();
        if (!nivel3Nombre) {
          detalleErrores.push({ fila: i + 1, error: 'nivel3_nombre vacío.' });
          errores++;
          continue;
        }

        const lat = parseNum(row.latitud ?? row[COL.LATITUD]);
        const lng = parseNum(row.longitud ?? row[COL.LONGITUD]);

        // Asignación automática de zona via PostGIS
        const zona = (lat != null && lng != null)
          ? await zonificacionService.detectarZona(lat, lng)
          : null;

        const fecha = parseFecha(row.fecha_ocurrencia ?? row[COL.FECHA]);
        const hora  = parseHora(row.hora_ocurrencia  ?? row[COL.HORA]);

        await db.query(
          `INSERT INTO public.incidencias_pnp (
             nivel1_codigo, nivel1_nombre,
             nivel2_codigo, nivel2_nombre,
             nivel3_codigo, nivel3_nombre,
             codigo_tipo,
             fecha_ocurrencia, hora_ocurrencia,
             latitud, longitud,
             geom,
             zona_id, zona_nombre,
             direccion, distrito, descripcion,
             comisaria,
             archivo_origen, lote_carga, usuario_carga
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,
             $8,$9,$10,$11,
             CASE WHEN $10 IS NOT NULL AND $11 IS NOT NULL
               THEN ST_SetSRID(ST_MakePoint($11,$10), 4326)
               ELSE NULL
             END,
             $12,$13,$14,$15,$16,$17,$18,$19,$20
           )`,
          [
            row.nivel1_codigo || row[COL.NIVEL1_COD] || null,
            row.nivel1_nombre || row[COL.NIVEL1_NOM] || null,
            row.nivel2_codigo || row[COL.NIVEL2_COD] || null,
            row.nivel2_nombre || row[COL.NIVEL2_NOM] || null,
            row.nivel3_codigo || row[COL.NIVEL3_COD] || null,
            nivel3Nombre,
            row.codigo_tipo || null,
            fecha, hora,
            lat, lng,
            zona?.zona_id   || null,
            zona?.zona_nombre || null,
            row.direccion || row[COL.DIRECCION] || null,
            row.distrito  || row[COL.DISTRITO]  || null,
            row.descripcion || row[COL.DESCRIPCION] || null,
            row.comisaria || row[COL.COMISARIA] || null,
            nombreArchivo || null,
            loteId,
            usuario,
          ]
        );
        insertados++;
      } catch (err) {
        detalleErrores.push({ fila: i + 1, error: err.message });
        errores++;
      }
    }

    return sendOk(res, {
      data: { lote: loteId, insertados, errores, detalleErrores }
    });
  } catch (err) {
    console.error('[pnpController.importarDesdeExcel]', err);
    return sendError(res, { status: 500, code: 'pnp_import_error', message: err.message });
  }
}

/**
 * GET /api/pnp/lotes
 * Lista los lotes de carga disponibles.
 */
async function listarLotes(req, res) {
  try {
    const { rows } = await db.query(
      `SELECT
         lote_carga,
         COUNT(*)::int       AS total,
         MIN(fecha_carga)    AS primera_carga,
         MIN(fecha_ocurrencia) AS desde,
         MAX(fecha_ocurrencia) AS hasta
       FROM public.incidencias_pnp
       GROUP BY lote_carga
       ORDER BY primera_carga DESC
       LIMIT 50`
    );
    return sendOk(res, { data: rows });
  } catch (err) {
    console.error('[pnpController.listarLotes]', err);
    return sendError(res, { status: 500, code: 'pnp_lotes_error', message: 'Error listando lotes PNP.' });
  }
}

module.exports = { importarDesdeExcel, listarLotes };

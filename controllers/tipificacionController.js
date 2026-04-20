/**
 * tipificacionController.js
 * Controlador de tipificación jerárquica (nivel1 / nivel2 / nivel3).
 * Tabla: public.tipificacion
 */

const db = require('../config/db');
const { sendOk, sendError } = require('../utils/apiResponse');

// ─── GET /api/tipificacion ────────────────────────────────────────────────────
// Lista completa, con filtros opcionales por nivel1, nivel2, nivel3 y búsqueda
// libre (q) que busca dentro de nivel3.
async function listar(req, res) {
  try {
    const { nivel1, nivel2, nivel3, q } = req.query;
    const conditions = ['activo = TRUE'];
    const params = [];

    if (nivel1) {
      params.push(nivel1);
      conditions.push(`nivel1 = $${params.length}`);
    }
    if (nivel2) {
      params.push(nivel2);
      conditions.push(`nivel2 = $${params.length}`);
    }
    if (nivel3) {
      params.push(nivel3);
      conditions.push(`nivel3 = $${params.length}`);
    }
    if (q) {
      params.push(`%${q.trim()}%`);
      conditions.push(`(nivel3 ILIKE $${params.length} OR descripcion ILIKE $${params.length})`);
    }

    const { rows } = await db.query(
      `SELECT id, nivel1, nivel2, nivel3, descripcion, codigo_autogenerado, orden
       FROM public.tipificacion
       WHERE ${conditions.join(' AND ')}
       ORDER BY orden NULLS LAST, nivel1, nivel2, nivel3
       LIMIT 500`,
      params
    );

    return sendOk(res, { data: rows });
  } catch (err) {
    console.error('[tipificacionController.listar]', err);
    return sendError(res, {
      status: 500,
      code: 'tipificacion_list_error',
      message: 'Error consultando tipificación.',
    });
  }
}

// ─── GET /api/tipificacion/buscar?q= ─────────────────────────────────────────
// Busca por texto libre en nivel3 y descripcion.
// Devuelve el registro completo (nivel1, nivel2, nivel3, descripcion) para que
// el frontend pueda autocompletar los niveles superiores automáticamente.
async function buscar(req, res) {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) {
      return sendOk(res, { data: [] });
    }

    const { rows } = await db.query(
      `SELECT id, nivel1, nivel2, nivel3, descripcion, codigo_autogenerado
       FROM public.tipificacion
       WHERE activo = TRUE
         AND (nivel3 ILIKE $1 OR descripcion ILIKE $1)
       ORDER BY nivel1, nivel2, nivel3
       LIMIT 50`,
      [`%${q}%`]
    );

    return sendOk(res, { data: rows });
  } catch (err) {
    console.error('[tipificacionController.buscar]', err);
    return sendError(res, {
      status: 500,
      code: 'tipificacion_buscar_error',
      message: 'Error en búsqueda de tipificación.',
    });
  }
}

// ─── GET /api/tipificacion/nivel1 ────────────────────────────────────────────
// Lista los valores únicos de nivel1, ordenados alfabéticamente.
async function listarNivel1(req, res) {
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT nivel1
       FROM public.tipificacion
       WHERE activo = TRUE
       ORDER BY nivel1`
    );
    return sendOk(res, { data: rows.map((r) => r.nivel1) });
  } catch (err) {
    console.error('[tipificacionController.listarNivel1]', err);
    return sendError(res, {
      status: 500,
      code: 'nivel1_list_error',
      message: 'Error listando nivel1.',
    });
  }
}

// ─── GET /api/tipificacion/nivel2?nivel1= ────────────────────────────────────
// Lista los valores únicos de nivel2, opcionalmente filtrados por nivel1.
async function listarNivel2(req, res) {
  try {
    const { nivel1 } = req.query;
    const conditions = ['activo = TRUE'];
    const params = [];

    if (nivel1) {
      params.push(nivel1);
      conditions.push(`nivel1 = $${params.length}`);
    }

    const { rows } = await db.query(
      `SELECT DISTINCT nivel1, nivel2
       FROM public.tipificacion
       WHERE ${conditions.join(' AND ')}
       ORDER BY nivel1, nivel2`,
      params
    );

    return sendOk(res, { data: rows });
  } catch (err) {
    console.error('[tipificacionController.listarNivel2]', err);
    return sendError(res, {
      status: 500,
      code: 'nivel2_list_error',
      message: 'Error listando nivel2.',
    });
  }
}

// ─── GET /api/tipificacion/nivel3?nivel2= ────────────────────────────────────
// Lista los valores únicos de nivel3, opcionalmente filtrados por nivel2
// (y nivel1 si se provee).
async function listarNivel3(req, res) {
  try {
    const { nivel1, nivel2 } = req.query;
    const conditions = ['activo = TRUE'];
    const params = [];

    if (nivel1) {
      params.push(nivel1);
      conditions.push(`nivel1 = $${params.length}`);
    }
    if (nivel2) {
      params.push(nivel2);
      conditions.push(`nivel2 = $${params.length}`);
    }

    const { rows } = await db.query(
      `SELECT id, nivel1, nivel2, nivel3, descripcion, codigo_autogenerado
       FROM public.tipificacion
       WHERE ${conditions.join(' AND ')}
       ORDER BY nivel3`,
      params
    );

    return sendOk(res, { data: rows });
  } catch (err) {
    console.error('[tipificacionController.listarNivel3]', err);
    return sendError(res, {
      status: 500,
      code: 'nivel3_list_error',
      message: 'Error listando nivel3.',
    });
  }
}

module.exports = { listar, buscar, listarNivel1, listarNivel2, listarNivel3 };

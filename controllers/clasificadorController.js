/**
 * clasificadorController.js
 * Endpoint legacy GET /api/clasificador-incidencias.
 * Ahora sirve datos desde la nueva tabla `tipificacion`.
 * Se mantiene para compatibilidad con clientes que aún usen esta ruta.
 */

const pool = require('../config/db');
const { sendOk, sendError } = require('../utils/apiResponse');

exports.listarClasificadorIncidencias = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, nivel1, nivel2, nivel3, descripcion, codigo_autogenerado, activo, orden
       FROM public.tipificacion
       WHERE activo = TRUE
       ORDER BY nivel1, nivel2, nivel3`
    );
    return sendOk(res, { data: result.rows });
  } catch (error) {
    console.error('[clasificadorController]', error);
    return sendError(res, {
      status: 500,
      code: 'clasificador_query_failed',
      message: 'Error interno del servidor',
    });
  }
};

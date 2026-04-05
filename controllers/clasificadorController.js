const pool = require('../config/db');
const { sendOk, sendError } = require('../utils/apiResponse');

exports.listarClasificadorIncidencias = async (req, res) => {
  try {
    const result = await pool.query(
      `
        SELECT *
        FROM clasificador_incidencias
        ORDER BY modalidad_codigo, subtipo_codigo, tipo_codigo
      `
    );

    return sendOk(res, { data: result.rows });
  } catch (error) {
    console.error('Error al consultar clasificador_incidencias:', error);
    return sendError(res, {
      status: 500,
      code: 'clasificador_query_failed',
      message: 'Error interno del servidor'
    });
  }
};

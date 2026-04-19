/**
 * zonasController.js
 * CRUD mínimo de zonas + importación desde GeoJSON.
 */

const { sendOk, sendError } = require('../utils/apiResponse');
const zonificacionService = require('../services/zonificacionService');

async function listarZonas(req, res) {
  try {
    const zonas = await zonificacionService.listarZonas();
    return sendOk(res, { data: zonas });
  } catch (err) {
    console.error('[zonasController.listarZonas]', err);
    return sendError(res, { status: 500, code: 'zonas_list_error', message: 'Error listando zonas.' });
  }
}

async function importarDesdeGeoJSON(req, res) {
  try {
    const geojson = req.body;
    if (!geojson || geojson.type !== 'FeatureCollection') {
      return sendError(res, {
        status: 400,
        code: 'geojson_invalido',
        message: 'Se esperaba un GeoJSON de tipo FeatureCollection en el cuerpo.'
      });
    }

    const resultado = await zonificacionService.importarZonasDesdeGeoJSON(geojson);
    return sendOk(res, { data: resultado });
  } catch (err) {
    console.error('[zonasController.importarDesdeGeoJSON]', err);
    return sendError(res, { status: 500, code: 'geojson_import_error', message: err.message });
  }
}

module.exports = { listarZonas, importarDesdeGeoJSON };

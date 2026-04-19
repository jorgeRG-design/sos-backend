/**
 * zonificacionService.js
 * Asigna zonas a puntos geográficos usando PostGIS (ST_Contains).
 * Toda la lógica spatial reside en la base de datos — sin hardcodeo.
 */

const db = require('../config/db');

/**
 * Dado un par latitud/longitud devuelve { zona_id, zona_nombre } o null.
 * Usa la función fn_zona_para_punto definida en la migración 015.
 */
async function detectarZona(lat, lng) {
  if (lat == null || lng == null) return null;

  const { rows } = await db.query(
    'SELECT zona_id, zona_nombre FROM public.fn_zona_para_punto($1, $2)',
    [lat, lng]
  );

  if (rows.length === 0) return null;
  return { zona_id: rows[0].zona_id, zona_nombre: rows[0].zona_nombre };
}

/**
 * Importa zonas desde un FeatureCollection GeoJSON.
 * Hace upsert por nombre de zona.
 * Devuelve { insertadas, actualizadas, errores }.
 */
async function importarZonasDesdeGeoJSON(geojson) {
  const features = geojson?.features;
  if (!Array.isArray(features)) {
    throw new Error('GeoJSON inválido: se esperaba un FeatureCollection con features.');
  }

  let insertadas = 0;
  let actualizadas = 0;
  const errores = [];

  for (const feature of features) {
    try {
      const props = feature?.properties ?? {};
      const nombre =
        props.sector_nombre || props.sector || props.nombre || props.name;
      const codigo = String(
        props.sector_id ?? props.codigo ?? props.id ?? ''
      ).trim();
      const color = props.color_hex || null;

      if (!nombre) {
        errores.push({ feature, mensaje: 'Feature sin nombre de zona.' });
        continue;
      }

      const geomJson = JSON.stringify(feature.geometry);

      const { rows } = await db.query(
        `INSERT INTO public.zonas (nombre, codigo, color_hex, geom)
         VALUES (
           $1, $2, $3,
           ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($4), 4326))
         )
         ON CONFLICT ON CONSTRAINT uq_zonas_nombre
         DO UPDATE SET
           codigo    = EXCLUDED.codigo,
           color_hex = COALESCE(EXCLUDED.color_hex, zonas.color_hex),
           geom      = EXCLUDED.geom,
           updated_at = NOW()
         RETURNING (xmax = 0) AS es_nueva`,
        [nombre, codigo || null, color, geomJson]
      );

      if (rows[0]?.es_nueva) insertadas++;
      else actualizadas++;
    } catch (err) {
      errores.push({ feature, mensaje: err.message });
    }
  }

  return { insertadas, actualizadas, errores };
}

/**
 * Lista todas las zonas activas con su geometría como GeoJSON.
 */
async function listarZonas() {
  const { rows } = await db.query(
    `SELECT
       id, nombre, codigo, descripcion, color_hex, activo,
       ST_AsGeoJSON(geom)::json AS geometry
     FROM public.zonas
     WHERE activo = TRUE
     ORDER BY id`
  );
  return rows;
}

module.exports = { detectarZona, importarZonasDesdeGeoJSON, listarZonas };

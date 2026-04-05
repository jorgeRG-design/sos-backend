-- Auditoria segura (solo lectura) del esquema usado por incidencias.
-- No modifica datos ni estructura.

-- 1) Tablas existentes en el esquema publico.
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;

-- 2) Columnas reales de la tabla incidencias.
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'incidencias'
ORDER BY ordinal_position;

-- 3) Cantidad de registros por tabla relacionada.
SELECT 'incidencias' AS tabla, COUNT(*)::int AS total FROM incidencias
UNION ALL
SELECT 'incidencia_personas' AS tabla, COUNT(*)::int AS total FROM incidencia_personas
UNION ALL
SELECT 'incidencia_apoyo_pnp' AS tabla, COUNT(*)::int AS total FROM incidencia_apoyo_pnp
UNION ALL
SELECT 'recorridos_gps' AS tabla, COUNT(*)::int AS total FROM recorridos_gps
UNION ALL
SELECT 'ticket_contadores' AS tabla, COUNT(*)::int AS total FROM ticket_contadores;

-- 4) Uso de columnas clave y columnas candidatas a revision.
SELECT
  COUNT(*) AS total,
  COUNT(ticket_serie) AS con_ticket_serie,
  COUNT(tipo_patrullaje) AS con_tipo_patrullaje,
  COUNT(tipo_zona) AS con_tipo_zona,
  COUNT(nombre_zona) AS con_nombre_zona,
  COUNT(sector_patrullaje) AS con_sector_patrullaje,
  COUNT(datos_importantes) AS con_datos_importantes,
  COUNT(desarrollo_hechos) AS con_desarrollo_hechos,
  COUNT(descripcion) AS con_descripcion,
  COUNT(detalle_preliminar) AS con_detalle_preliminar,
  COUNT(usuario) AS con_usuario,
  COUNT(operador_registro) AS con_operador_registro,
  COUNT(efectivo_asignado_dni) AS con_efectivo_asignado_dni,
  COUNT(efectivo_asignado_nombre) AS con_efectivo_asignado_nombre
FROM incidencias;

-- 5) Distinguir entre NULL y cadena vacia en columnas legadas.
SELECT
  COUNT(*) FILTER (WHERE TRIM(COALESCE(tipo_zona, '')) <> '') AS tipo_zona_no_vacio,
  COUNT(*) FILTER (WHERE TRIM(COALESCE(nombre_zona, '')) <> '') AS nombre_zona_no_vacio,
  COUNT(*) FILTER (WHERE TRIM(COALESCE(sector_patrullaje, '')) <> '') AS sector_patrullaje_no_vacio,
  COUNT(*) FILTER (WHERE TRIM(COALESCE(ticket_serie, '')) <> '') AS ticket_serie_no_vacio,
  COUNT(*) FILTER (WHERE TRIM(COALESCE(pnp_grado, '')) <> '') AS pnp_grado_no_vacio,
  COUNT(*) FILTER (WHERE TRIM(COALESCE(pnp_apellidos_nombres, '')) <> '') AS pnp_apellidos_nombres_no_vacio
FROM incidencias;

const pool = require('../config/db');
const { sendOk, sendError } = require('../utils/apiResponse');

function textoNoVacio(value) {
  if (value == null) return '';
  const text = String(value).trim();
  return text || '';
}

function tipoSqlExpr(alias) {
  return `COALESCE(
    NULLIF(TRIM(${alias}.tipo), ''),
    NULLIF(TRIM(${alias}.tipologia_tipo), ''),
    'Sin clasificar'
  )`;
}

function fuenteSqlExpr(alias) {
  return `COALESCE(NULLIF(TRIM(${alias}.fuente), ''), 'Sin fuente')`;
}

function minutosResolucionSqlExpr(alias) {
  return `COALESCE(
    ${alias}.minutos_totales::float,
    CASE
      WHEN ${alias}.fecha_cierre IS NOT NULL AND ${alias}.fecha IS NOT NULL
      THEN EXTRACT(EPOCH FROM (${alias}.fecha_cierre - ${alias}.fecha)) / 60.0
      ELSE NULL
    END
  )`;
}

function buildReportScope({
  fechaInicio,
  fechaFin,
  tipoDelito,
  fuente,
  operativoId,
  includeTipoFilter = true,
  includeFuenteFilter = true,
  includeOperativoFilter = true
}) {
  const params = [fechaInicio, fechaFin];
  let paramIndex = 3;
  const where = ['i.fecha::date BETWEEN $1::date AND $2::date'];

  if (includeTipoFilter && textoNoVacio(tipoDelito)) {
    where.push(`${tipoSqlExpr('i')} = $${paramIndex}`);
    params.push(textoNoVacio(tipoDelito));
    paramIndex += 1;
  }

  if (includeFuenteFilter && textoNoVacio(fuente)) {
    where.push(`${fuenteSqlExpr('i')} = $${paramIndex}`);
    params.push(textoNoVacio(fuente));
    paramIndex += 1;
  }

  let operativeFilterSql = '';
  if (includeOperativoFilter && textoNoVacio(operativoId)) {
    operativeFilterSql = `
      AND EXISTS (
        SELECT 1
        FROM operativos_base oper_sel
        WHERE oper_sel.incidencia_id = bi.id
          AND (
            oper_sel.operativo_clave = $${paramIndex}
            OR COALESCE(oper_sel.operativo_dni, '') = $${paramIndex}
          )
      )`;
    params.push(textoNoVacio(operativoId));
    paramIndex += 1;
  }

  // Unificamos la dimension "personal operativo" a partir de las fuentes
  // reales del flujo institucional:
  // 1. incidencia_efectivos (apertura/asignacion humana)
  // 2. campos legacy efectivo_asignado_*
  // 3. incidencia_unidades_operacion (asignacion operativa por unidad)
  // 4. dni_efectivo / operador_cierre (cierre real de la incidencia)
  const cte = `
WITH base_incidencias AS (
  SELECT i.*
  FROM incidencias i
  WHERE ${where.join('\n    AND ')}
),
operativos_raw AS (
  SELECT
    bi.id AS incidencia_id,
    COALESCE(NULLIF(TRIM(ie.dni), ''), NULLIF(TRIM(ie.nombre), '')) AS operativo_clave,
    NULLIF(TRIM(ie.dni), '') AS operativo_dni,
    NULLIF(TRIM(ie.nombre), '') AS operativo_nombre,
    FALSE AS es_cierre
  FROM base_incidencias bi
  JOIN incidencia_efectivos ie ON ie.incidencia_id = bi.id
  WHERE COALESCE(NULLIF(TRIM(ie.dni), ''), NULLIF(TRIM(ie.nombre), '')) IS NOT NULL

  UNION ALL

  SELECT
    bi.id AS incidencia_id,
    COALESCE(
      NULLIF(TRIM(bi.efectivo_asignado_dni), ''),
      NULLIF(TRIM(bi.efectivo_asignado_nombre), '')
    ) AS operativo_clave,
    NULLIF(TRIM(bi.efectivo_asignado_dni), '') AS operativo_dni,
    NULLIF(TRIM(bi.efectivo_asignado_nombre), '') AS operativo_nombre,
    FALSE AS es_cierre
  FROM base_incidencias bi
  WHERE COALESCE(
    NULLIF(TRIM(bi.efectivo_asignado_dni), ''),
    NULLIF(TRIM(bi.efectivo_asignado_nombre), '')
  ) IS NOT NULL

  UNION ALL

  SELECT
    bi.id AS incidencia_id,
    NULLIF(TRIM(io.unidad_id), '') AS operativo_clave,
    NULLIF(TRIM(io.unidad_id), '') AS operativo_dni,
    NULL::text AS operativo_nombre,
    FALSE AS es_cierre
  FROM base_incidencias bi
  JOIN incidencia_unidades_operacion io ON io.incidencia_id = bi.id
  WHERE NULLIF(TRIM(io.unidad_id), '') IS NOT NULL

  UNION ALL

  SELECT
    bi.id AS incidencia_id,
    COALESCE(
      NULLIF(TRIM(bi.dni_efectivo), ''),
      NULLIF(TRIM(SPLIT_PART(COALESCE(bi.operador_cierre, ''), '@', 1)), '')
    ) AS operativo_clave,
    COALESCE(
      NULLIF(TRIM(bi.dni_efectivo), ''),
      NULLIF(TRIM(SPLIT_PART(COALESCE(bi.operador_cierre, ''), '@', 1)), '')
    ) AS operativo_dni,
    NULL::text AS operativo_nombre,
    TRUE AS es_cierre
  FROM base_incidencias bi
  WHERE COALESCE(
    NULLIF(TRIM(bi.dni_efectivo), ''),
    NULLIF(TRIM(SPLIT_PART(COALESCE(bi.operador_cierre, ''), '@', 1)), '')
  ) IS NOT NULL
),
operativos_base AS (
  SELECT
    incidencia_id,
    operativo_clave,
    MIN(operativo_dni) FILTER (WHERE operativo_dni IS NOT NULL) AS operativo_dni,
    MIN(operativo_nombre) FILTER (WHERE operativo_nombre IS NOT NULL) AS operativo_nombre,
    BOOL_OR(es_cierre) AS es_cierre
  FROM operativos_raw
  GROUP BY incidencia_id, operativo_clave
),
incidencias_filtradas AS (
  SELECT bi.*
  FROM base_incidencias bi
  WHERE 1 = 1${operativeFilterSql}
),
operativos_filtrados AS (
  SELECT ob.*
  FROM operativos_base ob
  JOIN incidencias_filtradas ifi ON ifi.id = ob.incidencia_id
)
`;

  return { cte, params };
}

function formatOperativoRow(row) {
  const operativoId = textoNoVacio(row.operativo_id || row.operativo_clave);
  const dni = textoNoVacio(row.dni || operativoId);
  const nombre = textoNoVacio(row.nombre || row.operativo_nombre || dni);
  const label = dni && nombre && nombre !== dni ? `${nombre} (${dni})` : nombre || dni;
  const promedio = row.promedio_minutos_respuesta;

  return {
    id: operativoId || dni || nombre,
    dni,
    nombre,
    label: label || 'Sin identificar',
    incidencias_vinculadas: Number(row.incidencias_vinculadas || 0),
    incidencias_resueltas: Number(row.incidencias_resueltas || 0),
    promedio_minutos_respuesta:
      promedio != null && !Number.isNaN(Number(promedio))
        ? Math.round(Number(promedio) * 100) / 100
        : null
  };
}

exports.gerenciales = async (req, res) => {
  const fechaInicio = textoNoVacio(req.query.fechaInicio);
  const fechaFin = textoNoVacio(req.query.fechaFin);
  const operativoId = textoNoVacio(req.query.dniEfectivo);
  const tipoDelito = textoNoVacio(req.query.tipoDelito);
  const fuente = textoNoVacio(req.query.fuente);

  if (!fechaInicio || !fechaFin) {
    return sendError(res, {
      status: 400,
      code: 'invalid_report_range',
      message: 'Se requieren fechaInicio y fechaFin (yyyy-MM-dd)'
    });
  }

  const client = await pool.connect();

  try {
    const mainScope = buildReportScope({
      fechaInicio,
      fechaFin,
      tipoDelito,
      fuente,
      operativoId
    });

    const totalQ = await client.query(
      `${mainScope.cte}
       SELECT
         COUNT(*)::int AS total_incidencias_periodo,
         COUNT(*) FILTER (WHERE ifi.estado = 'resuelta')::int AS total_resueltas_periodo,
         AVG(
           CASE
             WHEN ifi.estado = 'resuelta' THEN ${minutosResolucionSqlExpr('ifi')}
             ELSE NULL
           END
         )::float AS tiempo_promedio_respuesta_minutos
       FROM incidencias_filtradas ifi`,
      mainScope.params
    );

    const porTipoQ = await client.query(
      `${mainScope.cte}
       SELECT
         ${tipoSqlExpr('ifi')} AS tipo_delito,
         COUNT(*)::int AS cantidad
       FROM incidencias_filtradas ifi
       GROUP BY 1
       ORDER BY cantidad DESC, tipo_delito ASC`,
      mainScope.params
    );

    const porFuenteQ = await client.query(
      `${mainScope.cte}
       SELECT
         ${fuenteSqlExpr('ifi')} AS fuente,
         COUNT(*)::int AS cantidad
       FROM incidencias_filtradas ifi
       GROUP BY 1
       ORDER BY cantidad DESC, fuente ASC`,
      mainScope.params
    );

    const personalQ = await client.query(
      `${mainScope.cte}
       SELECT
         ofi.operativo_clave AS operativo_id,
         COALESCE(
           MIN(NULLIF(ofi.operativo_nombre, '')),
           MIN(NULLIF(ofi.operativo_dni, '')),
           MIN(ofi.operativo_clave)
         ) AS nombre,
         COALESCE(
           MIN(NULLIF(ofi.operativo_dni, '')),
           MIN(ofi.operativo_clave)
         ) AS dni,
         COUNT(DISTINCT ofi.incidencia_id)::int AS incidencias_vinculadas,
         COUNT(
           DISTINCT CASE
             WHEN ifi.estado = 'resuelta' AND ofi.es_cierre THEN ofi.incidencia_id
             ELSE NULL
           END
         )::int AS incidencias_resueltas,
         AVG(
           CASE
             WHEN ifi.estado = 'resuelta' AND ofi.es_cierre
             THEN ${minutosResolucionSqlExpr('ifi')}
             ELSE NULL
           END
         )::float AS promedio_minutos_respuesta
       FROM operativos_filtrados ofi
       JOIN incidencias_filtradas ifi ON ifi.id = ofi.incidencia_id
       GROUP BY ofi.operativo_clave
       ORDER BY incidencias_vinculadas DESC, incidencias_resueltas DESC, nombre ASC
       LIMIT 30`,
      mainScope.params
    );

    const efectivosScope = buildReportScope({
      fechaInicio,
      fechaFin,
      tipoDelito,
      fuente,
      operativoId: '',
      includeOperativoFilter: false
    });
    const listEfectivosQ = await client.query(
      `${efectivosScope.cte}
       SELECT
         ofi.operativo_clave AS operativo_id,
         COALESCE(
           MIN(NULLIF(ofi.operativo_dni, '')),
           MIN(ofi.operativo_clave)
         ) AS dni,
         COALESCE(
           MIN(NULLIF(ofi.operativo_nombre, '')),
           MIN(NULLIF(ofi.operativo_dni, '')),
           MIN(ofi.operativo_clave)
         ) AS nombre
       FROM operativos_filtrados ofi
       GROUP BY ofi.operativo_clave
       ORDER BY nombre ASC
       LIMIT 300`,
      efectivosScope.params
    );

    const tiposScope = buildReportScope({
      fechaInicio,
      fechaFin,
      tipoDelito,
      fuente,
      operativoId,
      includeTipoFilter: false
    });
    const listTiposQ = await client.query(
      `${tiposScope.cte}
       SELECT DISTINCT ${tipoSqlExpr('ifi')} AS tipo
       FROM incidencias_filtradas ifi
       ORDER BY 1
       LIMIT 200`,
      tiposScope.params
    );

    const fuentesScope = buildReportScope({
      fechaInicio,
      fechaFin,
      tipoDelito,
      fuente,
      operativoId,
      includeFuenteFilter: false
    });
    const listFuentesQ = await client.query(
      `${fuentesScope.cte}
       SELECT DISTINCT ${fuenteSqlExpr('ifi')} AS fuente
       FROM incidencias_filtradas ifi
       ORDER BY 1
       LIMIT 200`,
      fuentesScope.params
    );

    const tablaPersonal = personalQ.rows.map(formatOperativoRow);
    const top = tablaPersonal[0];
    const totalRow = totalQ.rows[0] || {};

    const reportData = {
      kpis: {
        total_incidencias_periodo: Number(totalRow.total_incidencias_periodo || 0),
        total_resueltas_periodo: Number(totalRow.total_resueltas_periodo || 0),
        tiempo_promedio_respuesta_minutos:
          totalRow.tiempo_promedio_respuesta_minutos != null &&
          !Number.isNaN(Number(totalRow.tiempo_promedio_respuesta_minutos))
            ? Math.round(Number(totalRow.tiempo_promedio_respuesta_minutos) * 100) / 100
            : null,
        efectivo_mas_atenciones: top
          ? {
              id: top.id,
              dni: top.dni,
              nombre: top.nombre,
              label: top.label,
              atenciones: top.incidencias_vinculadas,
              incidencias_resueltas: top.incidencias_resueltas
            }
          : null
      },
      tabla_personal: tablaPersonal,
      por_tipo_delito: porTipoQ.rows.map((row) => ({
        tipo_delito: textoNoVacio(row.tipo_delito) || 'Sin clasificar',
        cantidad: Number(row.cantidad || 0)
      })),
      por_fuente: porFuenteQ.rows.map((row) => ({
        fuente: textoNoVacio(row.fuente) || 'Sin fuente',
        cantidad: Number(row.cantidad || 0)
      })),
      listas: {
        efectivos: listEfectivosQ.rows.map((row) => {
          const formatted = formatOperativoRow({
            operativo_id: row.operativo_id,
            dni: row.dni,
            nombre: row.nombre,
            incidencias_vinculadas: 0,
            incidencias_resueltas: 0,
            promedio_minutos_respuesta: null
          });
          return {
            id: formatted.id,
            dni: formatted.dni,
            nombre: formatted.nombre,
            label: formatted.label
          };
        }),
        tipos_delito: listTiposQ.rows
          .map((row) => textoNoVacio(row.tipo))
          .filter(Boolean),
        fuentes: listFuentesQ.rows
          .map((row) => textoNoVacio(row.fuente))
          .filter(Boolean)
      },
      meta: {
        source: 'postgresql',
        note:
          'El dashboard gerencial se alimenta solo desde PostgreSQL. Incidencias historicas que aun existan solo en Firestore no apareceran aqui hasta ser migradas.'
      }
    };

    return sendOk(res, {
      data: reportData,
      legacy: reportData
    });
  } catch (error) {
    console.error('reportes gerenciales:', error);
    return sendError(res, {
      status: 500,
      code: 'reportes_gerenciales_failed',
      message: 'Error interno al generar reportes gerenciales'
    });
  } finally {
    client.release();
  }
};

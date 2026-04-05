const pool = require('../config/db');
const { sendOk, sendError } = require('../utils/apiResponse');

function dniValido(value) {
  if (value == null) return '';
  const s = String(value).trim();
  if (!s) return '';
  return /^[0-9]{8}$/.test(s) ? s : '';
}

function idDesdeCampoOperador(val) {
  if (val == null) return '';
  const s = String(val).trim();
  if (!s) return '';
  const candidate = s.includes('@') ? s.split('@')[0] : s;
  return dniValido(candidate);
}

exports.gerenciales = async (req, res) => {
  const fechaInicio = req.query.fechaInicio;
  const fechaFin = req.query.fechaFin;

  if (!fechaInicio || !fechaFin) {
    return sendError(res, {
      status: 400,
      code: 'invalid_report_range',
      message: 'Se requieren fechaInicio y fechaFin (yyyy-MM-dd)'
    });
  }

  const client = await pool.connect();

  try {
    let extra = '';
    const params = [fechaInicio, fechaFin];
    let p = 3;
    const dniOperativoExpr = `
      COALESCE(
        NULLIF(TRIM(dni_efectivo::text), ''),
        NULLIF(TRIM(SPLIT_PART(operador_cierre::text, '@', 1)), '')
      )`;

    if (req.query.dniEfectivo && String(req.query.dniEfectivo).trim()) {
      const dni = String(req.query.dniEfectivo).trim();
      params.push(`%${dni}%`);
      extra += ` AND (
        COALESCE(dni_efectivo::text, '') ILIKE $${p}
        OR COALESCE(operador_cierre::text, '') ILIKE $${p}
        OR operador_registro ILIKE $${p}
        OR usuario ILIKE $${p}
      )`;
      p++;
    }
    if (req.query.tipoDelito && String(req.query.tipoDelito).trim()) {
      params.push(String(req.query.tipoDelito).trim());
      extra += ` AND COALESCE(NULLIF(TRIM(tipo), ''), 'Sin clasificar') = $${p}`;
      p++;
    }
    if (req.query.fuente && String(req.query.fuente).trim()) {
      params.push(String(req.query.fuente).trim());
      extra += ` AND COALESCE(NULLIF(TRIM(fuente), ''), 'Sin fuente') = $${p}`;
      p++;
    }

    const cond = `fecha::date BETWEEN $1::date AND $2::date ${extra}`;
    const where = `WHERE ${cond}`;
    const whereResuelta = `WHERE ${cond} AND estado = 'resuelta'`;
    const filtroCierreOperativo = `
      AND ${dniOperativoExpr} ~ '^[0-9]{8}$'`;
    const whereResueltaOperativo = `${whereResuelta}${filtroCierreOperativo}`;

    const totalQ = await client.query(
      `SELECT COUNT(*)::int AS c FROM incidencias ${where}`,
      params
    );
    const total = totalQ.rows[0]?.c ?? 0;

    let tiempoProm = null;
    const intentarPromedioMinutos = async (sql) => {
      try {
        const tq = await client.query(sql, params);
        const m = tq.rows[0]?.m;
        if (m != null && !Number.isNaN(Number(m))) return Number(m);
      } catch (_) {
        return null;
      }
      return null;
    };

    tiempoProm = await intentarPromedioMinutos(
      `SELECT AVG(minutos_totales)::float AS m FROM incidencias ${whereResueltaOperativo} AND minutos_totales IS NOT NULL`
    );
    if (tiempoProm == null) {
      tiempoProm = await intentarPromedioMinutos(
        `SELECT AVG(EXTRACT(EPOCH FROM (fecha_cierre - fecha)) / 60.0)::float AS m
         FROM incidencias ${whereResueltaOperativo}
         AND fecha_cierre IS NOT NULL AND fecha IS NOT NULL`
      );
    }

    const porTipo = await client.query(
      `SELECT COALESCE(NULLIF(TRIM(tipo), ''), 'Sin clasificar') AS tipo_delito, COUNT(*)::int AS cantidad
       FROM incidencias ${where}
       GROUP BY 1 ORDER BY cantidad DESC`,
      params
    );

    const porFuente = await client.query(
      `SELECT COALESCE(NULLIF(TRIM(fuente), ''), 'Sin fuente') AS fuente, COUNT(*)::int AS cantidad
       FROM incidencias ${where}
       GROUP BY 1 ORDER BY cantidad DESC`,
      params
    );

    let porOperador = { rows: [] };
    try {
      porOperador = await client.query(
        `SELECT ${dniOperativoExpr} AS dni_operativo, COUNT(*)::int AS n,
                AVG(
                  COALESCE(
                    minutos_totales::float,
                    CASE
                      WHEN fecha_cierre IS NOT NULL AND fecha IS NOT NULL
                      THEN EXTRACT(EPOCH FROM (fecha_cierre - fecha)) / 60.0
                      ELSE NULL
                    END
                  )
                )::float AS prom_min
         FROM incidencias ${whereResueltaOperativo}
         GROUP BY 1 ORDER BY n DESC LIMIT 30`,
        params
      );
    } catch (_) {
      porOperador = await client.query(
        `SELECT ${dniOperativoExpr} AS dni_operativo, COUNT(*)::int AS n, NULL::float AS prom_min
         FROM incidencias ${whereResueltaOperativo}
         GROUP BY 1 ORDER BY n DESC LIMIT 30`,
        params
      );
    }

    const top = porOperador.rows[0];
    let efectivoMas = null;
    if (top) {
      const id = idDesdeCampoOperador(top.dni_operativo);
      efectivoMas = {
        nombre: id,
        dni: id,
        atenciones: top.n,
      };
    }

    const tablaPersonal = porOperador.rows.map((r) => {
      const id = idDesdeCampoOperador(r.dni_operativo);
      const prom = r.prom_min;
      return {
        dni: id,
        nombre: id,
        incidencias_resueltas: r.n,
        promedio_minutos_respuesta:
          prom != null && !Number.isNaN(Number(prom))
            ? Math.round(Number(prom) * 100) / 100
            : null,
      };
    });

    let listEfectivosQ = { rows: [] };
    try {
      listEfectivosQ = await client.query(
        `SELECT DISTINCT ${dniOperativoExpr} AS raw
         FROM incidencias
         WHERE fecha::date BETWEEN $1::date AND $2::date
           AND estado = 'resuelta'
           AND ${dniOperativoExpr} ~ '^[0-9]{8}$'
         ORDER BY 1
         LIMIT 300`,
        [fechaInicio, fechaFin]
      );
    } catch (e) {
      console.error('listas efectivos:', e.message);
    }

    const idsOrdenados = [];
    const vistos = new Set();
    for (const row of listEfectivosQ.rows) {
      const raw = row.raw;
      const id = idDesdeCampoOperador(raw);
      if (!id || vistos.has(id)) continue;
      vistos.add(id);
      idsOrdenados.push(id);
    }

    const listTiposQ = await client.query(
      `SELECT DISTINCT COALESCE(NULLIF(TRIM(tipo), ''), 'Sin clasificar') AS t FROM incidencias ORDER BY 1 LIMIT 200`
    );
    const listFuentesQ = await client.query(
      `SELECT DISTINCT COALESCE(NULLIF(TRIM(fuente), ''), 'Sin fuente') AS f FROM incidencias ORDER BY 1 LIMIT 200`
    );

    const reportData = {
      kpis: {
        total_incidencias_periodo: total,
        tiempo_promedio_respuesta_minutos: tiempoProm,
        efectivo_mas_atenciones: efectivoMas,
      },
      tabla_personal: tablaPersonal,
      por_tipo_delito: porTipo.rows,
      por_fuente: porFuente.rows,
      listas: {
        efectivos: idsOrdenados.map((dni) => ({ dni, nombre: dni })),
        tipos_delito: listTiposQ.rows.map((r) => r.t),
        fuentes: listFuentesQ.rows.map((r) => r.f),
      },
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

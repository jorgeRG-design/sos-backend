const fs = require('fs');
const path = require('path');
const pool = require('../config/db');
const { sendOk, sendError } = require('../utils/apiResponse');
const { registrarEventoSeguro } = require('../services/auditoriaService');
const { AUDIT_ACTIONS } = require('../utils/auditCatalog');

const UPLOAD_ROOT = path.resolve(
  process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads')
);

const MAX_IMAGE_BYTES = Number(process.env.MAX_UPLOAD_IMAGE_BYTES || 8 * 1024 * 1024);
const MAX_PDF_BYTES = Number(process.env.MAX_UPLOAD_PDF_BYTES || 15 * 1024 * 1024);

const ALLOWED_IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const ALLOWED_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

async function obtenerCodigoSerenoPrincipal(client, incidenciaId) {
  try {
    const ef = await client.query(
      `SELECT dni, nombre
       FROM incidencia_efectivos
       WHERE incidencia_id = $1
         AND dni IS NOT NULL
         AND TRIM(dni::text) <> ''
       ORDER BY orden NULLS LAST, id ASC
       LIMIT 1`,
      [incidenciaId]
    );
    if (ef.rows.length > 0) {
      return String(ef.rows[0].dni).trim();
    }
  } catch (e) {
    if (!String(e.message || '').includes('incidencia_efectivos')) {
      throw e;
    }
  }
  const inc = await client.query(
    `SELECT efectivo_asignado_dni FROM incidencias WHERE id = $1`,
    [incidenciaId]
  );
  const dni = inc.rows[0]?.efectivo_asignado_dni;
  if (dni != null && String(dni).trim() !== '') {
    return String(dni).trim();
  }
  return 'SIN-SERENO';
}

function sanitizeSegment(value) {
  const s = String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return s.length > 0 ? s.toUpperCase() : 'X';
}

function extFromOriginal(name) {
  const base = path.basename(String(name || ''));
  const i = base.lastIndexOf('.');
  if (i <= 0) return '';
  return base.slice(i).toLowerCase();
}

function mimeOkForTipo(tipoArchivo, mime, ext) {
  if (tipoArchivo === 'imagen') {
    if (ALLOWED_IMAGE_EXT.has(ext)) return true;
    return mime && ALLOWED_IMAGE_MIME.has(String(mime).toLowerCase());
  }
  if (tipoArchivo === 'pdf') {
    return ext === '.pdf' || String(mime).toLowerCase() === 'application/pdf';
  }
  return false;
}

function maxBytesForTipo(tipoArchivo) {
  return tipoArchivo === 'pdf' ? MAX_PDF_BYTES : MAX_IMAGE_BYTES;
}

async function cargarIncidenciaPorId(client, id) {
  const r = await client.query(
    `SELECT id, ticket, estado FROM incidencias WHERE id = $1 LIMIT 1`,
    [id]
  );
  return r.rows[0] || null;
}

exports.lookupByTicket = async (req, res) => {
  try {
    const incidencia = req.incidenciaAccess?.incidencia;
    if (!incidencia) {
      return sendError(res, {
        status: 404,
        code: 'incidencia_not_found',
        message: 'Incidencia no encontrada'
      });
    }
    return sendOk(res, {
      data: {
        id: incidencia.id,
        ticket: incidencia.ticket,
        estado: incidencia.estado,
        alerta_firestore_id: incidencia.alerta_firestore_id
      },
      legacy: {
        id: incidencia.id,
        incidencia_id: incidencia.id
      }
    });
  } catch (e) {
    console.error('lookupByTicket', e);
    return sendError(res, {
      status: 500,
      code: 'lookup_ticket_failed',
      message: 'No se pudo consultar la incidencia.'
    });
  }
};

exports.lookupByAlertaId = async (req, res) => {
  try {
    const incidencia = req.incidenciaAccess?.incidencia;
    if (!incidencia) {
      return sendError(res, {
        status: 404,
        code: 'incidencia_not_found',
        message: 'Incidencia no encontrada'
      });
    }
    return sendOk(res, {
      data: {
        id: incidencia.id,
        ticket: incidencia.ticket,
        estado: incidencia.estado,
        alerta_firestore_id: incidencia.alerta_firestore_id
      },
      legacy: {
        id: incidencia.id,
        incidencia_id: incidencia.id
      }
    });
  } catch (e) {
    console.error('lookupByAlertaId', e);
    return sendError(res, {
      status: 500,
      code: 'lookup_alerta_failed',
      message: 'No se pudo consultar la incidencia.'
    });
  }
};

exports.listar = async (req, res) => {
  try {
    const incidenciaId = String(
      req.incidenciaAccess?.incidenciaId || req.params.id || ''
    ).trim();
    if (!incidenciaId) {
      return sendError(res, {
        status: 400,
        code: 'invalid_incidencia_id',
        message: 'ID invalido'
      });
    }
    const r = await pool.query(
      `SELECT id, incidencia_id, tipo_archivo, nombre_original, nombre_guardado,
              extension, mime_type, tamano_bytes, correlativo, codigo_sereno_asignado,
              subido_por, fecha_subida, observacion
       FROM incidencia_archivos
       WHERE incidencia_id = $1 AND activo = TRUE
       ORDER BY correlativo NULLS LAST, id ASC`,
      [incidenciaId]
    );
    return sendOk(res, { data: r.rows });
  } catch (e) {
    console.error('listar archivos', e);
    return sendError(res, {
      status: 500,
      code: 'listar_archivos_failed',
      message: 'No se pudo listar los adjuntos de la incidencia.'
    });
  }
};

exports.descargar = async (req, res) => {
  try {
    const incidenciaId = String(
      req.incidenciaAccess?.incidenciaId || req.params.id || ''
    ).trim();
    const archivoId = parseInt(req.params.archivoId, 10);
    if (!incidenciaId || !Number.isFinite(archivoId)) {
      return sendError(res, {
        status: 400,
        code: 'invalid_download_params',
        message: 'Parametros invalidos'
      });
    }
    const r = await pool.query(
      `SELECT nombre_original, nombre_guardado, ruta_archivo, mime_type, activo
       FROM incidencia_archivos
       WHERE id = $1 AND incidencia_id = $2`,
      [archivoId, incidenciaId]
    );
    if (r.rows.length === 0) {
      return sendError(res, {
        status: 404,
        code: 'archivo_not_found',
        message: 'Archivo no encontrado'
      });
    }
    const row = r.rows[0];
    if (!row.activo) {
      return sendError(res, {
        status: 410,
        code: 'archivo_inactivo',
        message: 'Archivo dado de baja'
      });
    }
    const abs = path.resolve(row.ruta_archivo);
    const rootResolved = path.resolve(UPLOAD_ROOT);
    if (!abs.startsWith(rootResolved)) {
      return sendError(res, {
        status: 403,
        code: 'ruta_no_permitida',
        message: 'Ruta no permitida'
      });
    }
    if (!fs.existsSync(abs)) {
      return sendError(res, {
        status: 404,
        code: 'archivo_fisico_missing',
        message: 'Archivo fisico no disponible'
      });
    }
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(row.nombre_guardado)}"`
    );
    if (row.mime_type) {
      res.setHeader('Content-Type', row.mime_type);
    }
    await registrarEventoSeguro({
      req,
      accion: AUDIT_ACTIONS.ARCHIVO_DOWNLOAD,
      objetoTipo: 'archivo',
      objetoId: String(archivoId),
      resultado: 'success',
      detalle: `Descarga autorizada de archivo ${archivoId}.`,
      metadata: {
        incidencia_id: incidenciaId,
        nombre_original: row.nombre_original || null,
        nombre_guardado: row.nombre_guardado || null
      }
    });
    return res.sendFile(abs);
  } catch (e) {
    console.error('descargar', e);
    await registrarEventoSeguro({
      req,
      accion: AUDIT_ACTIONS.ARCHIVO_DOWNLOAD,
      objetoTipo: 'archivo',
      objetoId: String(req.params.archivoId || '').trim() || null,
      resultado: 'error',
      detalle: e.message || 'No se pudo descargar el archivo.',
      metadata: {
        incidencia_id: String(req.params.id || '').trim() || null
      }
    });
    return sendError(res, {
      status: 500,
      code: 'descargar_archivo_failed',
      message: 'No se pudo descargar el archivo.'
    });
  }
};

exports.eliminar = async (req, res) => {
  const client = await pool.connect();
  try {
    const incidenciaId = String(
      req.incidenciaAccess?.incidenciaId || req.params.id || ''
    ).trim();
    const archivoId = parseInt(req.params.archivoId, 10);
    if (!incidenciaId || !Number.isFinite(archivoId)) {
      return sendError(res, {
        status: 400,
        code: 'invalid_delete_params',
        message: 'Parametros invalidos'
      });
    }
    const r = await client.query(
      `SELECT ruta_archivo FROM incidencia_archivos
       WHERE id = $1 AND incidencia_id = $2 AND activo = TRUE`,
      [archivoId, incidenciaId]
    );
    if (r.rows.length === 0) {
      return sendError(res, {
        status: 404,
        code: 'archivo_not_found',
        message: 'Archivo no encontrado'
      });
    }
    const abs = path.resolve(r.rows[0].ruta_archivo);
    const rootResolved = path.resolve(UPLOAD_ROOT);
    if (abs.startsWith(rootResolved) && fs.existsSync(abs)) {
      try {
        fs.unlinkSync(abs);
      } catch (err) {
        console.warn('unlink archivo', err.message);
      }
    }
    await client.query(
      `UPDATE incidencia_archivos SET activo = FALSE WHERE id = $1`,
      [archivoId]
    );
    await registrarEventoSeguro({
      req,
      accion: AUDIT_ACTIONS.ARCHIVO_DELETE,
      objetoTipo: 'archivo',
      objetoId: String(archivoId),
      resultado: 'success',
      detalle: `Archivo ${archivoId} eliminado.`,
      metadata: {
        incidencia_id: incidenciaId
      }
    });
    return sendOk(res, {
      message: 'Archivo eliminado',
      legacy: { mensaje: 'Archivo eliminado' }
    });
  } catch (e) {
    console.error('eliminar archivo', e);
    await registrarEventoSeguro({
      req,
      accion: AUDIT_ACTIONS.ARCHIVO_DELETE,
      objetoTipo: 'archivo',
      objetoId: String(req.params.archivoId || '').trim() || null,
      resultado: 'error',
      detalle: e.message || 'No se pudo eliminar el archivo.',
      metadata: {
        incidencia_id: String(req.params.id || '').trim() || null
      }
    });
    return sendError(res, {
      status: 500,
      code: 'eliminar_archivo_failed',
      message: 'No se pudo eliminar el archivo.'
    });
  } finally {
    client.release();
  }
};

exports.subir = async (req, res) => {
  const client = await pool.connect();
  try {
    const incidenciaId = String(
      req.incidenciaAccess?.incidenciaId || req.params.id || ''
    ).trim();
    if (!incidenciaId) {
      return sendError(res, {
        status: 400,
        code: 'invalid_incidencia_id',
        message: 'ID invalido'
      });
    }

    const tipoArchivo = String(req.body.tipo_archivo || '')
      .trim()
      .toLowerCase();
    if (tipoArchivo !== 'imagen' && tipoArchivo !== 'pdf') {
      return sendError(res, {
        status: 400,
        code: 'invalid_tipo_archivo',
        message: 'tipo_archivo debe ser imagen o pdf'
      });
    }

    const files = req.files || [];
    if (!Array.isArray(files) || files.length === 0) {
      return sendError(res, {
        status: 400,
        code: 'archivos_required',
        message: 'No se recibieron archivos'
      });
    }

    const subidoPor = String(req.body.subido_por || '').trim() || null;

    await client.query('BEGIN');

    const inc = req.incidenciaAccess?.incidencia || await cargarIncidenciaPorId(client, incidenciaId);
    if (!inc) {
      await client.query('ROLLBACK');
      return sendError(res, {
        status: 404,
        code: 'incidencia_not_found',
        message: 'Incidencia no encontrada'
      });
    }

    const ticketRaw = inc.ticket;
    const ticketSeg = sanitizeSegment(ticketRaw);
    const serenoCodigo = await obtenerCodigoSerenoPrincipal(client, incidenciaId);
    const serenoSeg = sanitizeSegment(serenoCodigo);

    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const stamp = `${y}${m}${String(now.getDate()).padStart(2, '0')}_${hh}${mm}${ss}`;

    const dirRel = path.join('incidencias', String(y), m, ticketSeg);
    const dirAbs = path.join(UPLOAD_ROOT, dirRel);
    fs.mkdirSync(dirAbs, { recursive: true });

    const insertados = [];

    for (const file of files) {
      const maxB = maxBytesForTipo(tipoArchivo);
      if (file.size > maxB) {
        await client.query('ROLLBACK');
        return sendError(res, {
          status: 400,
          code: 'archivo_too_large',
          message: `Archivo supera el tamano maximo (${Math.round(maxB / (1024 * 1024))} MB)`
        });
      }
      const ext = extFromOriginal(file.originalname);
      if (!mimeOkForTipo(tipoArchivo, file.mimetype, ext)) {
        await client.query('ROLLBACK');
        return sendError(res, {
          status: 400,
          code: 'archivo_tipo_no_permitido',
          message: `Tipo de archivo no permitido para ${tipoArchivo}`
        });
      }

      const corrQ = await client.query(
        `SELECT COALESCE(MAX(correlativo), 0) + 1 AS n
         FROM incidencia_archivos
         WHERE incidencia_id = $1`,
        [incidenciaId]
      );
      const correlativo = Number(corrQ.rows[0].n);

      const nombreGuardado = `${ticketSeg}_${serenoSeg}_${stamp}_${correlativo}${ext}`;
      const rutaAbs = path.join(dirAbs, nombreGuardado);

      fs.writeFileSync(rutaAbs, file.buffer);

      const ins = await client.query(
        `INSERT INTO incidencia_archivos (
          incidencia_id, tipo_archivo, nombre_original, nombre_guardado, ruta_archivo,
          extension, mime_type, tamano_bytes, correlativo, codigo_sereno_asignado, subido_por
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        RETURNING *`,
        [
          incidenciaId,
          tipoArchivo,
          file.originalname || nombreGuardado,
          nombreGuardado,
          rutaAbs,
          ext.replace('.', '') || null,
          file.mimetype || null,
          file.size,
          correlativo,
          serenoCodigo,
          subidoPor,
        ]
      );
      insertados.push(ins.rows[0]);
    }

    await client.query('COMMIT');
    await registrarEventoSeguro({
      req,
      accion: AUDIT_ACTIONS.ARCHIVO_UPLOAD,
      objetoTipo: 'incidencia',
      objetoId: incidenciaId,
      resultado: 'success',
      detalle: `Se cargaron ${insertados.length} archivo(s) a la incidencia.`,
      metadata: {
        incidencia_id: incidenciaId,
        cantidad: insertados.length,
        tipo_archivo: tipoArchivo
      }
    });
    return sendOk(res, { status: 201, data: insertados });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('subir archivos', e);
    await registrarEventoSeguro({
      req,
      accion: AUDIT_ACTIONS.ARCHIVO_UPLOAD,
      objetoTipo: 'incidencia',
      objetoId: String(req.params.id || '').trim() || null,
      resultado: 'error',
      detalle: e.message || 'No se pudieron subir archivos.',
      metadata: {
        incidencia_id: String(req.params.id || '').trim() || null
      }
    });
    return sendError(res, {
      status: 500,
      code: 'subir_archivos_failed',
      message: 'No se pudieron subir los archivos.'
    });
  } finally {
    client.release();
  }
};

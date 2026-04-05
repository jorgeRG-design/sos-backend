const pool = require('../config/db');
const dbFirestore = require('../config/firebase');
const admin = require('firebase-admin');
const { sendOk, sendError } = require('../utils/apiResponse');
const { validarImportacionGps } = require('../validators/gpsValidator');

function normalizarTexto(valor) {
  if (valor === null || valor === undefined) return '';
  return String(valor).trim();
}

function normalizarNumero(valor) {
  if (valor === null || valor === undefined) return 0;
  const texto = String(valor).trim().replace(',', '.');
  const numero = Number(texto);
  return Number.isNaN(numero) ? 0 : numero;
}

function crearClaveUnica(codigo, ultimoReporte) {
  return `${normalizarTexto(codigo)}__${normalizarTexto(ultimoReporte)}`;
}

exports.importarGPS = async (req, res) => {
  let client = null;
  let clientReleased = false;
  let sqlCommitted = false;

  try {
    const erroresValidacion = validarImportacionGps(req.body || {});
    if (erroresValidacion.length > 0) {
      return sendError(res, {
        status: 400,
        code: 'invalid_gps_payload',
        message: erroresValidacion[0],
        legacy: { success: false }
      });
    }

    const { registros, nombre_archivo } = req.body;

    let insertados = 0;
    let omitidos = 0;
    let vehiculosActualizados = 0;
    const recorridosInsertados = [];
    const idsInsertados = [];
    const vehiculosPendientes = new Map();
    const registrosPreparados = [];

    for (const reg of registros) {
      const codigo = normalizarTexto(reg.codigo);
      const alias = normalizarTexto(reg.alias);
      const ultimoReporte = normalizarTexto(reg.ultimo_reporte);
      const cumplioMeta = normalizarTexto(reg.meta).toLowerCase() === 'si';
      const tiempoMeta = normalizarNumero(reg.tiempo);
      const kmMeta = normalizarNumero(reg.km);

      if (!codigo) continue;

      const claveUnica = crearClaveUnica(codigo, ultimoReporte);
      const existeFs = await dbFirestore
        .collection('recorridos_gps')
        .where('clave_unica', '==', claveUnica)
        .limit(1)
        .get();

      registrosPreparados.push({
        codigo,
        alias,
        ultimoReporte,
        cumplioMeta,
        tiempoMeta,
        kmMeta,
        claveUnica,
        yaExisteEnFirestore: !existeFs.empty
      });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    for (const reg of registrosPreparados) {
      const {
        codigo,
        alias,
        ultimoReporte,
        cumplioMeta,
        tiempoMeta,
        kmMeta,
        claveUnica,
        yaExisteEnFirestore
      } = reg;

      const existeSql = await client.query(
        `
        SELECT id
        FROM recorridos_gps
        WHERE codigo = $1
          AND COALESCE(ultimo_reporte, '') = COALESCE($2, '')
        LIMIT 1
        `,
        [codigo, ultimoReporte]
      );

      const yaExisteEnSql = existeSql.rows.length > 0;

      if (!yaExisteEnSql && !yaExisteEnFirestore) {
        const insertResult = await client.query(
          `
          INSERT INTO recorridos_gps
          (codigo, alias, ultimo_reporte, cumplio_meta, tiempo_meta, km_meta, fecha_importacion, nombre_archivo)
          VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)
          RETURNING id
          `,
          [
            codigo,
            alias || null,
            ultimoReporte || null,
            cumplioMeta,
            tiempoMeta,
            kmMeta,
            nombre_archivo || null,
          ]
        );

        const insertedId = Number(insertResult.rows[0]?.id);
        if (Number.isFinite(insertedId)) {
          idsInsertados.push(insertedId);
        }

        recorridosInsertados.push({
          codigo,
          alias: alias || null,
          ultimo_reporte: ultimoReporte || null,
          cumplio_meta: cumplioMeta,
          tiempo_meta: tiempoMeta,
          km_meta: kmMeta,
          nombre_archivo: nombre_archivo || null,
          clave_unica: claveUnica,
        });

        insertados++;
      } else {
        omitidos++;
      }

      vehiculosPendientes.set(codigo, {
        codigo,
        alias: alias || null
      });
      vehiculosActualizados++;
    }

    await client.query('COMMIT');
    sqlCommitted = true;
    client.release();
    clientReleased = true;

    try {
      const batch = dbFirestore.batch();
      const ahora = admin.firestore.FieldValue.serverTimestamp();

      for (const recorrido of recorridosInsertados) {
        const docRef = dbFirestore.collection('recorridos_gps').doc();
        batch.set(docRef, {
          ...recorrido,
          fecha_importacion: ahora,
        });
      }

      for (const vehiculo of vehiculosPendientes.values()) {
        const vehiculoRef = dbFirestore.collection('vehiculos').doc(vehiculo.codigo);
        const vehiculoSnap = await vehiculoRef.get();

        if (vehiculoSnap.exists) {
          batch.set(
            vehiculoRef,
            {
              codigo: vehiculo.codigo,
              alias: vehiculo.alias,
              dependencia: 'Serenazgo',
              estado: 'activo',
              ultima_vez_visto: ahora,
            },
            { merge: true }
          );
        } else {
          batch.set(vehiculoRef, {
            codigo: vehiculo.codigo,
            alias: vehiculo.alias,
            placa: null,
            tipo: null,
            dependencia: 'Serenazgo',
            estado: 'activo',
            primera_vez_visto: ahora,
            ultima_vez_visto: ahora,
          });
        }
      }

      await batch.commit();
    } catch (firestoreError) {
      if (idsInsertados.length > 0) {
        try {
          await pool.query(
            `DELETE FROM recorridos_gps
             WHERE id = ANY($1::int[])`,
            [idsInsertados]
          );
        } catch (compensationError) {
          console.error(
            '[GPS] Fallo la compensacion SQL inmediata tras error en Firestore:',
            compensationError
          );
        }
      }
      throw firestoreError;
    }

    const resumen = {
      insertados,
      omitidos_por_duplicado: omitidos,
      vehiculos_actualizados: vehiculosActualizados,
    };

    return sendOk(res, {
      status: 201,
      message: 'Importacion GPS procesada correctamente.',
      data: { resumen },
      legacy: {
        success: true,
        resumen
      }
    });
  } catch (error) {
    if (!sqlCommitted && client && !clientReleased) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('[GPS] Fallo al revertir la transaccion:', rollbackError);
      }
    }
    console.error('Error en importacion GPS:', error);
    return sendError(res, {
      status: 500,
      code: 'gps_import_failed',
      message: 'No se pudo procesar la importacion GPS.',
      legacy: { success: false }
    });
  } finally {
    if (client && !clientReleased) {
      client.release();
    }
  }
};

require('dotenv').config();

const pool = require('../config/db');
const dbFirestore = require('../config/firebase');

const COLECCION = 'clasificador_incidencias';
const BATCH_LIMIT = 400;

async function syncClasificadorFirestore() {
  const result = await pool.query(
    `
      SELECT
        modalidad_codigo,
        modalidad_nombre,
        subtipo_codigo,
        subtipo_nombre,
        tipo_codigo,
        tipo_nombre,
        activo,
        orden
      FROM clasificador_incidencias
      ORDER BY modalidad_codigo, subtipo_codigo, tipo_codigo
    `
  );

  const rows = result.rows;
  let batch = dbFirestore.batch();
  let pending = 0;

  for (const row of rows) {
    const docId = String(row.tipo_codigo || '').trim();
    if (!docId) {
      continue;
    }

    const ref = dbFirestore.collection(COLECCION).doc(docId);
    batch.set(
      ref,
      {
        modalidad_codigo: row.modalidad_codigo ?? null,
        modalidad_nombre: row.modalidad_nombre ?? null,
        subtipo_codigo: row.subtipo_codigo ?? null,
        subtipo_nombre: row.subtipo_nombre ?? null,
        tipo_codigo: row.tipo_codigo ?? null,
        tipo_nombre: row.tipo_nombre ?? null,
        activo: row.activo ?? null,
        orden: row.orden ?? null,
      },
      { merge: true }
    );

    pending += 1;
    if (pending >= BATCH_LIMIT) {
      await batch.commit();
      batch = dbFirestore.batch();
      pending = 0;
    }
  }

  if (pending > 0) {
    await batch.commit();
  }

  console.log(
    `Sincronización completada: ${rows.length} registros en Firestore/${COLECCION}`
  );
}

syncClasificadorFirestore()
  .catch((error) => {
    console.error('Error al sincronizar clasificador con Firestore:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });

/**
 * sync_clasificador_firestore.js
 * Sincroniza la tabla `tipificacion` con la colección Firestore del mismo nombre.
 * Uso: node scripts/sync_clasificador_firestore.js
 */

require('dotenv').config();

const pool       = require('../config/db');
const dbFirestore = require('../config/firebase');

const COLECCION   = 'tipificacion';
const BATCH_LIMIT = 400;

async function syncTipificacionFirestore() {
  const { rows } = await pool.query(
    `SELECT id, nivel1, nivel2, nivel3, descripcion, codigo_autogenerado, activo, orden
     FROM public.tipificacion
     ORDER BY nivel1, nivel2, nivel3`
  );

  let batch   = dbFirestore.batch();
  let pending = 0;

  for (const row of rows) {
    const docId = row.codigo_autogenerado || String(row.id);
    const ref   = dbFirestore.collection(COLECCION).doc(docId);

    batch.set(
      ref,
      {
        nivel1:              row.nivel1             ?? null,
        nivel2:              row.nivel2             ?? null,
        nivel3:              row.nivel3             ?? null,
        descripcion:         row.descripcion        ?? null,
        codigo_autogenerado: row.codigo_autogenerado ?? null,
        activo:              row.activo             ?? true,
        orden:               row.orden              ?? null,
      },
      { merge: true }
    );

    pending += 1;
    if (pending >= BATCH_LIMIT) {
      await batch.commit();
      batch   = dbFirestore.batch();
      pending = 0;
    }
  }

  if (pending > 0) {
    await batch.commit();
  }

  console.log(`✓ Sincronización completada: ${rows.length} registros → Firestore/${COLECCION}`);
}

syncTipificacionFirestore()
  .catch((err) => {
    console.error('✗ Error al sincronizar tipificación con Firestore:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

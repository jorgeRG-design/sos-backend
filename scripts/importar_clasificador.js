require('dotenv').config();

const fs = require('fs');
const path = require('path');
const pool = require('../config/db');

async function importarClasificador() {
  const filePath = path.join(__dirname, 'clasificador_ocurrencias_2025_plano.json');
  const raw = fs.readFileSync(filePath, 'utf8');
  const data = JSON.parse(raw);

  for (const item of data) {
    await pool.query(
      `
      INSERT INTO clasificador_incidencias
      (modalidad_codigo, modalidad_nombre, subtipo_codigo, subtipo_nombre, tipo_codigo, tipo_nombre, activo, orden)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (modalidad_codigo, subtipo_codigo, tipo_codigo)
      DO UPDATE SET
        modalidad_nombre = EXCLUDED.modalidad_nombre,
        subtipo_nombre = EXCLUDED.subtipo_nombre,
        tipo_nombre = EXCLUDED.tipo_nombre,
        activo = EXCLUDED.activo,
        orden = EXCLUDED.orden
      `,
      [
        item.modalidad_codigo,
        item.modalidad_nombre,
        item.subtipo_codigo,
        item.subtipo_nombre,
        item.tipo_codigo,
        item.tipo_nombre,
        item.activo,
        item.orden
      ]
    );
  }

  console.log(`Importación completada: ${data.length} registros`);
  await pool.end();
}

importarClasificador().catch(err => {
  console.error('Error al importar:', err);
  pool.end();
});

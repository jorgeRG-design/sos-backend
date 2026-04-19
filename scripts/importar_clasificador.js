/**
 * importar_clasificador.js
 * Carga el archivo clasificador_ocurrencias_2025_plano.json en la tabla
 * `tipificacion`. Limpia datos anteriores e inserta el nuevo catálogo.
 *
 * Formato del JSON:
 *   { "nivel1": string, "nivel2": string, "nivel3": string, "descripcion": string }
 *
 * Uso: node scripts/importar_clasificador.js
 */

require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const pool = require('../config/db');

const ARCHIVO = path.join(__dirname, 'clasificador_ocurrencias_2025_plano.json');

function generarCodigo(index) {
  return `TIP-${String(index + 1).padStart(5, '0')}`;
}

async function importar() {
  const raw  = fs.readFileSync(ARCHIVO, 'utf8');
  const data = JSON.parse(raw);

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('El archivo JSON está vacío o no tiene el formato esperado.');
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Vaciar tabla para reemplazar el catálogo completo
    await client.query('TRUNCATE public.tipificacion RESTART IDENTITY CASCADE');

    let insertados = 0;
    let omitidos   = 0;

    for (let i = 0; i < data.length; i++) {
      const item = data[i];

      const nivel1      = String(item.nivel1      || '').trim();
      const nivel2      = String(item.nivel2      || '').trim();
      const nivel3      = String(item.nivel3      || '').trim();
      const descripcion = String(item.descripcion || '').trim() || null;

      if (!nivel1 || !nivel2 || !nivel3) {
        console.warn(`Fila ${i + 1} omitida: nivel1, nivel2 o nivel3 vacíos.`);
        omitidos++;
        continue;
      }

      await client.query(
        `INSERT INTO public.tipificacion
           (nivel1, nivel2, nivel3, descripcion, codigo_autogenerado, activo, orden)
         VALUES ($1, $2, $3, $4, $5, TRUE, $6)
         ON CONFLICT ON CONSTRAINT uq_tipificacion_jerarquia
         DO UPDATE SET
           descripcion         = EXCLUDED.descripcion,
           codigo_autogenerado = EXCLUDED.codigo_autogenerado,
           orden               = EXCLUDED.orden`,
        [nivel1, nivel2, nivel3, descripcion, generarCodigo(i), i + 1]
      );
      insertados++;
    }

    await client.query('COMMIT');
    console.log(`✓ Importación completada: ${insertados} registros, ${omitidos} omitidos.`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

importar()
  .catch((err) => {
    console.error('✗ Error al importar:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

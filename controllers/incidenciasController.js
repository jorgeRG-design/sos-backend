const pool = require('../config/db');
const dbFirestore = require('../config/firebase');
const admin = require('firebase-admin');
const { sendOk, sendError } = require('../utils/apiResponse');
const { registrarEventoSeguro } = require('../services/auditoriaService');
const { AUDIT_ACTIONS } = require('../utils/auditCatalog');
const {
  validarCreacionIncidencia,
  validarCierreIncidencia
} = require('../validators/incidenciasValidator');

/** Prefijos con correlativo propio (empiezan en 00001). */
const PREFIJO_POR_AGENCIA = {
  'Tránsito y Transporte': 'TRANSP',
  'Fiscalización': 'FISCA',
  'Gestión de Riesgos': 'DESAS',
  Serenazgo: 'SERE',
};

const ORIGENES_TECNICOS = {
  REGISTRO_MANUAL: 'registro_manual',
  BOTON_PANICO: 'boton_panico'
};

function normalizarTextoComparable(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function pareceBotonPanico(...values) {
  return values.some((value) => {
    const txt = normalizarTextoComparable(value);
    if (!txt) return false;
    return (
      txt.includes('boton de panico') ||
      txt.includes('boton panico') ||
      txt.includes('panico')
    );
  });
}

function resolverOrigenTecnico(body) {
  const origen = normalizarTextoComparable(body.origen);
  if (origen === ORIGENES_TECNICOS.REGISTRO_MANUAL) {
    return ORIGENES_TECNICOS.REGISTRO_MANUAL;
  }
  if (origen === ORIGENES_TECNICOS.BOTON_PANICO) {
    return ORIGENES_TECNICOS.BOTON_PANICO;
  }
  if (
    pareceBotonPanico(
      body.origen,
      body.fuente,
      body.tipologia_subtipo,
      body.detalle_preliminar
    )
  ) {
    return ORIGENES_TECNICOS.BOTON_PANICO;
  }
  return null;
}

async function asegurarTablaContadores(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ticket_contadores (
      prefijo VARCHAR(32) PRIMARY KEY,
      siguiente INTEGER NOT NULL DEFAULT 0
    )
  `);
}

/**
 * Siguiente número para el prefijo (1, 2, 3…). Ticket formado: PREFIJO-00001
 */
async function siguienteNumeroTicket(client, prefijo) {
  await asegurarTablaContadores(client);
  const up = await client.query(
    `UPDATE ticket_contadores SET siguiente = siguiente + 1 WHERE prefijo = $1 RETURNING siguiente`,
    [prefijo]
  );
  if (up.rows.length > 0) {
    return Number(up.rows[0].siguiente);
  }
  await client.query(
    `INSERT INTO ticket_contadores (prefijo, siguiente) VALUES ($1, 1)`,
    [prefijo]
  );
  return 1;
}

function resolverPrefijoTicket(body) {
  const origenTecnico = resolverOrigenTecnico(body);
  if (origenTecnico === ORIGENES_TECNICOS.BOTON_PANICO) {
    return 'BTNPAN';
  }
  const fuente = `${body.fuente || ''} ${body.origen || ''}`.toLowerCase();
  if (
    fuente.includes('pánico') ||
    fuente.includes('panico') ||
    fuente.includes('botón') ||
    fuente.includes('boton')
  ) {
    return 'BTNPAN';
  }
  const ag = (body.agencia_responsable || '').trim();
  return PREFIJO_POR_AGENCIA[ag] || 'SERE';
}

/** Efectivos: array nuevo o un solo efectivo legacy (compatibilidad). */
function normalizarEfectivosAsignados(body) {
  const raw = body.efectivos_asignados;
  if (Array.isArray(raw) && raw.length > 0) {
    return raw
      .map((e, i) => ({
        dni: e.dni != null ? String(e.dni).trim() : '',
        nombre: e.nombre != null ? String(e.nombre).trim() : '',
        orden: Number.isFinite(e.orden) ? e.orden : i
      }))
      .filter((e) => e.dni || e.nombre);
  }
  const dni = body.efectivo_asignado_dni != null ? String(body.efectivo_asignado_dni).trim() : '';
  const nombre =
    body.efectivo_asignado_nombre != null ? String(body.efectivo_asignado_nombre).trim() : '';
  if (dni || nombre) {
    return [{ dni, nombre, orden: 0 }];
  }
  return [];
}

/** Vehículos: array nuevo o un solo vehículo legacy. */
function normalizarVehiculosAsignados(body) {
  const raw = body.vehiculos_asignados;
  if (Array.isArray(raw) && raw.length > 0) {
    return raw.map((v, i) => ({
      vehiculo_codigo: v.vehiculo_codigo != null ? String(v.vehiculo_codigo).trim() : null,
      vehiculo_alias: v.vehiculo_alias != null ? String(v.vehiculo_alias).trim() : null,
      placa: v.placa != null ? String(v.placa).trim() : null,
      tipo: v.tipo != null ? String(v.tipo).trim() : null,
      texto_asignado: v.texto_asignado != null ? String(v.texto_asignado).trim() : null,
      orden: Number.isFinite(v.orden) ? v.orden : i
    }));
  }
  const texto =
    body.vehiculo_asignado != null ? String(body.vehiculo_asignado).trim() : '';
  const codigo = body.vehiculo_codigo != null ? String(body.vehiculo_codigo).trim() : '';
  const alias = body.vehiculo_alias != null ? String(body.vehiculo_alias).trim() : '';
  const placa = body.vehiculo_placa != null ? String(body.vehiculo_placa).trim() : '';
  const tipo = body.vehiculo_tipo != null ? String(body.vehiculo_tipo).trim() : '';
  if (texto || codigo || alias || placa || tipo) {
    return [
      {
        vehiculo_codigo: codigo || null,
        vehiculo_alias: alias || null,
        placa: placa || null,
        tipo: tipo || null,
        texto_asignado: texto || null,
        orden: 0
      }
    ];
  }
  return [];
}

function normalizarHoraSql(val) {
  if (val == null || val === '') return null;
  const s = String(val).trim();
  if (!s) return null;
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(s)) return s.length === 5 ? `${s}:00` : s;
  return null;
}

function normalizarEnteroNullable(value) {
  if (value == null) return null;
  const txt = String(value).trim();
  if (!txt) return null;
  const parsed = Number(txt);
  return Number.isInteger(parsed) ? parsed : null;
}

function normalizarDniOperativo(value) {
  if (value == null) return null;
  const txt = String(value).trim();
  if (!txt) return null;
  return /^\d{8}$/.test(txt) ? txt : null;
}

exports.crearIncidencia = async (req, res) => {
  let client = null;
  let clientReleased = false;
  let sqlCommitted = false;
  let incidenciaId = null;

  try {
    const erroresValidacion = validarCreacionIncidencia(req.body || {});
    if (erroresValidacion.length > 0) {
      await registrarEventoSeguro({
        req,
        accion: AUDIT_ACTIONS.INCIDENCIA_CREATE,
        objetoTipo: 'incidencia',
        resultado: 'error',
        detalle: 'Payload invalido al crear incidencia.',
        metadata: {
          errores: erroresValidacion
        }
      });
      return sendError(res, {
        status: 400,
        code: 'invalid_incidencia_payload',
        message:
          erroresValidacion[0] || 'Datos invalidos para crear la incidencia.'
      });
    }

    const {
      fuente,
      origen,
      agencia_responsable,
      tipologia_modalidad,
      tipologia_subtipo,
      tipologia_tipo,
      tipificacion,
      sector,
      sector_id,
      sector_nombre,
      direccion_referencial,
      detalle_preliminar,
      solicitante,
      comunicante_dni,
      comunicante_nombres,
      comunicante_celular,
      latitud,
      longitud,
      estado,
      operador_registro,
      efectivo_asignado_dni,
      efectivo_asignado_nombre,
      vehiculo_asignado,
      medio_comunicacion,
      persona_contactada,
      vehiculo_codigo,
      vehiculo_alias,
      vehiculo_placa,
      vehiculo_tipo,
      alerta_firestore_id,
      alertaFirestoreId,
      hora_alerta,
      manzana,
      lote,
      tipo_zona,
      nombre_zona,
      ubigeo_departamento,
      ubigeo_provincia,
      ubigeo_distrito,
    } = req.body;

    /** Si viene de "completar incidencia" (botón de pánico ya tiene doc en Firestore): merge, no .add() */
    const idDocFirestoreExistente = String(
      alerta_firestore_id || alertaFirestoreId || ''
    ).trim();

    const origenTecnico =
      resolverOrigenTecnico(req.body) || ORIGENES_TECNICOS.REGISTRO_MANUAL;
    const tipologiaTipoFinal = tipologia_tipo || tipificacion || null;

    const listaEfectivos = normalizarEfectivosAsignados(req.body);
    const listaVehiculos = normalizarVehiculosAsignados(req.body);

    const primeroEf = listaEfectivos[0] || null;
    const primeroVeh = listaVehiculos[0] || null;

    const legacyEfectivoDni = primeroEf?.dni || efectivo_asignado_dni || null;
    const legacyEfectivoNombre = primeroEf?.nombre || efectivo_asignado_nombre || null;
    const legacyVehiculoAsignado =
      primeroVeh?.texto_asignado ||
      vehiculo_asignado ||
      (primeroVeh?.placa ? String(primeroVeh.placa).toUpperCase() : null) ||
      primeroVeh?.vehiculo_alias ||
      null;
    const legacyVehCodigo = primeroVeh?.vehiculo_codigo || vehiculo_codigo || null;
    const legacyVehAlias = primeroVeh?.vehiculo_alias || vehiculo_alias || null;
    const legacyVehPlaca = primeroVeh?.placa || vehiculo_placa || null;
    const legacyVehTipo = primeroVeh?.tipo || vehiculo_tipo || null;

    const horaAlertaSql = normalizarHoraSql(hora_alerta);
    const ubigeoDep = (ubigeo_departamento || 'Lima').trim();
    const ubigeoProv = (ubigeo_provincia || 'Lima').trim();
    const ubigeoDist = (ubigeo_distrito || 'Santa Anita').trim();
    const sectorIdNormalizado = normalizarEnteroNullable(sector_id);
    const sectorNombreNormalizado =
      sector_nombre != null && String(sector_nombre).trim() !== ''
        ? String(sector_nombre).trim()
        : null;
    const efectivosFirestore = listaEfectivos.map((e) => ({
      dni: e.dni || null,
      nombre: e.nombre || null
    }));
    const vehiculosFirestore = listaVehiculos.map((v) => ({
      vehiculo_codigo: v.vehiculo_codigo || null,
      vehiculo_alias: v.vehiculo_alias || null,
      placa: v.placa || null,
      tipo: v.tipo || null,
      texto_asignado: v.texto_asignado || null
    }));

    const trimTxt = (v) =>
      v != null && String(v).trim() !== '' ? String(v).trim() : '';
    const comDni = trimTxt(comunicante_dni);
    const comCel = trimTxt(comunicante_celular);
    const comNom = trimTxt(comunicante_nombres);
    const dnisUnicos = [...new Set(listaEfectivos.map((e) => e.dni).filter(Boolean))];

    if (idDocFirestoreExistente) {
      const existente = await pool.query(
        `SELECT * FROM incidencias
         WHERE alerta_firestore_id = $1
         ORDER BY id DESC
         LIMIT 1`,
        [idDocFirestoreExistente]
      );
      if (existente.rows.length > 0) {
        const row = existente.rows[0];
        incidenciaId = row.id;

        client = await pool.connect();
        await client.query('BEGIN');

        const updateResult = await client.query(
          `UPDATE incidencias
           SET fuente = $2,
               origen = $3,
               agencia_responsable = $4,
               tipo = $5,
               tipologia_modalidad = $6,
               tipologia_subtipo = $7,
               tipologia_tipo = $8,
               sector = $9,
               sector_id = $10,
               sector_nombre = $11,
               descripcion = $12,
               detalle_preliminar = $13,
               estado = $14,
               operador_registro = $15,
               usuario = $16,
               latitud = $17,
               longitud = $18,
               direccion_referencial = $19,
               solicitante = $20,
               comunicante_dni = $21,
               comunicante_nombres = $22,
               comunicante_celular = $23,
               efectivo_asignado_dni = $24,
               efectivo_asignado_nombre = $25,
               vehiculo_asignado = $26,
               vehiculo_codigo = $27,
               vehiculo_alias = $28,
               placa_vehiculo = $29,
               tipo_vehiculo = $30,
               medio_comunicacion = $31,
               persona_contactada = $32,
               alerta_firestore_id = $33,
               hora_alerta = $34,
               manzana = $35,
               lote = $36,
               tipo_zona = $37,
               nombre_zona = $38,
               ubigeo_departamento = $39,
               ubigeo_provincia = $40,
               ubigeo_distrito = $41,
               fecha_actualizacion = NOW()
           WHERE id = $1
           RETURNING *`,
          [
            row.id,
            fuente || null,
            origenTecnico,
            agencia_responsable || null,
            tipologiaTipoFinal,
            tipologia_modalidad || null,
            tipologia_subtipo || null,
            tipologiaTipoFinal,
            sector || null,
            sectorIdNormalizado,
            sectorNombreNormalizado,
            detalle_preliminar || null,
            detalle_preliminar || null,
            estado || 'pendiente',
            operador_registro || null,
            operador_registro || null,
            latitud ?? null,
            longitud ?? null,
            direccion_referencial || null,
            solicitante || 'AnÃ³nimo',
            comunicante_dni || null,
            comunicante_nombres || null,
            comunicante_celular || null,
            legacyEfectivoDni,
            legacyEfectivoNombre,
            legacyVehiculoAsignado,
            legacyVehCodigo,
            legacyVehAlias,
            legacyVehPlaca,
            legacyVehTipo,
            medio_comunicacion || null,
            persona_contactada || null,
            idDocFirestoreExistente,
            horaAlertaSql,
            manzana != null && String(manzana).trim() !== '' ? String(manzana).trim() : null,
            lote != null && String(lote).trim() !== '' ? String(lote).trim() : null,
            tipo_zona != null && String(tipo_zona).trim() !== '' ? String(tipo_zona).trim() : null,
            nombre_zona != null && String(nombre_zona).trim() !== '' ? String(nombre_zona).trim() : null,
            ubigeoDep,
            ubigeoProv,
            ubigeoDist
          ]
        );

        await client.query(
          `DELETE FROM incidencia_efectivos WHERE incidencia_id = $1`,
          [row.id]
        );
        await client.query(
          `DELETE FROM incidencia_vehiculos_asignados WHERE incidencia_id = $1`,
          [row.id]
        );

        for (let i = 0; i < listaEfectivos.length; i += 1) {
          const ef = listaEfectivos[i];
          await client.query(
            `INSERT INTO incidencia_efectivos (incidencia_id, dni, nombre, orden)
             VALUES ($1, $2, $3, $4)`,
            [row.id, ef.dni || null, ef.nombre || null, ef.orden ?? i]
          );
        }

        for (let i = 0; i < listaVehiculos.length; i += 1) {
          const v = listaVehiculos[i];
          await client.query(
            `INSERT INTO incidencia_vehiculos_asignados (
               incidencia_id, vehiculo_codigo, vehiculo_alias, placa, tipo, texto_asignado, orden
             ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              row.id,
              v.vehiculo_codigo || null,
              v.vehiculo_alias || null,
              v.placa || null,
              v.tipo || null,
              v.texto_asignado || null,
              v.orden ?? i
            ]
          );
        }

        await client.query('COMMIT');
        sqlCommitted = true;
        client.release();
        clientReleased = true;

        const updatedRow = updateResult.rows[0];
        const firestoreDataExistente = {
          incidencia_id: row.id,
          ticket: updatedRow.ticket,
          ticket_prefijo: String(updatedRow.ticket || '').split('-')[0] || null,
          numero_incidencia: updatedRow.numero_incidencia,
          fuente: fuente || null,
          origen: origenTecnico,
          agencia_responsable: agencia_responsable || null,
          tipificacion: tipificacion || tipologiaTipoFinal || null,
          tipologia_modalidad: tipologia_modalidad || null,
          tipologia_subtipo: tipologia_subtipo || null,
          tipologia_tipo: tipologiaTipoFinal,
          sector: sector || null,
          sector_id: sectorIdNormalizado,
          sector_nombre: sectorNombreNormalizado,
          direccion_referencial: direccion_referencial || null,
          detalle_preliminar: detalle_preliminar || null,
          solicitante: solicitante || 'AnÃ³nimo',
          latitud: latitud ?? null,
          longitud: longitud ?? null,
          estado: estado || 'pendiente',
          operador_registro: operador_registro || null,
          efectivo_asignado_dni: legacyEfectivoDni,
          efectivo_asignado_nombre: legacyEfectivoNombre,
          vehiculo_asignado: legacyVehiculoAsignado,
          medio_comunicacion: medio_comunicacion || null,
          persona_contactada: persona_contactada || null,
          vehiculo_codigo: legacyVehCodigo,
          vehiculo_alias: legacyVehAlias,
          vehiculo_placa: legacyVehPlaca,
          vehiculo_tipo: legacyVehTipo,
          efectivos_asignados: efectivosFirestore,
          vehiculos_asignados: vehiculosFirestore,
          hora_alerta: horaAlertaSql,
          manzana: manzana != null && String(manzana).trim() !== '' ? String(manzana).trim() : null,
          lote: lote != null && String(lote).trim() !== '' ? String(lote).trim() : null,
          tipo_zona: tipo_zona != null && String(tipo_zona).trim() !== '' ? String(tipo_zona).trim() : null,
          nombre_zona: nombre_zona != null && String(nombre_zona).trim() !== '' ? String(nombre_zona).trim() : null,
          ubigeo_departamento: ubigeoDep,
          ubigeo_provincia: ubigeoProv,
          ubigeo_distrito: ubigeoDist,
          ubigeo: { departamento: ubigeoDep, provincia: ubigeoProv, distrito: ubigeoDist },
          sincronizado_postgres: true,
          fecha_actualizacion: admin.firestore.FieldValue.serverTimestamp()
        };

        if (comDni) {
          firestoreDataExistente.comunicante_dni = comDni;
          firestoreDataExistente.dni_emisor = comDni;
        }
        if (comCel) {
          firestoreDataExistente.comunicante_celular = comCel;
          firestoreDataExistente.telefono = comCel;
        }
        if (comNom) {
          firestoreDataExistente.comunicante_nombres = comNom;
        }

        await dbFirestore
          .collection('alertas')
          .doc(idDocFirestoreExistente)
          .set(firestoreDataExistente, { merge: true });

        for (const dniU of dnisUnicos) {
          const unidadRef = dbFirestore.collection('unidades').doc(String(dniU));
          const unidadSnap = await unidadRef.get();
          if (unidadSnap.exists) {
            await unidadRef.update({
              estado: 'en_intervencion',
              ticket_actual: updatedRow.ticket,
              fecha_actualizacion: admin.firestore.FieldValue.serverTimestamp()
            });
          }
        }

        await registrarEventoSeguro({
          req,
          accion: AUDIT_ACTIONS.INCIDENCIA_CREATE,
          objetoTipo: 'incidencia',
          objetoId: String(row.id),
          resultado: 'success',
          detalle: 'Incidencia preregistrada actualizada y vinculada correctamente.',
          metadata: {
            ticket: updatedRow.ticket,
            firestore_id: idDocFirestoreExistente,
            reutilizada: true,
            origen: origenTecnico,
            fuente: fuente || null
          }
        });

        return sendOk(res, {
          status: 200,
          message: 'Incidencia ya registrada previamente',
          data: {
            ...updatedRow,
            incidencia_id: row.id,
            firestore_id: idDocFirestoreExistente
          },
          legacy: {
            id: row.id,
            incidencia_id: row.id,
            mensaje: 'Incidencia ya registrada previamente',
            ticket: updatedRow.ticket,
            numero_incidencia: updatedRow.numero_incidencia,
            firestore_id: idDocFirestoreExistente,
            firestore_actualizado: true
          }
        });
      }
    }

    client = await pool.connect();
    await client.query('BEGIN');

    const prefijo = resolverPrefijoTicket({ ...req.body, origen: origenTecnico });
    const n = await siguienteNumeroTicket(client, prefijo);
    const numero_incidencia = n;
    const ticket = `${prefijo}-${String(n).padStart(5, '0')}`;

    const sql = `
      INSERT INTO incidencias (
        ticket,
        numero_incidencia,
        fuente,
        origen,
        agencia_responsable,
        tipo,
        tipologia_modalidad,
        tipologia_subtipo,
        tipologia_tipo,
        sector,
        sector_id,
        sector_nombre,
        descripcion,
        detalle_preliminar,
        estado,
        operador_registro,
        usuario,
        latitud,
        longitud,
        direccion_referencial,
        solicitante,
        comunicante_dni,
        comunicante_nombres,
        comunicante_celular,
        efectivo_asignado_dni,
        efectivo_asignado_nombre,
        vehiculo_asignado,
        vehiculo_codigo,
        vehiculo_alias,
        placa_vehiculo,
        tipo_vehiculo,
        medio_comunicacion,
        persona_contactada,
        alerta_firestore_id,
        hora_alerta,
        manzana,
        lote,
        tipo_zona,
        nombre_zona,
        ubigeo_departamento,
        ubigeo_provincia,
        ubigeo_distrito,
        fecha
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
        $21, $22, $23, $24, $25, $26, $27, $28, $29, $30,
        $31, $32, $33, $34, $35, $36, $37, $38, $39, $40,
        $41, $42,
        NOW()
      )
      RETURNING *;
    `;

    const values = [
      ticket,
      numero_incidencia,
      fuente || null,
      origenTecnico,
      agencia_responsable || null,
      tipologiaTipoFinal,
      tipologia_modalidad || null,
      tipologia_subtipo || null,
      tipologiaTipoFinal,
      sector || null,
      sectorIdNormalizado,
      sectorNombreNormalizado,
      detalle_preliminar || null,
      detalle_preliminar || null,
      estado || 'pendiente',
      operador_registro || null,
      operador_registro || null,
      latitud ?? null,
      longitud ?? null,
      direccion_referencial || null,
      solicitante || 'Anónimo',
      comunicante_dni || null,
      comunicante_nombres || null,
      comunicante_celular || null,
      legacyEfectivoDni,
      legacyEfectivoNombre,
      legacyVehiculoAsignado,
      legacyVehCodigo,
      legacyVehAlias,
      legacyVehPlaca,
      legacyVehTipo,
      medio_comunicacion || null,
      persona_contactada || null,
      idDocFirestoreExistente || null,
      horaAlertaSql,
      manzana != null && String(manzana).trim() !== '' ? String(manzana).trim() : null,
      lote != null && String(lote).trim() !== '' ? String(lote).trim() : null,
      tipo_zona != null && String(tipo_zona).trim() !== '' ? String(tipo_zona).trim() : null,
      nombre_zona != null && String(nombre_zona).trim() !== '' ? String(nombre_zona).trim() : null,
      ubigeoDep,
      ubigeoProv,
      ubigeoDist
    ];

    const resultado = await client.query(sql, values);
    const incidenciaRow = resultado.rows[0];
    incidenciaId = incidenciaRow.id;
    let incidenciaResponseRow = incidenciaRow;

    for (let i = 0; i < listaEfectivos.length; i += 1) {
      const ef = listaEfectivos[i];
      await client.query(
        `INSERT INTO incidencia_efectivos (incidencia_id, dni, nombre, orden)
         VALUES ($1, $2, $3, $4)`,
        [incidenciaId, ef.dni || null, ef.nombre || null, ef.orden ?? i]
      );
    }

    for (let i = 0; i < listaVehiculos.length; i += 1) {
      const v = listaVehiculos[i];
      await client.query(
        `INSERT INTO incidencia_vehiculos_asignados (
           incidencia_id, vehiculo_codigo, vehiculo_alias, placa, tipo, texto_asignado, orden
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          incidenciaId,
          v.vehiculo_codigo || null,
          v.vehiculo_alias || null,
          v.placa || null,
          v.tipo || null,
          v.texto_asignado || null,
          v.orden ?? i
        ]
      );
    }

    const firestoreData = {
      incidencia_id: incidenciaId,
      ticket,
      ticket_prefijo: prefijo,
      numero_incidencia,
      fuente: fuente || null,
      origen: origenTecnico,
      agencia_responsable: agencia_responsable || null,
      tipificacion: tipificacion || tipologiaTipoFinal || null,
      tipologia_modalidad: tipologia_modalidad || null,
      tipologia_subtipo: tipologia_subtipo || null,
      tipologia_tipo: tipologiaTipoFinal,
      sector: sector || null,
      sector_id: sectorIdNormalizado,
      sector_nombre: sectorNombreNormalizado,
      direccion_referencial: direccion_referencial || null,
      detalle_preliminar: detalle_preliminar || null,
      solicitante: solicitante || 'Anónimo',
      latitud: latitud ?? null,
      longitud: longitud ?? null,
      estado: estado || 'pendiente',
      operador_registro: operador_registro || null,
      efectivo_asignado_dni: legacyEfectivoDni,
      efectivo_asignado_nombre: legacyEfectivoNombre,
      vehiculo_asignado: legacyVehiculoAsignado,
      medio_comunicacion: medio_comunicacion || null,
      persona_contactada: persona_contactada || null,
      vehiculo_codigo: legacyVehCodigo,
      vehiculo_alias: legacyVehAlias,
      vehiculo_placa: legacyVehPlaca,
      vehiculo_tipo: legacyVehTipo,
      efectivos_asignados: efectivosFirestore,
      vehiculos_asignados: vehiculosFirestore,
      hora_alerta: horaAlertaSql,
      manzana: manzana != null && String(manzana).trim() !== '' ? String(manzana).trim() : null,
      lote: lote != null && String(lote).trim() !== '' ? String(lote).trim() : null,
      tipo_zona: tipo_zona != null && String(tipo_zona).trim() !== '' ? String(tipo_zona).trim() : null,
      nombre_zona: nombre_zona != null && String(nombre_zona).trim() !== '' ? String(nombre_zona).trim() : null,
      ubigeo_departamento: ubigeoDep,
      ubigeo_provincia: ubigeoProv,
      ubigeo_distrito: ubigeoDist,
      ubigeo: { departamento: ubigeoDep, provincia: ubigeoProv, distrito: ubigeoDist },
      sincronizado_postgres: true,
      fecha_hora: admin.firestore.FieldValue.serverTimestamp()
    };

    // Solo escribir datos del comunicante si vienen con valor. Si se envía null en
    // merge, Firestore puede borrar campos y perder DNI/tel. ya guardados (p. ej. app ciudadana).
    if (comDni) {
      firestoreData.comunicante_dni = comDni;
      firestoreData.dni_emisor = comDni;
    }
    if (comCel) {
      firestoreData.comunicante_celular = comCel;
      firestoreData.telefono = comCel;
    }
    if (comNom) {
      firestoreData.comunicante_nombres = comNom;
    }

    await client.query('COMMIT');
    sqlCommitted = true;
    client.release();
    clientReleased = true;

    let alertaFirestoreIdFinal = idDocFirestoreExistente || null;

    try {
      let docRef;
      if (idDocFirestoreExistente) {
        docRef = dbFirestore.collection('alertas').doc(idDocFirestoreExistente);
        await docRef.set(firestoreData, { merge: true });
      } else {
        docRef = await dbFirestore.collection('alertas').add(firestoreData);
      }

      alertaFirestoreIdFinal = idDocFirestoreExistente || docRef.id;

      if (!idDocFirestoreExistente && alertaFirestoreIdFinal) {
        const updateAlertaIdResult = await pool.query(
          `UPDATE incidencias
           SET alerta_firestore_id = $2,
               fecha_actualizacion = NOW()
           WHERE id = $1
           RETURNING *`,
          [incidenciaId, alertaFirestoreIdFinal]
        );

        if (updateAlertaIdResult.rows.length > 0) {
          incidenciaResponseRow = updateAlertaIdResult.rows[0];
        }
      }

      for (const dniU of dnisUnicos) {
        const unidadRef = dbFirestore.collection('unidades').doc(String(dniU));
        const unidadSnap = await unidadRef.get();
        if (unidadSnap.exists) {
          await unidadRef.update({
            estado: 'en_intervencion',
            ticket_actual: ticket,
            fecha_actualizacion: admin.firestore.FieldValue.serverTimestamp()
          });
        }
      }
    } catch (firestoreError) {
      try {
        await pool.query(`DELETE FROM incidencias WHERE id = $1`, [incidenciaId]);
      } catch (compensationError) {
        console.error(
          `[CrearIncidencia] Fallo la compensacion SQL inmediata para la incidencia ${incidenciaId}:`,
          compensationError
        );
      }
      throw firestoreError;
    }

    await registrarEventoSeguro({
      req,
      accion: AUDIT_ACTIONS.INCIDENCIA_CREATE,
      objetoTipo: 'incidencia',
      objetoId: String(incidenciaId),
      resultado: 'success',
      detalle: `Incidencia ${ticket} registrada correctamente.`,
      metadata: {
        ticket,
        firestore_id: alertaFirestoreIdFinal,
        origen: origenTecnico,
        fuente: fuente || null
      }
    });

    return sendOk(res, {
      status: 201,
      message: 'Incidencia registrada con exito',
      data: {
        ...incidenciaResponseRow,
        incidencia_id: incidenciaId,
        firestore_id: alertaFirestoreIdFinal
      },
      legacy: {
        id: incidenciaId,
        incidencia_id: incidenciaId,
        mensaje: 'Incidencia registrada con exito',
        ticket,
        numero_incidencia,
        firestore_id: alertaFirestoreIdFinal,
        firestore_actualizado: Boolean(idDocFirestoreExistente)
      }
    });
  } catch (error) {
    if (!sqlCommitted && client && !clientReleased) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('[CrearIncidencia] Fallo al revertir la transaccion:', rollbackError);
      }
    }
    console.error('❌ Error al registrar incidencia:', error);
    await registrarEventoSeguro({
      req,
      accion: AUDIT_ACTIONS.INCIDENCIA_CREATE,
      objetoTipo: 'incidencia',
      resultado: 'error',
      detalle: 'Fallo interno al registrar incidencia.',
      metadata: {
        error: error.message
      }
    });
    return sendError(res, {
      status: 500,
      code: 'incidencia_create_failed',
      message: 'No se pudo registrar la incidencia.'
    });
  } finally {
    if (client && !clientReleased) {
      client.release();
    }
  }
};

exports.cerrarIncidencia = async (req, res) => {
  const client = await pool.connect();

  try {
    const erroresValidacion = validarCierreIncidencia(req.body || {});
    if (erroresValidacion.length > 0) {
      await registrarEventoSeguro({
        req,
        accion: AUDIT_ACTIONS.INCIDENCIA_CLOSE,
        objetoTipo: 'incidencia',
        objetoId: String(req.body?.ticket || '').trim() || null,
        resultado: 'error',
        detalle: 'Payload invalido al cerrar incidencia.',
        metadata: {
          errores: erroresValidacion
        }
      });
      return sendError(res, {
        status: 400,
        code: 'invalid_cierre_payload',
        message: erroresValidacion[0]
      });
    }

    const {
      ticket,
      tipologia_modalidad,
      tipologia_subtipo,
      tipologia_tipo,
      codigo_ocurrencia,
      turno,
      modalidad_patrullaje,
      tipo_patrullaje,
      placa_vehiculo,
      tipo_vehiculo,

      pnp_grado,
      pnp_apellidos_nombres,
      pnp_dni_cip,
      pnp_comisaria,

      hora_alerta,
      hora_llegada,
      hora_repliegue,
      fecha_ocurrencia,
      dia_semana,
      mes,

      desarrollo_hechos,
      resultado_final,
      consecuencia,
      lugar_ocurrencia,
      medio_utilizado,

      tipo_via,
      direccion,
      referencia,
      manzana,
      lote,
      tipo_zona,
      nombre_zona,
      sector_patrullaje,
      latitud,
      longitud,
      datos_importantes,

      traslado_comisaria,
      traslado_hospital,
      traslado_otra_dependencia,
      detalle_traslado,

      involucrados,
      apoyo_pnp,

      cerrado_por,
      dni_efectivo,
      cumplio_sla,
      minutos_totales,
      operador_cierre,

      relacion_victima_victimario
    } = req.body;

    if (!ticket) {
      await registrarEventoSeguro({
        req,
        accion: AUDIT_ACTIONS.INCIDENCIA_CLOSE,
        objetoTipo: 'incidencia',
        resultado: 'error',
        detalle: 'Intento de cierre sin ticket.'
      });
      return sendError(res, {
        status: 400,
        code: 'missing_ticket',
        message: 'El ticket es obligatorio'
      });
    }

    await client.query('BEGIN');

    const incidenciaResult = await client.query(
      `SELECT id, alerta_firestore_id FROM incidencias WHERE ticket = $1 LIMIT 1`,
      [ticket]
    );

    if (incidenciaResult.rows.length === 0) {
      await client.query('ROLLBACK');
      await registrarEventoSeguro({
        req,
        accion: AUDIT_ACTIONS.INCIDENCIA_CLOSE,
        objetoTipo: 'incidencia',
        objetoId: String(ticket),
        resultado: 'error',
        detalle: 'No se encontro la incidencia para cerrar.'
      });
      return sendError(res, {
        status: 404,
        code: 'incidencia_not_found',
        message: 'No se encontró la incidencia con ese ticket'
      });
    }

    const incidenciaId = incidenciaResult.rows[0].id;
    const alertaFirestoreId = incidenciaResult.rows[0].alerta_firestore_id || null;
    const dniCierrePrincipal = normalizarDniOperativo(dni_efectivo);
    const dniCierreFallback = normalizarDniOperativo(operador_cierre);
    const dniOperativoTecnico = dniCierrePrincipal || dniCierreFallback;
    const updateSql = `
      UPDATE incidencias
      SET
        estado = 'resuelta',
        tipologia_modalidad = COALESCE($2, tipologia_modalidad),
        tipologia_subtipo = COALESCE($3, tipologia_subtipo),
        tipologia_tipo = COALESCE($4, tipologia_tipo),
        tipo = COALESCE($4, tipo),
        codigo_ocurrencia = $5,
        turno = $6,
        modalidad_patrullaje = $7,
        tipo_patrullaje = $8,
        placa_vehiculo = $9,
        tipo_vehiculo = $10,
        pnp_grado = $11,
        pnp_apellidos_nombres = $12,
        pnp_dni_cip = $13,
        pnp_comisaria = $14,
        hora_alerta = $15,
        hora_llegada = $16,
        hora_repliegue = $17,
        fecha_ocurrencia = $18,
        dia_semana = $19,
        mes = $20,
        desarrollo_hechos = $21,
        detalle_preliminar = COALESCE(detalle_preliminar, $21),
        descripcion = COALESCE($21, descripcion),
        resultado_final = $22,
        consecuencia = $23,
        lugar_ocurrencia = $24,
        medio_utilizado = $25,
        tipo_via = $26,
        direccion = $27,
        referencia = $28,
        manzana = $29,
        lote = $30,
        tipo_zona = $31,
        nombre_zona = $32,
        sector_patrullaje = $33,
        latitud = COALESCE($34, latitud),
        longitud = COALESCE($35, longitud),
        datos_importantes = $36,
        traslado_comisaria = COALESCE($37, FALSE),
        traslado_hospital = COALESCE($38, FALSE),
        traslado_otra_dependencia = COALESCE($39, FALSE),
        detalle_traslado = $40,
        fecha_cierre = NOW(),
        operador_cierre = $41,
        minutos_totales = COALESCE($42, minutos_totales),
        cumplio_sla = COALESCE($43, cumplio_sla),
        dni_efectivo = COALESCE($44, dni_efectivo),
        relacion_victima_victimario = COALESCE($45, relacion_victima_victimario),
        fecha_actualizacion = NOW()
      WHERE ticket = $1
      RETURNING *;
    `;

    const updateValues = [
      ticket,
      tipologia_modalidad || null,
      tipologia_subtipo || null,
      tipologia_tipo || null,
      codigo_ocurrencia || null,
      turno || null,
      modalidad_patrullaje || null,
      tipo_patrullaje || null,
      placa_vehiculo || null,
      tipo_vehiculo || null,
      pnp_grado || null,
      pnp_apellidos_nombres || null,
      pnp_dni_cip || null,
      pnp_comisaria || null,
      hora_alerta || null,
      hora_llegada || null,
      hora_repliegue || null,
      fecha_ocurrencia || null,
      dia_semana || null,
      mes || null,
      desarrollo_hechos || null,
      resultado_final || null,
      consecuencia || null,
      lugar_ocurrencia || null,
      medio_utilizado || null,
      tipo_via || null,
      direccion || null,
      referencia || null,
      manzana || null,
      lote || null,
      tipo_zona || null,
      nombre_zona || null,
      sector_patrullaje || null,
      latitud ?? null,
      longitud ?? null,
      datos_importantes || null,
      traslado_comisaria ?? false,
      traslado_hospital ?? false,
      traslado_otra_dependencia ?? false,
      detalle_traslado || null,
      dniOperativoTecnico,
      minutos_totales ?? null,
      cumplio_sla ?? null,
      dniOperativoTecnico,
      relacion_victima_victimario != null && String(relacion_victima_victimario).trim() !== ''
        ? String(relacion_victima_victimario).trim()
        : null
    ];

    const updateResult = await client.query(updateSql, updateValues);

    await client.query(
      `DELETE FROM incidencia_personas WHERE incidencia_id = $1`,
      [incidenciaId]
    );

    if (Array.isArray(involucrados) && involucrados.length > 0) {
      for (const persona of involucrados) {
        await client.query(
          `
          INSERT INTO incidencia_personas (
            incidencia_id,
            tipo_participacion,
            dni,
            apellidos_nombres,
            caracteristicas,
            edad_aprox,
            sexo,
            placa,
            es_identificado
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          `,
          [
            incidenciaId,
            persona.tipo_participacion || persona.rol || 'No especificado',
            persona.dni || null,
            persona.apellidos_nombres || persona.nombres || null,
            persona.caracteristicas || null,
            persona.edad_aprox ?? persona.edad ?? null,
            persona.sexo || null,
            persona.placa || null,
            persona.es_identificado ?? null
          ]
        );
      }
    }

    await client.query(
      `DELETE FROM incidencia_apoyo_pnp WHERE incidencia_id = $1`,
      [incidenciaId]
    );

    if (Array.isArray(apoyo_pnp) && apoyo_pnp.length > 0) {
      for (const pnp of apoyo_pnp) {
        await client.query(
          `
          INSERT INTO incidencia_apoyo_pnp (
            incidencia_id,
            grado,
            apellidos_nombres,
            dni_cip,
            comisaria
          )
          VALUES ($1,$2,$3,$4,$5)
          `,
          [
            incidenciaId,
            pnp.grado || null,
            pnp.apellidos_nombres || null,
            pnp.dni_cip || null,
            pnp.comisaria || null
          ]
        );
      }
    }

    const alertaUpdatePayload = {
      estado: 'resuelta',
      tipificacion: tipologia_tipo || null,
      tipologia_modalidad: tipologia_modalidad || null,
      tipologia_subtipo: tipologia_subtipo || null,
      tipologia_tipo: tipologia_tipo || null,
      codigo_ocurrencia: codigo_ocurrencia || null,
      turno: turno || null,
      modalidad_patrullaje: modalidad_patrullaje || null,
      tipo_patrullaje: tipo_patrullaje || null,
      placa_vehiculo: placa_vehiculo || null,
      tipo_vehiculo: tipo_vehiculo || null,

      pnp_grado: pnp_grado || null,
      pnp_apellidos_nombres: pnp_apellidos_nombres || null,
      pnp_dni_cip: pnp_dni_cip || null,
      pnp_comisaria: pnp_comisaria || null,

      hora_alerta: hora_alerta || null,
      hora_llegada: hora_llegada || null,
      hora_repliegue: hora_repliegue || null,
      fecha_ocurrencia: fecha_ocurrencia || null,
      dia_semana: dia_semana || null,
      mes: mes || null,

      desarrollo_hechos: desarrollo_hechos || null,
      detalle_ocurrencia: desarrollo_hechos || null,
      resultado_intervencion: resultado_final || null,
      consecuencia: consecuencia || null,
      lugar_ocurrencia: lugar_ocurrencia || null,
      medio_utilizado: medio_utilizado || null,

      tipo_via: tipo_via || null,
      direccion: direccion || null,
      referencia: referencia || null,
      manzana: manzana || null,
      lote: lote || null,
      tipo_zona: tipo_zona || null,
      nombre_zona: nombre_zona || null,
      sector_patrullaje: sector_patrullaje || null,
      datos_importantes: datos_importantes || null,

      traslado_comisaria: traslado_comisaria ?? false,
      traslado_hospital: traslado_hospital ?? false,
      traslado_otra_dependencia: traslado_otra_dependencia ?? false,
      detalle_traslado: detalle_traslado || null,

      involucrados: Array.isArray(involucrados) ? involucrados : [],
      lista_involucrados: Array.isArray(involucrados) ? involucrados : [],
      apoyo_pnp: Array.isArray(apoyo_pnp) ? apoyo_pnp : [],
      lista_pnp: Array.isArray(apoyo_pnp) ? apoyo_pnp : [],

      cerrado_por: cerrado_por || null,
      dni_efectivo: dniOperativoTecnico,
      cumplio_sla: cumplio_sla ?? null,
      minutos_totales: minutos_totales ?? null,
      operador_cierre: dniOperativoTecnico,
      relacion_victima_victimario:
        relacion_victima_victimario != null &&
        String(relacion_victima_victimario).trim() !== ''
          ? String(relacion_victima_victimario).trim()
          : null,
      hora_cierre: admin.firestore.FieldValue.serverTimestamp()
    };

    // Mapa táctico / heatmap: NO enviar latitud/longitud como null si el cliente no las manda.
    // Firestore.update({ latitud: null }) borra el campo y el heatmap pierde el punto al pasar a "resuelta".
    const latN =
      latitud !== undefined && latitud !== null && latitud !== ''
        ? Number(latitud)
        : NaN;
    const lngN =
      longitud !== undefined && longitud !== null && longitud !== ''
        ? Number(longitud)
        : NaN;
    if (!Number.isNaN(latN) && !Number.isNaN(lngN)) {
      alertaUpdatePayload.latitud = latN;
      alertaUpdatePayload.longitud = lngN;
    }

    // Liberar todas las unidades vinculadas al ticket (legacy + tabla auditada)
    const dnisLiberar = new Set();
    if (dniOperativoTecnico) {
      dnisLiberar.add(dniOperativoTecnico);
    }
    const cierreOperacionResult = await client.query(
      `UPDATE incidencia_unidades_operacion
       SET estado_operacion = 'cerrada',
           fecha_liberacion = COALESCE(fecha_liberacion, NOW()),
           actualizado_en = NOW()
       WHERE incidencia_id = $1
         AND (fecha_liberacion IS NULL OR estado_operacion <> 'cerrada')
       RETURNING unidad_id`,
      [incidenciaId]
    );
    for (const row of cierreOperacionResult.rows) {
      if (row.unidad_id && String(row.unidad_id).trim()) {
        dnisLiberar.add(String(row.unidad_id).trim());
      }
    }
    try {
      const efCerrar = await client.query(
        `SELECT dni FROM incidencia_efectivos WHERE incidencia_id = $1`,
        [incidenciaId]
      );
      for (const r of efCerrar.rows) {
        if (r.dni && String(r.dni).trim()) dnisLiberar.add(String(r.dni).trim());
      }
    } catch (e) {
      if (!String(e.message || '').includes('incidencia_efectivos')) {
        throw e;
      }
    }

    await client.query('COMMIT');

    let firestoreSyncMeta = { firestore_sync_ok: true };
    try {
      const refsActualizar = [];
      if (alertaFirestoreId) {
        refsActualizar.push(dbFirestore.collection('alertas').doc(alertaFirestoreId));
      } else {
        const alertaSnap = await dbFirestore
          .collection('alertas')
          .where('ticket', '==', ticket)
          .get();
        for (const d of alertaSnap.docs) {
          refsActualizar.push(d.ref);
        }
      }

      if (refsActualizar.length > 0) {
        const batch = dbFirestore.batch();
        for (const ref of refsActualizar) {
          batch.set(ref, alertaUpdatePayload, { merge: true });
        }
        await batch.commit();
      }

      for (const dniU of dnisLiberar) {
        const unidadRef = dbFirestore.collection('unidades').doc(dniU);
        const unidadSnap = await unidadRef.get();
        if (unidadSnap.exists) {
          await unidadRef.update({
            estado: 'patrullando',
            ticket_actual: admin.firestore.FieldValue.delete(),
            fecha_actualizacion: admin.firestore.FieldValue.serverTimestamp()
          });
        }
      }
    } catch (firestoreError) {
      firestoreSyncMeta = {
        firestore_sync_ok: false,
        firestore_sync_error: firestoreError.message
      };
      console.error(
        `[CierreIncidencia] PostgreSQL cerrado para ${ticket}, pero fallo la sincronizacion con Firestore:`,
        firestoreError
      );
    }

    await registrarEventoSeguro({
      req,
      accion: AUDIT_ACTIONS.INCIDENCIA_CLOSE,
      objetoTipo: 'incidencia',
      objetoId: String(incidenciaId),
      resultado: 'success',
      detalle: `Incidencia ${ticket} cerrada correctamente.`,
      metadata: {
        ticket,
        firestore_sync_ok: firestoreSyncMeta.firestore_sync_ok,
        firestore_sync_error: firestoreSyncMeta.firestore_sync_error || null
      }
    });

    return sendOk(res, {
      message: firestoreSyncMeta.firestore_sync_ok
        ? 'Incidencia cerrada correctamente'
        : 'Incidencia cerrada en PostgreSQL; el espejo operativo en Firestore presento errores.',
      data: updateResult.rows[0],
      meta: firestoreSyncMeta,
      legacy: {
        mensaje: 'Incidencia cerrada correctamente'
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Error al cerrar incidencia:', error);
    await registrarEventoSeguro({
      req,
      accion: AUDIT_ACTIONS.INCIDENCIA_CLOSE,
      objetoTipo: 'incidencia',
      objetoId: String(req.body?.ticket || '').trim() || null,
      resultado: 'error',
      detalle: 'Fallo interno al cerrar incidencia.',
      metadata: {
        error: error.message
      }
    });
    return sendError(res, {
      status: 500,
      code: 'incidencia_close_failed',
      message: 'No se pudo cerrar la incidencia.'
    });
  } finally {
    client.release();
  }
};

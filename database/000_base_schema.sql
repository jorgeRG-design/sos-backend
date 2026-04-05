-- ============================================================================
-- 000_base_schema.sql
-- Esquema base minimo para poder instalar sos-backend desde una base vacia.
--
-- Este archivo crea solamente las tablas base que el codigo ya usa y que las
-- migraciones actuales asumen existentes, pero no crean por si mismas.
--
-- Despues de aplicar este archivo, se deben ejecutar TODAS las migraciones de
-- `migrations/` en orden alfabetico.
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.incidencias (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket TEXT NOT NULL,
    ticket_serie TEXT,
    numero_incidencia INTEGER NOT NULL,
    fuente TEXT,
    origen TEXT,
    agencia_responsable TEXT,
    tipo TEXT,
    tipologia_modalidad TEXT,
    tipologia_subtipo TEXT,
    tipologia_tipo TEXT,
    sector TEXT,
    sector_id INTEGER,
    sector_nombre TEXT,
    descripcion TEXT,
    detalle_preliminar TEXT,
    estado TEXT NOT NULL DEFAULT 'pendiente',
    operador_registro TEXT,
    usuario TEXT,
    operador_cierre TEXT,
    latitud DOUBLE PRECISION,
    longitud DOUBLE PRECISION,
    direccion_referencial TEXT,
    solicitante TEXT,
    comunicante_dni TEXT,
    comunicante_nombres TEXT,
    comunicante_celular TEXT,
    efectivo_asignado_dni TEXT,
    efectivo_asignado_nombre TEXT,
    vehiculo_asignado TEXT,
    vehiculo_codigo TEXT,
    vehiculo_alias TEXT,
    placa_vehiculo TEXT,
    tipo_vehiculo TEXT,
    medio_comunicacion TEXT,
    persona_contactada TEXT,
    alerta_firestore_id TEXT,
    hora_alerta TIME,
    hora_llegada TIME,
    hora_repliegue TIME,
    fecha TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    fecha_actualizacion TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    fecha_ocurrencia DATE,
    fecha_cierre TIMESTAMPTZ,
    codigo_ocurrencia TEXT,
    turno TEXT,
    modalidad_patrullaje TEXT,
    tipo_patrullaje TEXT,
    pnp_grado TEXT,
    pnp_apellidos_nombres TEXT,
    pnp_dni_cip TEXT,
    pnp_comisaria TEXT,
    dia_semana TEXT,
    mes TEXT,
    desarrollo_hechos TEXT,
    resultado_final TEXT,
    consecuencia TEXT,
    lugar_ocurrencia TEXT,
    medio_utilizado TEXT,
    tipo_via TEXT,
    direccion TEXT,
    referencia TEXT,
    manzana TEXT,
    lote TEXT,
    tipo_zona TEXT,
    nombre_zona TEXT,
    sector_patrullaje TEXT,
    datos_importantes TEXT,
    traslado_comisaria BOOLEAN NOT NULL DEFAULT FALSE,
    traslado_hospital BOOLEAN NOT NULL DEFAULT FALSE,
    traslado_otra_dependencia BOOLEAN NOT NULL DEFAULT FALSE,
    detalle_traslado TEXT,
    minutos_totales INTEGER,
    cumplio_sla BOOLEAN,
    dni_efectivo TEXT,
    relacion_victima_victimario TEXT,
    requiere_apoyo BOOLEAN NOT NULL DEFAULT FALSE,
    asignacion_central BOOLEAN NOT NULL DEFAULT FALSE,
    fecha_asignacion TIMESTAMPTZ,
    hora_aceptacion TIMESTAMPTZ,
    ultima_actualizacion_operativa TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.ticket_contadores (
    prefijo VARCHAR(32) PRIMARY KEY,
    siguiente INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.clasificador_incidencias (
    id SERIAL PRIMARY KEY,
    modalidad_codigo TEXT NOT NULL,
    modalidad_nombre TEXT NOT NULL,
    subtipo_codigo TEXT NOT NULL,
    subtipo_nombre TEXT NOT NULL,
    tipo_codigo TEXT NOT NULL,
    tipo_nombre TEXT NOT NULL,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    orden INTEGER,
    CONSTRAINT uq_clasificador_incidencias_codigo
      UNIQUE (modalidad_codigo, subtipo_codigo, tipo_codigo)
);

CREATE TABLE IF NOT EXISTS public.incidencia_personas (
    id SERIAL PRIMARY KEY,
    incidencia_id UUID NOT NULL REFERENCES public.incidencias(id) ON DELETE CASCADE,
    tipo_participacion TEXT NOT NULL,
    dni TEXT,
    apellidos_nombres TEXT,
    caracteristicas TEXT,
    edad_aprox INTEGER,
    sexo TEXT,
    placa TEXT,
    es_identificado BOOLEAN,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.incidencia_apoyo_pnp (
    id SERIAL PRIMARY KEY,
    incidencia_id UUID NOT NULL REFERENCES public.incidencias(id) ON DELETE CASCADE,
    grado TEXT,
    apellidos_nombres TEXT,
    dni_cip TEXT,
    comisaria TEXT,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.recorridos_gps (
    id SERIAL PRIMARY KEY,
    codigo TEXT NOT NULL,
    alias TEXT,
    ultimo_reporte TEXT,
    cumplio_meta BOOLEAN NOT NULL DEFAULT FALSE,
    tiempo_meta DOUBLE PRECISION,
    km_meta DOUBLE PRECISION,
    fecha_importacion TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    nombre_archivo TEXT
);

COMMIT;

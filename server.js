const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
require('dotenv').config();

const gpsController = require('./controllers/gpsController');
const incidenciasController = require('./controllers/incidenciasController');
const clasificadorController = require('./controllers/clasificadorController');
const reportesController = require('./controllers/reportesController');
const verificationCodeController = require('./controllers/verificationCodeController');
const incidenciaArchivosController = require('./controllers/incidenciaArchivosController');
const incidenciaOperacionController = require('./controllers/incidenciaOperacionController');
const auditoriaController = require('./controllers/auditoriaController');
const adminUsuariosController = require('./controllers/adminUsuariosController');
const profileAcceptanceController = require('./controllers/profileAcceptanceController');
const zonasController = require('./controllers/zonasController');
const tipificacionController = require('./controllers/tipificacionController');
const pnpController = require('./controllers/pnpController');
const mapaDelitoController = require('./controllers/mapaDelitoController');
const uploadMemory = require('./middlewares/uploadMemory');
const panicRateLimit = require('./middlewares/panicRateLimit');
const apiKeyMiddleware = require('./middlewares/auth');
const requireIncidenciaAccess = require('./middlewares/requireIncidenciaAccess');
const {
  attachActorContext,
  requireAuthenticatedActor,
  requireInstitutionalActor,
  requireCentralActor,
  requireOperativoActor,
  requireUserAdminActor
} = require('./middlewares/actorAuth');
const { sendOk, sendError } = require('./utils/apiResponse');

function parseBoolean(value, defaultValue = false) {
  if (value == null || String(value).trim() === '') {
    return defaultValue;
  }
  const normalized = String(value).trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

function parsePositiveInt(value, defaultValue) {
  if (value == null || String(value).trim() === '') {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return Math.trunc(parsed);
}

const apiKey = String(process.env.API_KEY || '').trim();
if (!apiKey) {
  throw new Error(
    'API_KEY no configurada. Defina la variable de entorno antes de iniciar sos-backend.'
  );
}

const isProduction = process.env.NODE_ENV === 'production';
const requireHttps =
  isProduction &&
  String(process.env.REQUIRE_HTTPS || 'false').trim().toLowerCase() === 'true';
const enableHttpAccessLogs =
  !isProduction || parseBoolean(process.env.ENABLE_HTTP_ACCESS_LOGS, false);
const allowedOrigins = String(process.env.CORS_ORIGINS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    if (!origin) {
      callback(null, true);
      return;
    }

    if (!isProduction && allowedOrigins.length === 0) {
      callback(null, true);
      return;
    }

    callback(null, allowedOrigins.includes(origin));
  }
};

const app = express();

if (isProduction) {
  app.set('trust proxy', 1);
}

app.use(helmet());
app.use(cors(corsOptions));
app.use(express.json());
if (enableHttpAccessLogs) {
  app.use(morgan(isProduction ? 'combined' : 'dev'));
}

if (requireHttps) {
  app.use((req, res, next) => {
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
      .split(',')[0]
      .trim()
      .toLowerCase();

    if (req.secure || forwardedProto === 'https') {
      return next();
    }

    return sendError(res, {
      status: 426,
      code: 'https_required',
      message: 'Esta API requiere HTTPS en produccion.'
    });
  });
}

// Ruta principal / salud básica
app.get('/', (req, res) => {
  res.send('API SOS Backend operativa');
});

app.get('/api/health', (req, res) => {
  return sendOk(res, {
    data: {
      service: 'sos-backend',
      status: 'up',
      time: new Date().toISOString()
    }
  });
});

// Incidencias
app.get(
  '/api/clasificador-incidencias',
  apiKeyMiddleware,
  attachActorContext,
  requireAuthenticatedActor,
  clasificadorController.listarClasificadorIncidencias
);

app.post(
  '/api/incidencias',
  apiKeyMiddleware,
  attachActorContext,
  requireAuthenticatedActor,
  panicRateLimit,
  incidenciasController.crearIncidencia
);

app.put(
  '/api/incidencias/cerrar',
  apiKeyMiddleware,
  attachActorContext,
  requireInstitutionalActor,
  incidenciasController.cerrarIncidencia
);

app.post(
  '/api/incidencias/by-alerta/:alertaId/asignar-unidad',
  apiKeyMiddleware,
  attachActorContext,
  requireCentralActor,
  incidenciaOperacionController.asignarUnidad
);

app.post(
  '/api/incidencias/by-alerta/:alertaId/aceptar',
  apiKeyMiddleware,
  attachActorContext,
  requireOperativoActor,
  incidenciaOperacionController.aceptar
);

app.post(
  '/api/incidencias/by-alerta/:alertaId/solicitar-apoyo',
  apiKeyMiddleware,
  attachActorContext,
  requireOperativoActor,
  incidenciaOperacionController.solicitarApoyo
);

// Archivos de incidencia (disco local + metadata PostgreSQL)
app.get(
  '/api/incidencias/by-ticket/:ticket',
  apiKeyMiddleware,
  attachActorContext,
  requireInstitutionalActor,
  requireIncidenciaAccess,
  incidenciaArchivosController.lookupByTicket
);
app.get(
  '/api/incidencias/by-alerta/:alertaId',
  apiKeyMiddleware,
  attachActorContext,
  requireInstitutionalActor,
  requireIncidenciaAccess,
  incidenciaArchivosController.lookupByAlertaId
);
app.get(
  '/api/incidencias/:id/archivos',
  apiKeyMiddleware,
  attachActorContext,
  requireInstitutionalActor,
  requireIncidenciaAccess,
  incidenciaArchivosController.listar
);
app.post(
  '/api/incidencias/:id/archivos',
  apiKeyMiddleware,
  attachActorContext,
  requireInstitutionalActor,
  requireIncidenciaAccess,
  uploadMemory.array('archivos', 10),
  incidenciaArchivosController.subir
);
app.delete(
  '/api/incidencias/:id/archivos/:archivoId',
  apiKeyMiddleware,
  attachActorContext,
  requireInstitutionalActor,
  requireIncidenciaAccess,
  incidenciaArchivosController.eliminar
);
app.get(
  '/api/incidencias/:id/archivos/:archivoId/download',
  apiKeyMiddleware,
  attachActorContext,
  requireInstitutionalActor,
  requireIncidenciaAccess,
  incidenciaArchivosController.descargar
);

// Reportes gerenciales (dashboard integrado, sin Looker/Metabase)
app.get(
  '/api/reportes/gerenciales',
  apiKeyMiddleware,
  attachActorContext,
  requireCentralActor,
  reportesController.gerenciales
);

// GPS
app.post(
  '/api/gps/importar',
  apiKeyMiddleware,
  attachActorContext,
  requireCentralActor,
  gpsController.importarGPS
);

// Códigos de verificación configurables (email / sms)
app.post(
  '/api/verification-codes/send',
  apiKeyMiddleware,
  attachActorContext,
  verificationCodeController.enviarCodigo
);

app.post(
  '/api/verification-codes/verify',
  apiKeyMiddleware,
  attachActorContext,
  verificationCodeController.verificarCodigo
);

app.post(
  '/api/profile/confidentiality-notice/accept',
  apiKeyMiddleware,
  attachActorContext,
  requireInstitutionalActor,
  profileAcceptanceController.aceptarAvisoConfidencialidad
);

app.post(
  '/api/auditoria/eventos',
  apiKeyMiddleware,
  attachActorContext,
  auditoriaController.registrarEvento
);

// ── Zonas (geoespacial PostGIS) ──────────────────────────────────────────────
app.get(
  '/api/zonas',
  apiKeyMiddleware,
  attachActorContext,
  requireAuthenticatedActor,
  zonasController.listarZonas
);

app.post(
  '/api/zonas/importar-geojson',
  apiKeyMiddleware,
  attachActorContext,
  requireCentralActor,
  zonasController.importarDesdeGeoJSON
);

// ── Tipificación jerárquica ───────────────────────────────────────────────────
app.get(
  '/api/tipificacion',
  apiKeyMiddleware,
  attachActorContext,
  requireAuthenticatedActor,
  tipificacionController.listar
);

app.get(
  '/api/tipificacion/buscar',
  apiKeyMiddleware,
  attachActorContext,
  requireAuthenticatedActor,
  tipificacionController.buscar
);

app.get(
  '/api/tipificacion/nivel1',
  apiKeyMiddleware,
  attachActorContext,
  requireAuthenticatedActor,
  tipificacionController.listarNivel1
);

app.get(
  '/api/tipificacion/nivel2',
  apiKeyMiddleware,
  attachActorContext,
  requireAuthenticatedActor,
  tipificacionController.listarNivel2
);

app.get(
  '/api/tipificacion/nivel3',
  apiKeyMiddleware,
  attachActorContext,
  requireAuthenticatedActor,
  tipificacionController.listarNivel3
);

// ── Datos PNP (fuente externa) ────────────────────────────────────────────────
app.post(
  '/api/pnp/importar',
  apiKeyMiddleware,
  attachActorContext,
  requireCentralActor,
  pnpController.importarDesdeExcel
);

app.get(
  '/api/pnp/lotes',
  apiKeyMiddleware,
  attachActorContext,
  requireCentralActor,
  pnpController.listarLotes
);

// ── Mapa del Delito ───────────────────────────────────────────────────────────
app.get(
  '/api/mapa-delito/cemvi',
  apiKeyMiddleware,
  attachActorContext,
  requireCentralActor,
  mapaDelitoController.estadisticasCemvi
);

app.get(
  '/api/mapa-delito/pnp',
  apiKeyMiddleware,
  attachActorContext,
  requireCentralActor,
  mapaDelitoController.estadisticasPnp
);

// Administracion de usuarios institucionales
app.get(
  '/api/admin/usuarios',
  apiKeyMiddleware,
  attachActorContext,
  requireUserAdminActor,
  adminUsuariosController.listarUsuarios
);

app.post(
  '/api/admin/usuarios',
  apiKeyMiddleware,
  attachActorContext,
  requireUserAdminActor,
  adminUsuariosController.crearUsuario
);

app.put(
  '/api/admin/usuarios/:correo',
  apiKeyMiddleware,
  attachActorContext,
  requireUserAdminActor,
  adminUsuariosController.actualizarUsuario
);

app.delete(
  '/api/admin/usuarios/:correo',
  apiKeyMiddleware,
  attachActorContext,
  requireUserAdminActor,
  adminUsuariosController.revocarUsuario
);

app.patch(
  '/api/admin/usuarios/:correo/reactivar',
  apiKeyMiddleware,
  attachActorContext,
  requireUserAdminActor,
  adminUsuariosController.reactivarUsuario
);

app.use((err, req, res, next) => {
  console.error('[express-error]', err);

  if (res.headersSent) {
    return next(err);
  }

  if (err?.type === 'entity.parse.failed') {
    return sendError(res, {
      status: 400,
      code: 'invalid_json_body',
      message: 'El cuerpo JSON de la solicitud es invalido.'
    });
  }

  if (err?.type === 'entity.too.large' || err?.status === 413) {
    return sendError(res, {
      status: 413,
      code: 'request_entity_too_large',
      message: 'La solicitud excede el tamano permitido.'
    });
  }

  if (err?.name === 'MulterError') {
    return sendError(res, {
      status: 400,
      code: 'upload_validation_failed',
      message: 'La carga de archivos no cumple los limites permitidos.'
    });
  }

  return sendError(res, {
    status: Number(err?.status) || 500,
    code: String(err?.code || '').trim() || 'request_failed',
    message:
      Number(err?.status) >= 400 && Number(err?.status) < 500 && err?.expose
        ? String(err.message || 'Solicitud invalida')
        : 'Error interno del servidor'
  });
});

const PORT = process.env.PORT || 3000;
let shuttingDown = false;
let httpServer = null;

function salirPorFallaIrrecuperable(origen, error) {
  console.error(`[process] ${origen}:`, error);

  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  const forceExitTimer = setTimeout(() => {
    console.error(`[process] Cierre forzado tras ${origen}.`);
    process.exit(1);
  }, 5000);
  forceExitTimer.unref();

  if (!httpServer || typeof httpServer.close !== 'function') {
    process.exit(1);
    return;
  }

  httpServer.close(() => {
    console.error(`[process] Servidor detenido tras ${origen}.`);
    process.exit(1);
  });
}

process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandledRejection:', reason);
});

process.on('uncaughtException', (error) => {
  salirPorFallaIrrecuperable('uncaughtException', error);
});

httpServer = app.listen(PORT, () => {
  console.log(`Servidor institucional corriendo en puerto ${PORT}`);
});

httpServer.requestTimeout = parsePositiveInt(
  process.env.HTTP_REQUEST_TIMEOUT_MS,
  30000
);
httpServer.headersTimeout = parsePositiveInt(
  process.env.HTTP_HEADERS_TIMEOUT_MS,
  35000
);
httpServer.keepAliveTimeout = parsePositiveInt(
  process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS,
  5000
);

# CLAUDE.md — SOS Santa Anita

## ¿Qué es este proyecto?

Sistema integral de seguridad ciudadana para la **Municipalidad de Santa Anita (MDSA)**. Permite registrar, gestionar y visualizar incidencias de seguridad en tiempo real, alimentado por múltiples fuentes: operadores humanos, cámaras de videovigilancia y ciudadanos vía app móvil.

---

## Arquitectura general

```
sos_santa_anita/        → App móvil Flutter (ciudadanos)
sos-backend/            → API REST Node.js (servidor principal)
  ├── controllers/      → Lógica de endpoints
  ├── services/         → Lógica de negocio
  ├── middlewares/      → Auth, validación
  ├── migrations/       → Scripts de BD (PostgreSQL)
  ├── scripts/          → Utilidades: clasificador, sync Firestore, backup, rutas
  └── validators/       → Validación de inputs
BD principal: PostgreSQL
BD nube/tiempo real: Firebase Firestore (espejo sincronizado)
```

---

## Módulos del sistema

### 1. Registro de Incidencias
- Registro manual por operadores (basado en llamadas, cámaras, partes de trabajadores)
- Preregistro automático desde el botón de pánico de la app móvil
- Tipificación en **3 niveles jerárquicos** + descripción (ver sección Clasificador)

### 2. Mapa Táctico (Google Maps)
- Visualización de cámaras de videovigilancia instaladas en el distrito
- Mapa de calor de incidencias por zona
- Mapa del delito: puntos georreferenciados por tipo de incidencia, generados al momento del registro

### 3. App Móvil (Flutter)
- Botón de pánico: genera preregistro automático de incidencia con ubicación GPS
- Los ciudadanos pueden reportar incidencias directamente

### 4. Gestión de Cámaras de Videovigilancia
- Registro individual de cada cámara con ubicación georreferenciada (lat/lng)
- Las cámaras registradas se muestran en el Mapa Táctico
- Estado de cámara: `operativa` | `inoperativa` | `mantenimiento`
- Flujo nocturno (~11pm): operador registra estado de todas las cámaras del día
- Se genera automáticamente un **reporte PDF diario** con el estado de la red de cámaras

### 5. Módulo de Rutas / Recorridos de Camionetas
- Carga de archivo Excel externo con los recorridos diarios de las unidades vehiculares
- El Excel proviene de un servicio externo de la municipalidad (no se genera aquí)
- Se importa y almacena para tener trazabilidad del patrullaje diario
- Solo lectura/importación — no se edita el contenido del Excel

### 6. Estadísticas
- Dashboard de indicadores operativos:
  - Incidencias más frecuentes por tipo y zona
  - Personal con mayor número de atenciones
  - Tendencias temporales (diarias, semanales, mensuales)
  - Métricas de respuesta y cobertura

### 7. Gestión de Usuarios (dos tipos diferenciados)
- **Usuarios Serenazgo:** personal de campo que patrulla. Acceden principalmente a la app móvil y al registro de partes.
- **Usuarios Administrativos:** operadores del sistema web de registro de incidencias, supervisores y administradores municipales.
- Ambos tipos tienen roles y permisos diferenciados.

### 8. Módulos de soporte
- `auditoriaController.js` — registro de acciones del sistema (requerido por normativa estatal)
- `reportesController.js` — generación de reportes y PDFs
- `pnpController.js` — integración con PNP (Policía Nacional del Perú)
- `zonificacionService.js` — lógica de zonas del distrito
- `verificacionCodeController.js` — verificación de acceso

---

## Clasificador de Incidencias (CRÍTICO)

La tipificación usa **3 niveles jerárquicos** cargados desde JSON:

```json
{
  "nivel1": "Categoría general (ej: Robo, Factores de riesgo)",
  "nivel2": "Subcategoría (ej: Robo a Comercio)",
  "nivel3": "Incidencia específica (ej: Con captura)",
  "descripcion": "Texto explicativo conceptual"
}
```

- Archivo flat: `scripts/clasificador_ocurrencias_2025_p...`
- Script de importación: `scripts/importar_clasificador.js`
- Sync con Firestore: `scripts/sync_clasificador_firestore.js`
- Controller: `controllers/tipificacionController.js`
- El clasificador tiene **238 registros** distribuidos en **24 categorías nivel1**

**Regla importante:** nunca modificar el contenido semántico del clasificador. Solo se puede agregar nuevas entradas o corregir formato.

---

## Stack tecnológico

| Capa | Tecnología |
|------|-----------|
| App móvil | Flutter (Dart) |
| Backend | Node.js (Express) |
| BD principal | **PostgreSQL** (fuente de verdad, auditoría estatal) |
| BD nube | **Firebase Firestore** (espejo sincronizado, tiempo real) |
| Autenticación | Firebase Auth |
| Mapas | Google Maps API |
| Almacenamiento | Firebase Storage (`uploads/`) |
| Reglas BD | `storage.rules` |

### Estrategia de doble base de datos (IMPORTANTE)
- **PostgreSQL es la fuente de verdad.** Toda operación crítica se persiste aquí primero.
- **Firestore es el espejo en nube.** Se sincroniza desde PostgreSQL para disponibilidad y tiempo real en la app móvil.
- Esta arquitectura responde a requisitos de **auditoría de entidad estatal peruana**: trazabilidad completa, integridad de datos y control interno.
- Nunca asumir sincronización inmediata entre ambas BDs — pueden existir desfases temporales.
- Migraciones de PostgreSQL en `migrations/`
- Sincronización hacia Firestore vía scripts en `scripts/`

---

## Convenciones del proyecto

- Los controllers siguen el patrón `[módulo]Controller.js`
- Los services siguen el patrón `[módulo]Service.js`
- Variables de entorno en `.env` (ver `.env.example` para referencia)
- No exponer `firebase-key.json` ni `.env` en ningún output
- Los scripts de `scripts/database/` y `scripts/backup/` son de mantenimiento — ejecutar con precaución

---

## Contexto municipal

- **Cliente:** Municipalidad Distrital de Santa Anita (MDSA), Lima, Perú
- **Usuarios del sistema web:** Operadores de serenazgo, supervisores, administradores municipales
- **Usuarios de la app móvil:** Ciudadanos del distrito de Santa Anita + personal serenazgo campo
- **Integración externa:** PNP (Policía Nacional del Perú), CEMVI
- **Requisito legal:** Sistema sujeto a normativa de entidades estatales peruanas (auditoría, trazabilidad)

---

## Qué NO hacer

- No refactorizar estructura de carpetas sin indicación explícita
- No cambiar nombres de campos en Firestore sin considerar la migración en PostgreSQL también
- No modificar `storage.rules` sin revisión de seguridad
- No tocar el clasificador de incidencias sin instrucción expresa
- No asumir que una operación en PostgreSQL ya está reflejada en Firestore automáticamente
- No eliminar registros — este sistema requiere soft delete o registros de auditoría

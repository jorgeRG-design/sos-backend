# Installation

Esta guia deja `sos-backend` listo para una instalacion limpia sobre PostgreSQL + Firestore.

## 1. Que vive en PostgreSQL y que vive en Firestore

### PostgreSQL

PostgreSQL es el almacenamiento principal para:

- `incidencias`
- `incidencia_archivos`
- `incidencia_personas`
- `incidencia_apoyo_pnp`
- `incidencia_efectivos`
- `incidencia_vehiculos_asignados`
- `incidencia_unidades_operacion`
- `recorridos_gps`
- `ticket_contadores`
- `clasificador_incidencias`
- `auditoria_eventos`
- `auditoria_eventos_archive`

En este proyecto, la tabla `incidencias` si pertenece a PostgreSQL y es la fuente canonica del flujo de incidencias.

### Firestore

Firestore se usa como soporte operativo para:

- `usuarios_central`
- `ciudadanos`
- `alertas`
- `unidades`
- `vehiculos`
- `recorridos_gps`
- `bitacora_camaras`
- `reportes_diarios_camaras`

En incidencias, Firestore funciona como espejo operativo / integracion en tiempo real, pero no reemplaza a PostgreSQL.

## 2. Requisitos previos

- Node.js LTS
- PostgreSQL
- herramientas cliente de PostgreSQL (`psql`)
- proyecto Firebase con Firestore y Firebase Auth
- credencial de servicio Firebase accesible para el backend

## 3. Variables de entorno minimas

Copiar `.env.example` a `.env` y completar:

- `API_KEY`
- `PG_HOST`, `PG_PORT`, `PG_DATABASE`, `PG_USER`, `PG_PASSWORD`
- `GOOGLE_APPLICATION_CREDENTIALS` o `FIREBASE_CREDENTIALS_PATH`
- `UPLOAD_DIR` si no se usara la ruta por defecto

Si `psql` no esta en `PATH`, configurar:

- `DB_PSQL_PATH`

o reutilizar:

- `BACKUP_PSQL_PATH`

## 4. Crear la base de datos vacia

Crear primero la base:

```sql
CREATE DATABASE sos_santa_anita;
```

O usando `createdb` / pgAdmin segun el entorno.

## 5. Inicializacion limpia desde cero

Desde `E:\Proyecto_Santa_Anita\sos-backend`:

```powershell
npm install
cmd /c npm run db:init
```

`db:init` hace:

1. aplica [database/000_base_schema.sql](E:/Proyecto_Santa_Anita/sos-backend/database/000_base_schema.sql)
2. ejecuta todas las migraciones de [migrations](E:/Proyecto_Santa_Anita/sos-backend/migrations) en orden alfabetico
3. deja la estructura lista para importar el clasificador oficial

Orden practico:

1. `database/000_base_schema.sql`
2. `migrations/001_incidencia_archivos.sql`
3. `migrations/001_ticket_contadores.sql`
4. `migrations/002_auditoria_incidencias_postgresql.sql`
5. `migrations/003_campos_faltantes_incidencias.sql`
6. `migrations/004_expandir_tipo_incidencias.sql`
7. `migrations/005_agregar_campos_comunicante_incidencias.sql`
8. `migrations/006_mininter_apertura_multirecurso.sql`
9. `migrations/007_sector_campos_incidencias.sql`
10. `migrations/008_indices_consistencia_incidencias.sql`
11. `migrations/009_operacion_estado_incidencias.sql`
12. `migrations/010_incidencia_unidades_operacion.sql`
13. `migrations/011_indices_y_constraints_operacion.sql`
14. `migrations/012_auditoria_eventos.sql`
15. `migrations/013_auditoria_eventos_archive.sql`
16. `migrations/014_auditoria_eventos_audit_source_indexes.sql`

## 6. Ejecutar solo migraciones

Si la base ya tiene el schema base y solo quieres reaplicar migraciones idempotentes:

```powershell
cmd /c npm run db:migrate
```

## 7. Importar clasificador oficial

El backend expone `/api/clasificador-incidencias`, por lo que para una demo o despliegue funcional conviene cargar el catalogo oficial:

```powershell
cmd /c npm run clasificador:import
```

## 8. Inicializar Firestore para demo

Para que el sistema tenga perfiles minimos de demo, puedes usar:

```powershell
cmd /c npm run firestore:seed
```

El script usa variables opcionales `DEMO_*`. Las mas utiles son:

- `DEMO_CENTRAL_EMAIL`
- `DEMO_CENTRAL_PASSWORD`
- `DEMO_CENTRAL_DNI`
- `DEMO_CENTRAL_NOMBRES`
- `DEMO_OPERATIVO_EMAIL`
- `DEMO_OPERATIVO_PASSWORD`
- `DEMO_OPERATIVO_DNI`
- `DEMO_OPERATIVO_NOMBRES`
- `DEMO_CIUDADANO_DNI`
- `DEMO_CIUDADANO_PASSWORD`
- `DEMO_CIUDADANO_NOMBRE`

Que hace el seed:

- crea o actualiza perfiles en `usuarios_central`
- opcionalmente crea usuarios en Firebase Auth si hay password
- crea unidad demo en `unidades` para el operativo sembrado
- opcionalmente crea ciudadano demo en `ciudadanos`

## 9. Levantar el backend

```powershell
npm start
```

Salud basica:

```text
GET /api/health
```

## 10. Demo rapida

Flujo recomendado para una demo funcional inmediata:

1. configurar `.env`
2. crear base vacia
3. `npm install`
4. `cmd /c npm run db:init`
5. `cmd /c npm run clasificador:import`
6. configurar variables `DEMO_*`
7. `cmd /c npm run firestore:seed`
8. `npm start`

Con esto se obtiene:

- backend levantable desde cero
- schema PostgreSQL consistente
- clasificador cargado
- perfiles demo minimos en Firestore/Auth para pruebas

## 11. Produccion

En produccion:

- usar `db:init` solo la primera vez
- importar el clasificador oficial despues de la instalacion base
- no depender de usuarios demo
- crear perfiles institucionales reales en Firebase/Auth siguiendo el flujo administrativo
- proteger `.env` y la credencial Firebase fuera del repositorio
- usar HTTPS y el resto del endurecimiento ya implementado

## 12. Diferencia entre demo y produccion

### Demo

- puede usar `firestore:seed`
- puede usar credenciales demo
- orientada a validacion funcional rapida

### Produccion

- no debe depender de cuentas demo
- debe usar credenciales reales y controladas por la entidad
- debe aplicar backup, scheduler y procedimientos operativos documentados

## 13. Scripts disponibles

- `npm start`
- `npm run db:init`
- `npm run db:migrate`
- `npm run clasificador:import`
- `npm run firestore:seed`

## 14. Limitaciones conocidas

- El repo no traia un schema base reproducible; por eso se agrego `database/000_base_schema.sql`.
- La migracion `002_auditoria_incidencias_postgresql.sql` es diagnostica, no estructural, pero ahora ya puede ejecutarse sin fallar porque el schema base incluye las columnas y tablas que consulta.
- Firestore requiere credencial valida y, para login demo real, los usuarios de Auth deben existir o ser creados por el seed con password.

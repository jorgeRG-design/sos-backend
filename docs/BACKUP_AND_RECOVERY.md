# Backup And Recovery

Este documento describe el mecanismo minimo de respaldo y recuperacion ante desastres implementado para `sos-backend`.

## 1. Objetivo

El sistema de backup cubre tres superficies operativas:

- PostgreSQL
- adjuntos fisicos locales (`UPLOAD_DIR` / `uploads`)
- Firestore (colecciones configuradas)

Este mecanismo **no reemplaza** los jobs de retencion, cuarentena ni purge. Su objetivo es recuperar informacion ante perdida, falla o evento critico.

## 2. Que se respalda

### PostgreSQL

- tablas operativas del backend
- metadata de adjuntos
- auditoria
- datos relacionales del sistema

### Uploads locales

- archivos fisicos almacenados en `UPLOAD_DIR`
- subdirectorios de uploads, incluidos los creados por la propia operacion del sistema

### Firestore

- colecciones listadas en `FIRESTORE_COLLECTIONS`
- tambien puede exportarse una lista explicita usando `--collections`

Formato:

- PostgreSQL: `pg_dump` formato custom (`.dump`)
- uploads: copia versionada por fecha con `robocopy`
- Firestore: archivos `NDJSON` por coleccion + `manifest.json`

## 3. Que NO se respalda automaticamente

Por seguridad y simplicidad, esta primera version **no copia automaticamente**:

- `.env` con secretos productivos
- credencial privada de Firebase
- sistema operativo, instaladores o binarios de PostgreSQL
- `node_modules`
- tareas programadas de Windows exportadas a XML

Estas piezas deben resguardarse por la entidad a traves de custodia segura o procedimiento manual controlado.

## 4. Frecuencia recomendada

Recomendacion minima:

- PostgreSQL: diario
- uploads: diario
- Firestore: diario
- configuracion critica y secretos: al cambio

En produccion se recomienda que `BACKUP_ROOT_DIR` apunte a una ruta externa o separada del disco operativo principal.

## 5. Estructura de almacenamiento

Si `BACKUP_ROOT_DIR` no se configura, el sistema usa por defecto:

- `<sos-backend>/runtime_backups`

Estructura esperada:

```text
BACKUP_ROOT_DIR/
  logs/
  postgres/YYYYMMDD/
  uploads/YYYYMMDD/uploads_YYYYMMDD_HHMMSS/
  firestore/YYYYMMDD/firestore_YYYYMMDD_HHMMSS/
```

## 6. Variables de entorno relevantes

El sistema acepta tanto los nombres ya usados por la app (`PG_*`) como aliases `POSTGRES_*` para los scripts de backup.

Variables principales:

- `PG_HOST` / `POSTGRES_HOST`
- `PG_PORT` / `POSTGRES_PORT`
- `PG_DATABASE` / `POSTGRES_DB`
- `PG_USER` / `POSTGRES_USER`
- `PG_PASSWORD` / `POSTGRES_PASSWORD`
- `UPLOAD_DIR`
- `BACKUP_ROOT_DIR`
- `LOG_DIR`
- `FIREBASE_CREDENTIALS_PATH`
- `FIRESTORE_COLLECTIONS`

Opcionales para Windows si PostgreSQL no esta en `PATH`:

- `BACKUP_PG_DUMP_PATH`
- `BACKUP_PG_RESTORE_PATH`
- `BACKUP_PSQL_PATH`

## 7. Comandos manuales de backup

### Ejecutar todo

```powershell
cmd /c npm run backup:all
```

### Solo PostgreSQL

```powershell
cmd /c npm run backup:postgres
```

### Solo uploads

```powershell
cmd /c npm run backup:uploads
```

### Solo Firestore

```powershell
cmd /c npm run backup:firestore
```

Exportar colecciones especificas:

```powershell
node scripts/backup/backup-firestore.js --collections=ciudadanos,usuarios_central,alertas
```

## 8. Comandos manuales de restore

### Restaurar PostgreSQL

```powershell
cmd /c npm run restore:postgres -- -DumpFile="D:\SOSBackups\postgres\20260404\postgres_sos_santa_anita_20260404_010000.dump"
```

### Restaurar uploads

Sin sobrescribir archivos existentes:

```powershell
cmd /c npm run restore:uploads -- -BackupPath="D:\SOSBackups\uploads\20260404\uploads_20260404_010500"
```

Permitiendo sobrescritura:

```powershell
cmd /c npm run restore:uploads -- -BackupPath="D:\SOSBackups\uploads\20260404\uploads_20260404_010500" -OverwriteExisting
```

### Restaurar Firestore

Dry-run:

```powershell
cmd /c npm run restore:firestore -- --input-dir="D:\SOSBackups\firestore\20260404\firestore_20260404_011000" --mode=dry-run
```

Execute:

```powershell
cmd /c npm run restore:firestore -- --input-dir="D:\SOSBackups\firestore\20260404\firestore_20260404_011000" --mode=execute
```

Restaurar solo algunas colecciones:

```powershell
cmd /c npm run restore:firestore -- --input-dir="D:\SOSBackups\firestore\20260404\firestore_20260404_011000" --mode=execute --collections=ciudadanos,usuarios_central
```

## 9. Validacion posterior a la recuperacion

Validaciones minimas recomendadas despues de un restore:

1. Levantar el backend.
2. Confirmar `GET /api/health`.
3. Confirmar acceso a PostgreSQL sin error.
4. Verificar una incidencia conocida o una tabla clave en PostgreSQL.
5. Verificar que un adjunto conocido exista en `UPLOAD_DIR`.
6. Verificar una o dos colecciones clave de Firestore.
7. Confirmar login y operacion basica de la app en entorno controlado.

## 10. Diferencia entre backup, retencion y cuarentena

### Backup

- se usa para recuperacion ante perdida o desastre
- genera una copia separada del dato

### Retencion

- elimina o archiva datos antiguos por politica operativa
- ya existe en `scripts/retention`

### Cuarentena

- mueve adjuntos huerfanos a una zona segura y reversible
- no reemplaza el backup

## 11. Limitaciones conocidas

- Firestore exporta solo las colecciones configuradas explicitamente; no descubre subcolecciones de forma automatica.
- El restore de Firestore reescribe documentos presentes en el backup seleccionado, pero no elimina documentos ausentes.
- El restore de uploads no borra destinos; por defecto evita sobrescribir archivos existentes.
- Esta version no purga backups antiguos automaticamente.
- Los secretos operativos deben custodiarse aparte.

## 12. Responsabilidad operativa

- El contratista implementa, configura y documenta el mecanismo de respaldo y recuperacion.
- La entidad administra la ejecucion continua, el monitoreo, la custodia del almacenamiento y la verificacion periodica de que las copias sigan siendo recuperables.

## 13. Configuracion critica y custodia manual

La entidad debe mantener respaldo seguro, fuera del repositorio, de:

- `.env`
- credencial de Firebase usada en produccion
- acceso al servidor Windows
- acceso a PostgreSQL

Adicionalmente, si desea resguardar la definicion de la tarea programada, puede exportarla manualmente:

```powershell
schtasks /Query /TN "SOS Backend Backup - Daily" /XML > D:\SOSBackups\task_scheduler\SOS_Backup_Daily.xml
```

## 14. Archivos principales del sistema de backup

- `scripts/backup/backup-postgres.ps1`
- `scripts/backup/backup-uploads.ps1`
- `scripts/backup/backup-firestore.js`
- `scripts/backup/run-backup-all.ps1`
- `scripts/backup/restore-postgres.ps1`
- `scripts/backup/restore-uploads.ps1`
- `scripts/backup/restore-firestore.js`
- `scripts/backup/register_backup_tasks.ps1`


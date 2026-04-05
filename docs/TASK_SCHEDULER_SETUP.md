# Task Scheduler Setup

Esta guia explica como registrar el backup diario en Windows Task Scheduler usando los scripts del repositorio.

## 1. Requisitos previos

- PowerShell con permisos para registrar tareas
- Node.js instalado
- PostgreSQL client tools (`pg_dump`, `pg_restore`, `psql`) instalados o configurados por ruta
- `.env` configurado
- `BACKUP_ROOT_DIR` apuntando idealmente a una ruta externa al servidor operativo

## 2. Preview de la tarea

Desde `E:\Proyecto_Santa_Anita\sos-backend`:

```powershell
cmd /c npm run backup:schedule:preview
```

O directamente:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/backup/register_backup_tasks.ps1
```

## 3. Registrar la tarea

Abrir PowerShell como administrador y ejecutar:

```powershell
cd E:\Proyecto_Santa_Anita\sos-backend
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/backup/register_backup_tasks.ps1 -Apply
```

La configuracion sugerida registra una tarea diaria:

- nombre: `SOS Backend Backup - Daily`
- horario recomendado: `01:00`
- mecanismo: `scripts/backup/run-backup-all.ps1`
- `LogonType`: `Interactive`

## 4. Cambiar el horario

Ejemplo para dejarla a las `23:30`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/backup/register_backup_tasks.ps1 -Apply -TriggerTime 23:30
```

## 5. Verificacion inicial

Despues de registrar la tarea:

1. abrir Windows Task Scheduler
2. localizar `SOS Backend Backup - Daily`
3. revisar la accion configurada
4. ejecutar la tarea manualmente una vez
5. revisar logs en `BACKUP_ROOT_DIR\logs`

## 6. Si PostgreSQL no esta en PATH

Configurar en `.env` una o mas de estas variables:

- `BACKUP_PG_DUMP_PATH`
- `BACKUP_PG_RESTORE_PATH`
- `BACKUP_PSQL_PATH`

Ejemplo:

```env
BACKUP_PG_DUMP_PATH=C:\Program Files\PostgreSQL\17\bin\pg_dump.exe
BACKUP_PG_RESTORE_PATH=C:\Program Files\PostgreSQL\17\bin\pg_restore.exe
BACKUP_PSQL_PATH=C:\Program Files\PostgreSQL\17\bin\psql.exe
```

## 7. Logs esperados

Cada corrida deja:

- log consolidado de `run-backup-all.ps1`
- log de PostgreSQL
- log de uploads
- log de Firestore

Ubicacion:

- `BACKUP_ROOT_DIR\logs`
- o `LOG_DIR` si se configura de forma explicita

## 8. Recomendacion operativa

- dejar la tarea diaria activa
- revisar logs periodicamente
- validar restauracion en entorno controlado al menos una vez despues de la implementacion inicial
- no almacenar los backups unicamente en el mismo disco del backend productivo


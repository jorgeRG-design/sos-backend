# Audit Server-Driven Plan (9B)

Este documento define la transicion de una auditoria parcialmente client-driven a una auditoria canonicamente server-driven.

Estado:

- diagnostico y plan tecnico
- implementacion inicial del marcado `metadata.audit_source`
- catalogo de acciones de auditoria centralizado en backend
- soporte base para consultas canonicas por `audit_source`
- transicion completa todavia no implementada

## Objetivo

Reducir el peso del endpoint client-driven de auditoria y dejar como fuente canonica de eventos a las operaciones reales del backend.

Principio rector:

- la auditoria valida debe nacer donde la accion ocurre realmente
- el cliente no debe poder declarar por si mismo acciones sensibles como fuente principal de verdad

## Estado actual

### Ruta client-driven existente

Endpoint:

- `POST /api/auditoria/eventos`

Estado actual del endurecimiento:

- `x-api-key` + `attachActorContext`
- allowlist publica reducida a:
  - `login_success`
  - `login_failure`
  - `logout`
  - `password_change`
- `login_failure` es la unica excepcion pre-auth
- `login_failure` ya tiene rate limit best effort por IP e identificador
- `actorFallback` ya esta acotado

### Eventos ya generados desde backend

El backend ya registra eventos server-side en controladores sensibles, por ejemplo:

- administracion de usuarios:
  - `admin_user_create`
  - `admin_user_update`
  - `admin_user_revoke`
  - `admin_user_reactivate`
- incidencias:
  - `incidencia_create`
  - `incidencia_close`
- operaciones de incidencia:
  - `unidad_assign`
  - `incidencia_accept`
  - `incidencia_support_request`
- archivos:
  - `archivo_upload`
  - `archivo_download`
  - `archivo_delete`

Esto ya muestra el camino correcto: las acciones con impacto operativo real se auditan donde ocurren.

## Problema restante

La ruta `POST /api/auditoria/eventos` sigue siendo client-driven para eventos que el cliente declara:

- `login_success`
- `login_failure`
- `logout`
- `password_change`

Riesgo residual:

- `login_failure` no otorga acceso, pero sigue pudiendo inyectar ruido aunque ya este rate-limited
- `login_success`, `logout` y `password_change` siguen dependiendo de que el cliente reporte el evento
- la auditoria client-driven no siempre coincide con la fuente real de la accion

## Target architecture

### Canonico server-driven

Deben ser server-driven como regla:

- acciones administrativas
- aperturas y cierres de incidencia
- asignaciones y aceptaciones operativas
- operaciones sobre adjuntos
- cualquier accion que cambie estado, permisos, acceso o evidencia

### Client-driven solo cuando no exista fuente real en backend

Transicionalmente pueden seguir client-driven:

- `login_failure` pre-auth
- `login_success` mientras el login siga ocurriendo contra Firebase desde Flutter
- `logout` mientras no exista endpoint backend de logout/revocacion
- `password_change` solo mientras no exista una operacion backend canonica de cambio de credenciales

## Estrategia minima por fases

### Fase 9B-1: consolidar canon server-driven

Objetivo:

- estandarizar lo que el backend ya esta registrando

Acciones propuestas:

- mantener `registrarEventoSeguro(...)` como helper canonico de backend
- definir un catalogo estable de acciones server-driven
- revisar nombres de `accion` para evitar variantes innecesarias
- priorizar que toda accion sensible nueva nazca server-side

No requiere cambiar Flutter.

Estado actual:

- ya existe un catalogo central en `utils/auditCatalog.js`

### Fase 9B-2: devaluar la ruta client-driven

Objetivo:

- convertir `/api/auditoria/eventos` en un endpoint residual y no principal

Acciones propuestas:

- documentar que sus eventos no son la fuente primaria de verdad
- mantener `login_failure` como caso especial pre-auth
- conservar `login_success`, `logout` y `password_change` solo como telemetria transicional
- agregar marca de origen en la fila:
  - `metadata.audit_source = 'client' | 'server'`
  o un campo dedicado cuando se haga una migracion futura

Estado actual:

- esta primera marca `metadata.audit_source` ya puede activarse sin migracion porque `metadata` ya es `JSONB`
- existe un archivo de consultas canonicas:
  - `docs/AUDIT_CANONICAL_QUERIES.sql`

### Fase 9B-3: migrar eventos a backend cuando exista fuente real

Objetivo:

- sacar gradualmente eventos de la ruta client-driven

Orden recomendado:

1. `password_change`
   - mover a backend cuando exista una operacion canonica de cambio de password/token
2. `login_success`
   - registrar server-side si en algun momento el login pasa por backend o existe callback canonico
3. `logout`
   - registrar server-side solo si existe logout/revocacion backend

### Fase 9B-4: endpoint publico minimizado

Estado final deseado:

- `/api/auditoria/eventos` queda, como maximo, para:
  - `login_failure`
- o incluso se reemplaza por un canal mas especifico si algun dia cambia la arquitectura de autenticacion

## Propuesta tecnica minima para la siguiente implementacion

Sin tocar Flutter todavia, la siguiente mejora util y segura seria:

1. extender `auditoriaService` para etiquetar el origen del evento
2. usar esa etiqueta desde controladores server-driven
3. diferenciar en consultas/reportes:
   - eventos canonicos `server`
   - telemetria client-driven `client`

Estado actual:

- `auditoriaService` ya expone helpers para orden canonico por `audit_source`
- existe una migracion propuesta de indices:
  - `migrations/014_auditoria_eventos_audit_source_indexes.sql`

Eso permitiria:

- no romper el flujo actual
- mejorar confianza en auditoria
- preparar una reduccion posterior de la ruta client-driven

## Riesgos a evitar

- declarar `logout` como server-driven cuando todavia no existe fuente real backend
- asumir que `login_success` es canonico si la autenticacion aun ocurre solo en cliente
- mezclar en reportes eventos `client` y `server` como si tuvieran el mismo peso probatorio

## Orden seguro de implementacion futura

1. etiquetar origen `client/server`
2. catalogar acciones server-driven existentes
3. adaptar reportes/consultas para priorizar fuente `server`
4. recien despues recortar allowlist client-driven cuando haya fuente real alternativa

## Decision operativa recomendada

Desde ahora, considerar:

- auditoria server-driven = fuente confiable principal
- auditoria client-driven = apoyo transicional, especialmente para pre-auth

Eso es compatible con el backend actual y no rompe Flutter ni autenticacion.

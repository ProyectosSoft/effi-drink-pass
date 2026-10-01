# Base de datos

PostgreSQL de Supabase (15+). El esquema completo se reconstruye con las migraciones de `supabase/migrations/` en orden:

| Migración | Contenido |
|---|---|
| `0001_foundation` | pgcrypto, esquema `private`, reloj del servidor, rate limiting, idempotencia, outbox, enum de estados |
| `0002_core_tables` | Tablas del dominio, índices, normalización, inmutabilidad |
| `0003_rbac_audit` | Permisos/roles sembrados, `has_permission`, actor, auditoría, sesión (`on_login`, `my_access`), gestión de staff y roles |
| `0004_benefits` | Tokens QR, triggers de beneficios, **consumo atómico**, portal del asistente, administración de beneficios |
| `0005_attendees_import` | Alta/edición de asistentes, elegibilidad, días, configuración, importación masiva |
| `0006_integrations_api` | Integraciones, credenciales, autenticación de la API, funciones `api_*` |
| `0007_statistics_reports` | Estadísticas, reportes, vistas `consumption_details` y `benefit_details` |
| `0008_rls_grants` | RLS y privilegios |
| `0009_api_reads` | Lecturas de la API v1 y privilegios de funciones `api_*` |
| `0010_webhooks` | Suscripciones de webhooks, fan-out del outbox, entregas con reintentos, funciones del despachador |

## Esquemas

- **`public`**: expuesto por PostgREST. Tablas con RLS + funciones RPC.
- **`private`**: nunca expuesto; sin `USAGE` para `anon`/`authenticated`. Contiene el secreto HMAC de QR, configuración interna, contadores de rate limit, claves de idempotencia y el outbox de eventos.

## Tablas

| Tabla | Descripción | Notas |
|---|---|---|
| `profiles` | Staff (administradores, operadores…) | `auth_user_id` → `auth.users`; email único (sin mayúsculas) |
| `roles`, `permissions`, `role_permissions`, `user_roles` | RBAC | 5 roles del sistema; permisos = scopes |
| `attendees` | Asistentes | **PK `id` propio (uuid)**. `effi_id`, `effi_username`, `email` únicos si existen, todos opcionales. `is_demo` marca datos de prueba |
| `event_days` | Días del evento | `date` única, horario en hora de Bogotá |
| `attendee_event_days` | Elegibilidad asistente × día | Al quedar `eligible` se genera el beneficio (trigger) |
| `benefits` | Un beneficio por asistente y día | `UNIQUE(attendee_id, event_day_id)`; `token_hash` único; nunca se borran |
| `consumptions` | Historial de consumos | **Inmutable** (sin UPDATE/DELETE/TRUNCATE); `UNIQUE(benefit_id)`; guarda `operator_label` |
| `api_integrations`, `api_credentials` | Consumidores externos | Solo el hash SHA-256 del secreto |
| `audit_logs` | Auditoría | **Inmutable**; sin FKs para sobrevivir a cualquier cambio |
| `app_settings` | Configuración visible | Modo del scanner, nombre del evento… |
| `webhook_subscriptions` | Webhooks de integraciones | Secreto de firma en `private.webhook_secrets`; entregas en `private.webhook_deliveries` |

### Columnas que ningún cliente puede leer

`benefits.token_hash`, `benefits.token_salt`, `api_credentials.credential_hash` (privilegios por columna). Además, el token del QR **no existe** en ninguna tabla.

## Funciones principales (RPC)

| Función | Permiso | Uso |
|---|---|---|
| `on_login()` / `my_access()` | autenticado | Vincular cuenta por email verificado, auditar LOGIN, obtener roles/permisos |
| `get_my_benefits()` / `get_my_benefit_token(id)` | dueño | Portal del asistente |
| `benefit_validate(token, id)` | `benefits:validate` | Validar sin consumir |
| `benefit_redeem(token, id, idempotency_key, metadata)` | `benefits:redeem` | Consumo atómico |
| `benefit_override_redeem(id, reason, key)` | `benefits:override` | Consumo excepcional auditado |
| `cancel_benefit`, `restore_benefit`, `regenerate_benefit_token`, `generate_benefits`, `expire_benefits` | `benefits:write` | Administración |
| `upsert_attendee`, `set_attendee_days`, `assign_day_to_attendees` | `attendees:write` | Asistentes |
| `import_attendees(rows, mode, dry_run, day_ids, file)` | `attendees:import` | Carga masiva |
| `upsert_event_day` | `event-days:write` | Días |
| `update_setting` | `settings:manage` | Configuración |
| `upsert_staff_profile`, `set_user_roles` | `users:manage` | Staff |
| `upsert_role`, `set_role_permissions` | `roles:manage` | Roles |
| `create_integration`, `update_integration`, `create_api_credential`, `revoke_api_credential`, `rotate_api_credential` | `integrations:manage` | Integraciones |
| `get_statistics(filters)` | `statistics:read` | Dashboard |
| `get_report(kind, filters)` | `reports:read` | Reportes CSV |
| `create_webhook_subscription`, `update_webhook_subscription`, `rotate_webhook_secret`, `list_webhook_deliveries`, `retry_webhook_delivery` | `integrations:manage` | Webhooks |
| `api_*`, `webhooks_claim`, `webhooks_report` | solo `service_role` | Edge Functions |

## Reloj

`private.app_now()` devuelve `now()`. Solo si `private.config.allow_clock_override = 'true'` (únicamente en pruebas) acepta simular la hora con `app.now_override`. **En producción debe estar en `false`** (valor por defecto de la migración).

## Mantenimiento

- `private.rate_limits` se limpia sola (ventanas > 2 h).
- `private.idempotency_keys` expira a las 48 h (se purga al reutilizar la clave). Limpieza opcional:
  `delete from private.idempotency_keys where expires_at < now();`
- `supabase/scripts/schedule_webhooks.sql` programa con `pg_cron` el despachador de webhooks (cada minuto) y `expire_benefits()` (cada hora).

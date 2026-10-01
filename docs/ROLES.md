# Roles y permisos

RBAC propio: `roles` ↔ `permissions` (N:M) y `user_roles` (perfil ↔ rol). **Los nombres de permiso son también los scopes de la API.**

## Permisos

| Permiso | Descripción | ¿Asignable a integraciones? |
|---|---|---|
| `attendees:read` | Consultar asistentes | Sí |
| `attendees:write` | Crear/actualizar asistentes y elegibilidad | Sí |
| `attendees:import` | Carga masiva | No |
| `event-days:read` | Consultar días | Sí |
| `event-days:write` | Crear/editar días | No |
| `benefits:read` | Consultar beneficios | Sí |
| `benefits:write` | Generar, cancelar, restaurar, rotar QR | Sí |
| `benefits:validate` | Validar sin consumir | Sí |
| `benefits:redeem` | Consumir | Sí |
| `benefits:override` | Consumo excepcional fuera de día/horario | No |
| `consumptions:read` | Consultar consumos | Sí |
| `statistics:read` | Estadísticas | Sí |
| `reports:read` | Reportes y CSV | No |
| `audit:read` | Auditoría | No |
| `users:manage` | Usuarios del staff | No |
| `roles:manage` | Roles y permisos | No |
| `integrations:manage` | Integraciones y credenciales | No |
| `settings:manage` | Configuración | No |

## Roles del sistema

| Rol | Permisos |
|---|---|
| `super_admin` | Todos. **Inmutable**. |
| `admin` | Todos menos `roles:manage` |
| `supervisor` | Lectura (asistentes, días, beneficios, consumos, estadísticas, reportes) + validar, consumir y **consumo excepcional** |
| `operator` | `event-days:read`, `benefits:validate`, `benefits:redeem` (scanner) |
| `viewer` | Lectura: asistentes, días, beneficios, consumos, estadísticas, reportes |

Se pueden crear roles personalizados en `/admin/roles` (requiere `roles:manage`).

## Salvaguardas

- **Anti-escalamiento**: nadie puede otorgar un rol que contenga permisos que él mismo no tiene (salvo `super_admin`).
- Solo un `super_admin` puede otorgar o retirar `super_admin`.
- No se puede dejar el sistema sin un `super_admin` activo.
- Nadie puede desactivarse a sí mismo.
- Todos los cambios quedan en auditoría (`CHANGE_ROLE`, `CHANGE_ROLE_PERMISSIONS`, `CREATE_ROLE`, `UPDATE_ROLE`).

## Asistentes

No tienen rol: su acceso se deriva de `attendees.auth_user_id`. RLS les permite leer solo su propio registro, sus beneficios y sus consumos. Una persona puede ser asistente y staff a la vez.

## Row Level Security

| Tabla | Quién puede leer |
|---|---|
| `attendees`, `attendee_event_days` | el propio asistente · `attendees:read` |
| `benefits` (sin columnas de token) | el propio asistente · `benefits:read` |
| `consumptions` | el propio asistente · `consumptions:read` |
| `profiles` | uno mismo · `users:manage` |
| `user_roles` | uno mismo · `users:manage` |
| `roles`, `permissions`, `role_permissions`, `app_settings` | cualquier usuario autenticado |
| `event_days` | público (incluido anónimo) |
| `api_integrations`, `api_credentials` (sin hash) | `integrations:manage` |
| `audit_logs` | `audit:read` |

Ninguna tabla tiene políticas de INSERT/UPDATE/DELETE para clientes. RLS está habilitado en **todas** las tablas.

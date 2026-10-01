# Estado del proyecto — Effi Drink Pass

Última actualización: 01/10/2026.

## Funcionalidades terminadas

| Área | Estado |
|---|---|
| Base de datos (10 migraciones, reconstruible) | ✅ |
| RLS en todas las tablas + RBAC (5 roles, 18 permisos, anti-escalamiento) | ✅ |
| Auth propia (asistentes con código OTP; staff con OTP o contraseña; vinculación por email verificado) | ✅ |
| Asistentes: CRUD, elegibilidad por día, `effi_id`/`effi_username` opcionales | ✅ |
| Beneficios: uno por día, generación automática, cancelar/restaurar/regenerar QR/expirar | ✅ |
| QR: token HMAC de 256 bits, solo hash almacenado, sin datos personales | ✅ |
| Consumo atómico (lock + UPDATE condicional + UNIQUE + máquina de estados), día/horario del servidor (America/Bogota) | ✅ |
| Consumo excepcional auditado (`benefits:override`) | ✅ |
| Idempotencia (`Idempotency-Key`) y rate limiting (BD + memoria) | ✅ |
| Portal del asistente (`/my-benefits`): estados por día, QR, caché offline del QR, detección de entrega | ✅ |
| Scanner (`/admin/scanner`): cámara, modos automático/confirmación, linterna, cambio de cámara, ingreso manual, sonido/vibración, pantalla sin conexión | ✅ |
| Dashboard con KPIs, filtros y 4 gráficas (con vista de tabla) | ✅ |
| Importación CSV/XLSX con mapeo, validación, dry-run, duplicados, reporte | ✅ |
| Administración: asistentes, beneficios, consumos, usuarios, roles, integraciones, auditoría, reportes CSV, configuración | ✅ |
| API REST `/api/v1` (Edge Function) con OAuth2 client credentials, API key y JWT de staff | ✅ |
| Integraciones: crear, editar, activar/desactivar, scopes, generar/rotar/revocar credenciales, último uso | ✅ |
| OpenAPI 3.1 + Swagger UI (`/api-docs`) | ✅ |
| Postman: colección (50 requests) + environment, verificada con Newman | ✅ |
| Auditoría inmutable de todos los eventos importantes | ✅ |
| Webhooks salientes `benefit.consumed`: suscripciones por integración, firma HMAC, reintentos con backoff, panel de entregas, despachador programado (Edge Function `webhooks` + pg_cron) | ✅ |
| PWA instalable (app shell en caché; nunca cachea la API) | ✅ |
| GitHub Actions: CI, deploy Pages, deploy Supabase (manual) | ✅ |
| Documentación (`docs/`) | ✅ |

**Pruebas automatizadas** (`npm test`): 152 pruebas en verde — unitarias; API HTTP end-to-end sobre PostgreSQL real (auth, scopes, 400–429, idempotencia, CORS, admin); base de datos (migraciones, privilegios, RLS, roles, CRUD, importación, beneficios, QR, consumo, doble consumo, inmutabilidad, idempotencia, integraciones, rate limit, lecturas API, scripts, webhooks) y despachador de webhooks (firma, reintentos, timeouts, destinos bloqueados). Más `npm run test:postman` (colección completa, 0 fallos).

## Pendiente / no verificado aún

| Ítem | Detalle |
|---|---|
| Crear el proyecto Supabase y el repositorio GitHub | No existían; deben crearse (pasos abajo) |
| Prueba de concurrencia contra Supabase real | Escrita (`tests/integration/concurrency.test.ts`); requiere staging y variables `E2E_*`. En PGlite (una conexión) la concurrencia real no se puede simular; la garantía está en el diseño SQL y en las pruebas de integridad |
| Prueba visual del frontend en dispositivos reales | El frontend compila y los tipos pasan, pero **no se ha ejecutado en un navegador contra un Supabase real** (no había proyecto). Probar scanner en Android, iPhone y tablet antes de la feria |
| Programar el despachador de webhooks | Requiere habilitar pg_cron/pg_net y ejecutar `supabase/scripts/schedule_webhooks.sql` en el proyecto real (solo si alguna integración usará webhooks) |
| Fechas oficiales del evento | Se configuran en Admin → Configuración. El seed usa 15–19/10/2026 **solo como ejemplo** |
| SMTP propio y plantillas de email con código | Configuración manual en Supabase |

## Configuración requerida

### Variables de entorno

| Variable | Dónde | Pública |
|---|---|---|
| `VITE_SUPABASE_URL` | GitHub Variables / `.env.local` | Sí |
| `VITE_SUPABASE_ANON_KEY` | GitHub Variables / `.env.local` | Sí (anon/publishable) |
| `VITE_PUBLIC_APP_URL` | GitHub Variables | Sí |
| `PAGES_BASE_PATH` | GitHub Variables (opcional) | Sí |
| `API_JWT_SECRET` | Supabase secrets (+ GitHub Secret para el workflow) | **No** |
| `API_ALLOWED_ORIGINS` | Supabase secrets | — |
| `WEBHOOK_DISPATCHER_SECRET` | Supabase secrets + Vault (schedule_webhooks.sql) | **No** |
| `SUPABASE_SERVICE_ROLE_KEY` | Solo inyectada por Supabase en la Edge Function | **No — nunca en el frontend ni en el repo** |
| `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD` | GitHub Secrets (workflow de deploy) | **No** |

### Supabase
Proyecto propio → migraciones → Auth (Site URL, redirects, plantillas con `{{ .Token }}`, SMTP) → Edge Function `api` con `--no-verify-jwt` y `API_JWT_SECRET`. Detalle en [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

### GitHub
Repositorio → Pages con *GitHub Actions* → variables `VITE_*` → push a `main`. Secrets para el deploy de Supabase si se usa el workflow.

## Cómo crear el primer Super Admin

1. Editar email y nombre en `supabase/scripts/bootstrap_super_admin.sql`.
2. Ejecutarlo en Supabase → SQL Editor.
3. Esa persona entra a `/login` → *Código por email* con ese email → queda vinculada como `super_admin`.
4. Desde `/admin/users` crea al resto del staff.

## Cómo importar asistentes

Admin → **Importación** → subir CSV/XLSX (plantilla disponible) → revisar mapeo → elegir *actualizar u omitir existentes* y los **días elegibles** → *Validar* (previsualización del servidor) → *Confirmar* → descargar reporte. Ver [docs/IMPORT.md](docs/IMPORT.md).

## Cómo generar beneficios

Se generan **solos** al asignar días elegibles (importación, ficha del asistente, API o *Asignar día a todos* en Beneficios). *Generar faltantes* en Admin → Beneficios cubre cualquier caso rezagado sin tocar los existentes.

## Cómo probar el scanner

1. Crear un día del evento con **la fecha de hoy** (Admin → Configuración).
2. Crear un asistente con **su email real de prueba** y ese día elegible.
3. En un teléfono, entrar como ese asistente → *Mis beneficios* → *Mostrar QR*.
4. En otro dispositivo, como operador → `/admin/scanner` → escanear:
   - modo confirmación → *Confirmar entrega* → **BENEFICIO APROBADO**;
   - escanear de nuevo → **BENEFICIO YA CONSUMIDO**;
   - QR de otro día → **QR NO VÁLIDO PARA HOY**;
   - activar modo avión → **SIN CONEXIÓN — NO ES POSIBLE CONFIRMAR EL CONSUMO**.

## Cómo probar la API

```bash
curl https://<REF>.supabase.co/functions/v1/api/v1/health
```
Crear una integración y credencial en Admin → Integraciones, luego ver ejemplos en [docs/API.md](docs/API.md) o abrir `/api-docs`.

## Cómo usar Postman

Importar `docs/postman/*.json`, completar `base_url`, `supabase_url`, `supabase_anon_key`, `staff_email`, `staff_password` y ejecutar la colección con el Runner en **staging**. Ver [docs/POSTMAN.md](docs/POSTMAN.md).

## Cómo desplegar

Ver [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): Supabase (migraciones + función) y GitHub Pages (push a `main`). Checklist previo a la feria incluido.

## Problemas conocidos

- **Cámara solo con HTTPS** (o `localhost`): para probar desde un celular en la red local se necesita un túnel HTTPS o el despliegue en Pages.
- **Registro abierto en Auth**: cualquiera puede crear una cuenta con OTP, pero sin registro de asistente/staff no ve ni puede hacer nada. Puede cerrarse (invitaciones) si se prefiere.
- **SMTP por defecto de Supabase** tiene límites muy bajos: configurar SMTP propio antes de invitar asistentes.
- El QR queda guardado en el teléfono del asistente para mostrarlo sin señal; si se filtra una captura, usar *Regenerar QR*.
- La zona horaria del evento está fija en `America/Bogota` (Colombia no tiene horario de verano).
- El bundle de Swagger UI (~1,4 MB) se carga solo en `/api-docs` y no forma parte de la caché offline de la PWA.
- `npm audit`: 0 vulnerabilidades en dependencias. Newman se ejecuta con `npx` (no es dependencia del proyecto) porque sus dependencias transitivas tienen avisos conocidos.

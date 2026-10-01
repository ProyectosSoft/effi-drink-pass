# Postman

Archivos:

- `docs/postman/Effi-Drink-Pass.postman_collection.json` — 10 carpetas, 50 requests con tests.
- `docs/postman/Effi-Drink-Pass.postman_environment.json` — variables (valores vacíos).

Ambos se generan con `npm run postman` desde `scripts/build-postman.mjs` (edite el script, no el JSON).

## Preparación

1. Importar colección y environment en Postman. Duplicar el environment y completar:

   | Variable | Valor |
   |---|---|
   | `base_url` | `https://<REF>.supabase.co/functions/v1/api` |
   | `supabase_url` | `https://<REF>.supabase.co` |
   | `supabase_anon_key` | anon/publishable key |
   | `staff_email` / `staff_password` | usuario del staff con `integrations:manage` y contraseña definida (Mi cuenta) |
   | `benefit_id_expired` | opcional: id de un beneficio de un día ya terminado |
   | `qr_token` | opcional: token de un beneficio demo (`supabase/scripts/demo_tokens.sql`) |

   El resto (`client_id`, `client_secret`, `api_key`, `access_token`, `attendee_id`, `benefit_id`, `event_day_id`, …) lo completan los propios tests.

2. **Debe existir un día del evento con la fecha de HOY** (hora de Colombia) para que el consumo se apruebe. Antes de la feria, en staging, cree un día de prueba con la fecha actual en Admin → Configuración.

3. Usar un proyecto de **staging**, nunca producción (la colección crea integraciones, asistentes y consumos de prueba).

## Ejecución

Runner de Postman → colección completa, en orden. Flujo:

| Carpeta | Qué prueba |
|---|---|
| 00 Health | `GET /v1/health` |
| 01 Staff | Login Supabase Auth → `staff_jwt`; crear integración; credencial completa y de solo lectura; una integración no puede administrar (403) |
| 02 Integraciones | OAuth2 client_credentials, credenciales inválidas (401), grant no soportado (400), `/v1/me`, `X-API-Key` |
| 03 Días | Detecta el día de hoy → `event_day_id` |
| 04 Asistentes | Crear, listar, buscar por `effi_id`, obtener, PATCH, días elegibles, beneficios |
| 05 Beneficios | Estado, validar, **consumir con Idempotency-Key**, reintento idéntico (replay), **segundo consumo (409)**, QR inválido (404), **otro día (422)**, **expirado (422)**, validar por token |
| 06 Consumos | Listado por `effi_id` y detalle |
| 07 Estadísticas | Global y por día |
| 08 Errores | 400, 401, 403, 404, 409, 413, 415, 422, **429** (se repite hasta agotar el límite de 30/min) |
| 09 Rotación | Rotar credencial → la anterior da 401 `CREDENTIAL_REVOKED`; revocar |

Tests comunes a toda la colección: `X-Request-Id`, `Cache-Control: no-store`, formato de error y que un eventual 500 no filtre detalles internos.

**500**: no hay un endpoint para provocar fallos en producción a propósito. El formato de 500 se valida si ocurre, y está cubierto por pruebas unitarias (`tests/unit/jwt-errors.test.ts`).

El pre-request de la colección obtiene y **renueva automáticamente** el access token OAuth2 cuando hay `client_id`/`client_secret`; no hace falta editar requests a mano.

## Verificación automática

`npm run test:postman` levanta la API real (mismo código de la Edge Function) sobre PostgreSQL embebido con todas las migraciones, simula el login de Supabase Auth, y ejecuta la colección completa con Newman. Debe terminar con 0 aserciones fallidas.

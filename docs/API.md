# API pública v1

Especificación completa: [openapi.yaml](openapi.yaml) (OpenAPI 3.1). Documentación interactiva (Swagger UI) en la ruta **`/api-docs`** del frontend.

**URL base:** `https://<project-ref>.supabase.co/functions/v1/api` (todas las rutas empiezan por `/v1/`).

## Endpoints

| Método | Ruta | Scope | Descripción |
|---|---|---|---|
| GET | `/v1/health` | público | Estado del servicio y de la base de datos |
| POST | `/v1/oauth/token` | — | OAuth2 client_credentials → access token (1 h) |
| GET | `/v1/me` | cualquiera | Identidad y scopes de la credencial |
| GET | `/v1/event-days` · `/v1/event-days/{id}` | `event-days:read` | Días del evento (`is_today` según el servidor) |
| GET | `/v1/attendees` | `attendees:read` | Búsqueda paginada (`effi_id`, `effi_username`, `email`, `q`, `tipo_acceso`, `empresa`, `activo`, `event_day_id`, `updated_since`) |
| GET | `/v1/attendees/{id}` | `attendees:read` | Detalle con días de elegibilidad |
| POST | `/v1/attendees` | `attendees:write` | Crear (con `event_day_ids` opcionales) |
| PATCH / PUT | `/v1/attendees/{id}` | `attendees:write` | Actualizar parcial / reemplazar |
| PUT | `/v1/attendees/{id}/event-days` | `attendees:write` | Definir días elegibles |
| GET | `/v1/attendees/{id}/benefits` | `benefits:read` | Beneficios del asistente |
| GET | `/v1/benefits` · `/v1/benefits/{id}` | `benefits:read` | Listado / estado (con consumo) |
| POST | `/v1/benefits/{id}/validate` | `benefits:validate` | Validar sin consumir |
| POST | `/v1/benefits/{id}/redeem` | `benefits:redeem` | **Consumo atómico** (`Idempotency-Key`) |
| POST | `/v1/benefits/validate` · `/v1/benefits/redeem` | idem | Igual, identificando el beneficio por el **token del QR** |
| POST | `/v1/benefits/generate` | `benefits:write` | Generar beneficios faltantes |
| GET | `/v1/consumptions` · `/v1/consumptions/{id}` | `consumptions:read` | Historial |
| GET | `/v1/statistics` | `statistics:read` | Totales y series |
| POST | `/v1/admin/integrations` | staff + `integrations:manage` | Crear integración |
| POST | `/v1/admin/integrations/{id}/credentials` | staff | Emitir credencial |
| POST | `/v1/admin/credentials/{id}/rotate` · `/revoke` | staff | Rotar / revocar |

## Ejemplos

```bash
BASE=https://<ref>.supabase.co/functions/v1/api

# 1) Token
TOKEN=$(curl -s -X POST $BASE/v1/oauth/token \
  -d grant_type=client_credentials -d client_id=$CLIENT_ID -d client_secret=$CLIENT_SECRET | jq -r .access_token)

# 2) Asistente por ID Effi
curl -s "$BASE/v1/attendees?effi_id=123456" -H "Authorization: Bearer $TOKEN"

# 3) Beneficios del asistente
curl -s "$BASE/v1/attendees/$ATTENDEE_ID/benefits" -H "Authorization: Bearer $TOKEN"

# 4) Consumir con idempotencia
curl -s -X POST "$BASE/v1/benefits/$BENEFIT_ID/redeem" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" -d '{"metadata":{"pos":"barra-2"}}'
```

## Resultados de validación / consumo

| `code` | Mensaje | HTTP en `redeem` |
|---|---|---|
| `APPROVED` | BENEFICIO APROBADO | 200 |
| `VALID` | QR VÁLIDO (solo `validate`) | 200 |
| `ALREADY_CONSUMED` | BENEFICIO YA CONSUMIDO | 409 |
| `INVALID_QR` / `BENEFIT_NOT_FOUND` | QR INVÁLIDO / BENEFICIO NO ENCONTRADO | 404 |
| `NOT_TODAY` | QR NO VÁLIDO PARA HOY | 422 |
| `NOT_STARTED` | FUERA DE HORARIO | 422 |
| `EXPIRED` | BENEFICIO EXPIRADO | 422 |
| `NOT_ELIGIBLE` | USUARIO NO ELEGIBLE | 422 |
| `ATTENDEE_INACTIVE` | USUARIO INACTIVO | 422 |
| `CANCELLED` | BENEFICIO CANCELADO | 422 |
| `DAY_INACTIVE` | DÍA NO HABILITADO | 422 |
| `IDEMPOTENCY_KEY_REUSED` | — | 422 |

`validate` responde siempre **200** con `data.ok`/`data.code` (salvo 404 si el `id` de la ruta no existe).

## Errores

```json
{ "error": { "code": "INSUFFICIENT_SCOPE", "message": "La credencial no tiene el scope requerido",
             "details": { "required": "consumptions:read" }, "request_id": "5f0c…" } }
```

| HTTP | Códigos |
|---|---|
| 400 | `VALIDATION_ERROR` (query/path), `INVALID_PARAMETER`, `INVALID_JSON` |
| 401 | `UNAUTHENTICATED`, `INVALID_TOKEN`, `TOKEN_EXPIRED`, `INVALID_CREDENTIALS`, `CREDENTIAL_REVOKED`, `CREDENTIAL_EXPIRED`, `INVALID_API_KEY` |
| 403 | `INSUFFICIENT_SCOPE`, `FORBIDDEN`, `INTEGRATION_DISABLED`, `STAFF_ONLY` |
| 404 | `NOT_FOUND`, `ROUTE_NOT_FOUND`, `INVALID_QR` |
| 405 | `METHOD_NOT_ALLOWED` (con cabecera `Allow`) |
| 409 | `CONFLICT` (identificador duplicado), `ALREADY_CONSUMED` |
| 413 | `PAYLOAD_TOO_LARGE` (> 64 KB) |
| 415 | `UNSUPPORTED_MEDIA_TYPE` |
| 422 | `VALIDATION_ERROR` (cuerpo, con `details.fields`), códigos de negocio |
| 429 | `RATE_LIMITED` (+ `Retry-After`) |
| 500 | `INTERNAL_ERROR` (sin detalles internos; use el `request_id` para buscar en los logs) |

## Versionamiento

- Cambios compatibles (campos nuevos, endpoints nuevos) se publican en `v1`.
- Cambios incompatibles → `/v2/` conviviendo con `/v1/` durante la transición.
- Los clientes deben ignorar campos desconocidos.

## Sincronización con Effi (opcional)

| Necesidad de Effi | Llamada |
|---|---|
| ¿Existe este usuario? | `GET /v1/attendees?effi_id=…` o `?effi_username=…` |
| Beneficios del usuario | `GET /v1/attendees/{id}/benefits` |
| Estado de un beneficio | `GET /v1/benefits/{id}` |
| Consumos (incremental) | `GET /v1/consumptions?from=<ISO>` |
| Crear/actualizar asistentes | `POST /v1/attendees`, `PATCH /v1/attendees/{id}` (scope `attendees:write`) |
| Cambios de asistentes | `GET /v1/attendees?updated_since=<ISO>` |

Ninguna de estas llamadas es necesaria para que el sistema funcione.

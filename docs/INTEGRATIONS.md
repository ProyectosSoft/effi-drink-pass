# Integraciones externas

Effi, el sistema de registro, la boletería, apps móviles u otros sistemas de la feria son **consumidores externos opcionales** de la API. Nunca se conectan a la base de datos.

```
Sistema externo ──HTTPS──► /api/v1 ──► autenticación ──► scopes ──► rate limit ──► lógica (SQL) ──► PostgreSQL
```

## Crear una integración (Admin → Integraciones)

1. **Nueva integración**: nombre (p. ej. *Effi ERP*), descripción, email técnico y **scopes permitidos** (el techo).
2. **Generar credencial**: elegir los scopes de esa credencial (subconjunto del techo) y, recomendado, una fecha de expiración.
3. Copiar `client_id` y `client_secret` (**se muestran una sola vez**) y entregarlos por un canal seguro.

Ejemplo de mínimo privilegio para Effi en modo consulta:
`attendees:read`, `benefits:read`, `consumptions:read`.

## Formato de credenciales

| Dato | Formato | Almacenamiento |
|---|---|---|
| `client_id` | `edp_ci_` + 24 hex | texto (público) |
| `client_secret` | `edp_sk_` + 43 caracteres base64url (256 bits) | **solo SHA-256** + últimos 4 caracteres para identificarlo |
| API key | `client_id.client_secret` | — |

Como el secreto es aleatorio de 256 bits, SHA-256 es suficiente (no hay diccionario que atacar); no se usan contraseñas humanas.

## Autenticarse

**OAuth2 client credentials (recomendado)**

```http
POST /v1/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&client_id=edp_ci_…&client_secret=edp_sk_…&scope=attendees:read
```

Respuesta: `{ "access_token": "…", "token_type": "Bearer", "expires_in": 3600, "scope": "attendees:read" }`.
También acepta JSON o `Authorization: Basic base64(client_id:client_secret)`. El token es JWT HS256 firmado con `API_JWT_SECRET`; en cada request se revalida que la credencial siga activa, así que **revocar corta el acceso de inmediato** aunque el token no haya expirado.

**API key**: cabecera `X-API-Key: <client_id>.<client_secret>` en cada request (más simple; el secreto viaja siempre).

## Ciclo de vida

| Acción | Efecto |
|---|---|
| Desactivar integración | Bloquea todas sus credenciales al instante |
| Reducir scopes permitidos | Recorta los scopes de sus credenciales |
| **Rotar** | Emite una credencial nueva con los mismos scopes y revoca la anterior |
| **Revocar** | La credencial deja de funcionar (motivo auditado) |
| Último uso | `last_used_at` / `last_used_ip` (granularidad 1 min) visibles en el panel |

Todo queda auditado: `CREATE_INTEGRATION`, `UPDATE_INTEGRATION`, `DISABLE_INTEGRATION`, `CREATE_API_KEY`, `ROTATE_API_KEY`, `REVOKE_API_KEY`, `API_TOKEN_ISSUED`, `API_AUTH_FAILED`.

## Buenas prácticas para el integrador

- Guardar el secreto en un gestor de secretos, nunca en el código ni en el frontend.
- Reutilizar el access token hasta su expiración (no pedir uno por request).
- Enviar `Idempotency-Key` en cada consumo y reutilizarla solo para reintentar **el mismo** intento.
- Respetar `429` + `Retry-After` con backoff exponencial.
- Enviar `X-Request-Id` propio para correlacionar logs.

## Webhooks (preparado)

Cada consumo inserta el evento `benefit.consumed` en `private.event_outbox` dentro de la misma transacción:

```json
{ "benefit_id": "…", "attendee_id": "…", "effi_id": "123456", "event_day": "2026-10-16",
  "consumption_id": "…", "consumed_at": "…", "is_override": false }
```

Diseño previsto para la entrega (no implementado todavía):
1. Tabla `webhook_subscriptions` (integración, URL HTTPS, eventos, secreto de firma cifrado).
2. Edge Function programada que lee el outbox (`dispatched_at is null`), firma con HMAC-SHA256 (`X-EDP-Signature`), reintenta con backoff (`attempts`, `last_error`) y marca `dispatched_at`.
3. Entrega *at-least-once*; el receptor deduplica por `consumption_id`.

Así la operación del scanner nunca depende de que un tercero responda.

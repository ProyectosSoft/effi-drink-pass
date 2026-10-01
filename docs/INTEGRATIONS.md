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

## Webhooks

Notificaciones salientes casi en tiempo real (≤ 1 min) cuando ocurre un evento. Evento disponible: **`benefit.consumed`**.

### Configuración (Admin → Integraciones → Webhooks)

- Requisito: la integración debe tener el scope `consumptions:read` (el evento contiene datos de consumo).
- URL **HTTPS** a un host público con nombre (se rechazan IPs, `localhost` y dominios internos).
- Al crear (o rotar) se muestra **una vez** el secreto de firma `whsec_…`.
- Se puede pausar/activar, ver las últimas entregas (estado, intentos, código HTTP, error) y reintentar las fallidas.

### Entrega

```http
POST <url>
Content-Type: application/json
User-Agent: EffiDrinkPass-Webhooks/1.0
X-EDP-Event: benefit.consumed
X-EDP-Delivery: 1234
X-EDP-Attempt: 1
X-EDP-Signature: t=1792162805,v1=5f2b…(hex)

{ "id": "evt_987", "type": "benefit.consumed", "created_at": "2026-10-16T15:00:00Z",
  "data": { "benefit_id": "…", "attendee_id": "…", "effi_id": "123456", "event_day": "2026-10-16",
            "consumption_id": "…", "consumed_at": "…", "is_override": false } }
```

- Éxito = respuesta **2xx en ≤ 10 s**. No se siguen redirecciones.
- Fallo → reintentos con espera creciente: 30 s, 2 min, 10 min, 30 min, 1 h, 3 h, 6 h (8 intentos, ≈ 10 h). Luego queda `failed` y se puede reintentar desde el panel.
- Entrega **at-least-once**: deduplicar por `X-EDP-Delivery` o `data.consumption_id`.
- El orden no está garantizado; use `data.consumed_at`.

### Verificar la firma (receptor)

`v1 = hex(HMAC-SHA256(secreto, "<t>.<cuerpo crudo>"))`. Compare en tiempo constante y rechace `t` con más de 5 minutos de diferencia.

```js
import crypto from 'node:crypto'
function verify(secret, header, rawBody) {
  const { t, v1 } = Object.fromEntries(header.split(',').map((p) => p.split('=')))
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')
  return v1?.length === expected.length && crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected))
}
```

### Arquitectura

Consumo → `private.event_outbox` (misma transacción) → trigger de *fan-out* → `private.webhook_deliveries` (una por suscripción) → Edge Function **`webhooks`** invocada cada minuto por `pg_cron` → `webhooks_claim` (lotes con `FOR UPDATE SKIP LOCKED` y arriendo) → POST firmado → `webhooks_report` (backoff). La operación del scanner nunca espera a un tercero. Programación: `supabase/scripts/schedule_webhooks.sql`.

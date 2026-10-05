import { describe, it, expect, beforeAll } from 'vitest'
import { createApi } from '../../supabase/functions/_shared/app.ts'
import { signJwt, TOKEN_AUDIENCE, TOKEN_ISSUER, base64UrlEncode } from '../../supabase/functions/_shared/jwt.ts'
import { scenario, type Scenario } from '../db/fixtures'
import { rpc, tokenFor } from '../db/harness'
import { pglitePort, fakeSupabaseJwt } from './pglite-port'

const SECRET = 'test-secret-with-at-least-32-characters-long!!'
const BASE = 'https://ref.supabase.co/functions/v1/api'

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

describe('API REST v1 (end-to-end contra PostgreSQL)', () => {
  let s: Scenario
  let handle: (req: Request) => Promise<Response>
  let integrationId: string
  let full: { id: string; client_id: string; client_secret: string; api_key: string }
  let readonly: { id: string; client_id: string; client_secret: string; api_key: string }
  let accessToken: string
  const logs: Json[] = []

  const req = async (method: string, path: string, opts: { headers?: Record<string, string>; body?: unknown; raw?: string } = {}) => {
    const headers: Record<string, string> = { ...opts.headers }
    let body: string | undefined
    if (opts.raw !== undefined) body = opts.raw
    else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body)
      headers['content-type'] ??= 'application/json'
    }
    const res = await handle(new Request(`${BASE}${path}`, { method, headers, body }))
    const text = await res.text()
    return { status: res.status, headers: res.headers, json: (text ? JSON.parse(text) : null) as Json }
  }
  const bearer = (t = accessToken) => ({ authorization: `Bearer ${t}` })

  beforeAll(async () => {
    s = await scenario()
    handle = createApi(pglitePort(s.db), { jwtSecret: SECRET, allowedOrigins: ['https://app.example.com'], log: (e) => logs.push(e) })
    integrationId = await rpc<string>(s.db, s.admin.authId, 'create_integration', {
      p_name: 'Effi ERP', p_description: 'Integración opcional',
      p_allowed_scopes: ['attendees:read', 'attendees:write', 'event-days:read', 'benefits:read', 'benefits:validate', 'benefits:redeem', 'consumptions:read', 'statistics:read'] })
    full = await rpc(s.db, s.admin.authId, 'create_api_credential', {
      p_integration_id: integrationId,
      p_scopes: ['attendees:read', 'attendees:write', 'event-days:read', 'benefits:read', 'benefits:validate', 'benefits:redeem', 'consumptions:read', 'statistics:read'] })
    readonly = await rpc(s.db, s.admin.authId, 'create_api_credential', { p_integration_id: integrationId, p_scopes: ['attendees:read'] })
  }, 120_000)

  describe('health y enrutamiento', () => {
    it('GET /v1/health es público y verifica la base de datos', async () => {
      const r = await req('GET', '/v1/health')
      expect(r.status).toBe(200)
      expect(r.json).toMatchObject({ status: 'ok', checks: { database: 'ok' } })
      expect(r.headers.get('x-request-id')).toBeTruthy()
    })

    it('acepta las tres formas de ruta (/functions/v1/api, /api, /)', async () => {
      for (const url of ['https://x/functions/v1/api/v1/health', 'https://x/api/v1/health', 'https://x/v1/health']) {
        expect((await handle(new Request(url))).status).toBe(200)
      }
    })

    it('404 ruta inexistente, 405 método no permitido', async () => {
      expect((await req('GET', '/v1/nada')).status).toBe(404)
      const r = await req('DELETE', '/v1/attendees')
      expect(r.status).toBe(405)
      expect(r.headers.get('allow')).toContain('GET')
    })

    it('CORS: preflight para orígenes permitidos; nada para otros', async () => {
      const ok = await req('OPTIONS', '/v1/attendees', { headers: { origin: 'https://app.example.com' } })
      expect(ok.status).toBe(204)
      expect(ok.headers.get('access-control-allow-origin')).toBe('https://app.example.com')
      const bad = await req('OPTIONS', '/v1/attendees', { headers: { origin: 'https://evil.example' } })
      expect(bad.headers.get('access-control-allow-origin')).toBeNull()
    })
  })

  describe('autenticación', () => {
    it('401 sin credenciales', async () => {
      const r = await req('GET', '/v1/attendees')
      expect(r.status).toBe(401)
      expect(r.json.error).toMatchObject({ code: 'UNAUTHENTICATED' })
      expect(r.json.error.request_id).toBeTruthy()
    })

    it('OAuth2 client_credentials (form) emite token Bearer', async () => {
      const r = await req('POST', '/v1/oauth/token', {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        raw: new URLSearchParams({ grant_type: 'client_credentials', client_id: full.client_id, client_secret: full.client_secret }).toString(),
      })
      expect(r.status).toBe(200)
      expect(r.json).toMatchObject({ token_type: 'Bearer', expires_in: 3600 })
      expect(r.headers.get('cache-control')).toContain('no-store')
      accessToken = r.json.access_token
    })

    it('OAuth2 con JSON y con HTTP Basic; scope reducido', async () => {
      const j = await req('POST', '/v1/oauth/token', { body: { grant_type: 'client_credentials', client_id: full.client_id, client_secret: full.client_secret, scope: 'attendees:read' } })
      expect(j.json.scope).toBe('attendees:read')
      const basic = Buffer.from(`${full.client_id}:${full.client_secret}`).toString('base64')
      const b = await req('POST', '/v1/oauth/token', { headers: { authorization: `Basic ${basic}` }, body: { grant_type: 'client_credentials' } })
      expect(b.status).toBe(200)
      // El token de scope reducido no puede escribir.
      const w = await req('POST', '/v1/attendees', { headers: bearer(j.json.access_token), body: { nombres: 'X' } })
      expect(w.status).toBe(403)
    })

    it('OAuth2 errores RFC 6749: invalid_client, unsupported_grant_type, invalid_scope', async () => {
      expect((await req('POST', '/v1/oauth/token', { body: { grant_type: 'client_credentials', client_id: full.client_id, client_secret: 'nope' } })).json.error).toBe('invalid_client')
      expect((await req('POST', '/v1/oauth/token', { body: { grant_type: 'password' } })).json.error).toBe('unsupported_grant_type')
      const sc = await req('POST', '/v1/oauth/token', { body: { grant_type: 'client_credentials', client_id: readonly.client_id, client_secret: readonly.client_secret, scope: 'benefits:redeem' } })
      expect(sc.json.error).toBe('invalid_scope')
    })

    it('X-API-Key funciona sin pasar por /oauth/token', async () => {
      const r = await req('GET', '/v1/me', { headers: { 'x-api-key': readonly.api_key } })
      expect(r.status).toBe(200)
      expect(r.json.data).toMatchObject({ type: 'integration', label: 'Effi ERP', scopes: ['attendees:read'] })
    })

    it('tokens manipulados, con alg=none o expirados → 401', async () => {
      const parts = accessToken.split('.')
      const tampered = `${parts[0]}.${base64UrlEncode(new TextEncoder().encode(JSON.stringify({ iss: TOKEN_ISSUER, sub: full.id, scope: 'users:manage', exp: 9e9 })))}.${parts[2]}`
      expect((await req('GET', '/v1/me', { headers: bearer(tampered) })).status).toBe(401)
      const none = `${base64UrlEncode(new TextEncoder().encode('{"alg":"none"}'))}.${parts[1]}.`
      expect((await req('GET', '/v1/me', { headers: bearer(none) })).status).toBe(401)
      const expired = await signJwt({ iss: TOKEN_ISSUER, aud: TOKEN_AUDIENCE, sub: full.id, cid: full.client_id, int: integrationId,
        scope: 'attendees:read', iat: 1, exp: 2, jti: 'x' }, SECRET)
      const r = await req('GET', '/v1/me', { headers: bearer(expired) })
      expect(r.status).toBe(401)
      expect(r.json.error.code).toBe('TOKEN_EXPIRED')
    })

    it('403 por scope insuficiente', async () => {
      const r = await req('GET', '/v1/consumptions', { headers: { 'x-api-key': readonly.api_key } })
      expect(r.status).toBe(403)
      expect(r.json.error).toMatchObject({ code: 'INSUFFICIENT_SCOPE', details: { required: 'consumptions:read' } })
    })

    it('JWT de staff: el operador puede validar pero no leer asistentes', async () => {
      const jwt = fakeSupabaseJwt(s.operator.authId)
      expect((await req('GET', '/v1/attendees', { headers: bearer(jwt) })).status).toBe(403)
      const me = await req('GET', '/v1/me', { headers: bearer(jwt) })
      expect(me.json.data.type).toBe('user')
      // Un asistente (sin perfil de staff) no puede usar la API.
      expect((await req('GET', '/v1/me', { headers: bearer(fakeSupabaseJwt(s.attendeeAuth)) })).status).toBe(403)
    })
  })

  describe('asistentes', () => {
    let createdId: string

    it('GET por effi_id', async () => {
      const r = await req('GET', '/v1/attendees?effi_id=123456', { headers: bearer() })
      expect(r.status).toBe(200)
      expect(r.json.meta.total).toBe(1)
      expect(r.json.data[0]).toMatchObject({ id: s.attendeeId, effi_username: 'juan.perez' })
    })

    it('POST crea (201 + Location) con días; sin effi_id es válido', async () => {
      const r = await req('POST', '/v1/attendees', { headers: bearer(), body: {
        nombres: 'Carla', apellidos: 'Ruiz', email: 'carla@x.co', tipo_acceso: 'general', event_day_ids: [s.days['2026-10-16']] } })
      expect(r.status).toBe(201)
      createdId = r.json.data.id
      expect(r.headers.get('location')).toBe(`/api/v1/attendees/${createdId}`)
      expect(r.json.data.event_days).toHaveLength(1)
      const b = await req('GET', `/v1/attendees/${createdId}/benefits`, { headers: bearer() })
      expect(b.json.data).toHaveLength(1)
    })

    it('409 por identificador duplicado', async () => {
      const r = await req('POST', '/v1/attendees', { headers: bearer(), body: { nombres: 'Otro', effi_id: '123456' } })
      expect(r.status).toBe(409)
      expect(r.json.error.code).toBe('CONFLICT')
    })

    it('422 por validación (campos, email, campo desconocido)', async () => {
      const r = await req('POST', '/v1/attendees', { headers: bearer(), body: { apellidos: 'Sin nombre', email: 'malo', hack: 1 } })
      expect(r.status).toBe(422)
      const fields = r.json.error.details.fields.map((f: Json) => f.field)
      expect(fields).toEqual(expect.arrayContaining(['nombres', 'email']))
    })

    it('PATCH parcial y PUT de días', async () => {
      const p = await req('PATCH', `/v1/attendees/${createdId}`, { headers: bearer(), body: { empresa: 'Initech', effi_id: 'E-777' } })
      expect(p.status).toBe(200)
      expect(p.json.data).toMatchObject({ empresa: 'Initech', effi_id: 'E-777', nombres: 'Carla' })
      const d = await req('PUT', `/v1/attendees/${createdId}/event-days`, { headers: bearer(), body: { event_day_ids: [s.days['2026-10-16'], s.days['2026-10-17']] } })
      expect(d.json.data.event_days.filter((x: Json) => x.eligible)).toHaveLength(2)
    })

    it('credencial solo-escritura no recibe el registro completo al escribir', async () => {
      await rpc(s.db, s.admin.authId, 'update_integration', { p_id: integrationId, p_name: 'Effi ERP', p_description: null,
        p_allowed_scopes: ['attendees:read', 'attendees:write', 'event-days:read', 'benefits:read', 'benefits:validate', 'benefits:redeem', 'consumptions:read', 'statistics:read'],
        p_contact_email: null, p_active: true })
      const w = await rpc<{ api_key: string }>(s.db, s.admin.authId, 'create_api_credential', { p_integration_id: integrationId, p_scopes: ['attendees:write'] })
      const r = await req('POST', '/v1/attendees', { headers: { 'x-api-key': w.api_key }, body: { nombres: 'Solo', email: 'solo@x.co' } })
      expect(r.status).toBe(201)
      expect(Object.keys(r.json.data)).toEqual(['id'])
    })

    it('400 id inválido, 404 inexistente, 400 query inválida', async () => {
      expect((await req('GET', '/v1/attendees/123', { headers: bearer() })).status).toBe(400)
      expect((await req('GET', '/v1/attendees/00000000-0000-4000-8000-000000000000', { headers: bearer() })).status).toBe(404)
      const q = await req('GET', '/v1/attendees?page_size=abc&inventado=1', { headers: bearer() })
      expect(q.status).toBe(400)
    })

    it('400 JSON inválido, 415 content-type, 413 payload grande', async () => {
      expect((await req('POST', '/v1/attendees', { headers: { ...bearer(), 'content-type': 'application/json' }, raw: '{mal' })).status).toBe(400)
      expect((await req('POST', '/v1/attendees', { headers: { ...bearer(), 'content-type': 'text/plain' }, raw: 'hola' })).status).toBe(415)
      const big = JSON.stringify({ nombres: 'x', metadata: { blob: 'a'.repeat(70_000) } })
      expect((await req('POST', '/v1/attendees', { headers: { ...bearer(), 'content-type': 'application/json' }, raw: big })).status).toBe(413)
    })

    it('413 también en streaming sin Content-Length (chunked): se corta al pasar 64 KB', async () => {
      let pulled = 0
      const chunk = new TextEncoder().encode('a'.repeat(16 * 1024))
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          pulled++
          if (pulled > 1000) c.close() // un cliente que nunca deja de enviar
          else c.enqueue(chunk)
        },
      })
      const res = await handle(new Request(`${BASE}/v1/attendees`, {
        method: 'POST', headers: { ...bearer(), 'content-type': 'application/json' }, body, duplex: 'half',
      } as RequestInit))
      expect(res.status).toBe(413)
      expect(pulled).toBeLessThan(10) // no leyó el stream completo
    })

    it('metadata de consumo acotada: máx. 20 claves de hasta 64 caracteres', async () => {
      const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 1]))
      const id = s.benefits['2026-10-16']
      expect((await req('POST', `/v1/benefits/${id}/validate`, { headers: bearer(), body: { metadata: many } })).status).toBe(422)
      expect((await req('POST', `/v1/benefits/${id}/validate`, { headers: bearer(), body: { metadata: { ['k'.repeat(65)]: 1 } } })).status).toBe(422)
    })

    it('búsqueda q: los comodines % y _ se tratan como texto literal', async () => {
      const r = await req('GET', '/v1/attendees?q=%25%25', { headers: bearer() })
      expect(r.status).toBe(200)
      expect(r.json.data).toHaveLength(0) // antes "%%" coincidía con todos los asistentes
    })
  })

  describe('validación y consumo', () => {
    it('validate por id → 200 VALID sin consumir', async () => {
      const r = await req('POST', `/v1/benefits/${s.benefits['2026-10-16']}/validate`, { headers: bearer(), body: {} })
      expect(r.status).toBe(200)
      expect(r.json.data).toMatchObject({ ok: true, code: 'VALID' })
    })

    it('redeem por token (URL del QR) con Idempotency-Key → 200; reintento → replay', async () => {
      const token = await tokenFor(s.db, s.benefits['2026-10-16'])
      const headers = { ...bearer(), 'idempotency-key': 'effi-erp-req-000001' }
      const r1 = await req('POST', '/v1/benefits/redeem', { headers, body: { token: `https://drinkpass.example.com/qr/${token}` } })
      expect(r1.status).toBe(200)
      expect(r1.json.data).toMatchObject({ code: 'APPROVED', message: 'BENEFICIO APROBADO' })
      const r2 = await req('POST', '/v1/benefits/redeem', { headers, body: { token: `https://drinkpass.example.com/qr/${token}` } })
      expect(r2.status).toBe(200)
      expect(r2.headers.get('idempotent-replayed')).toBe('true')
    })

    it('segundo consumo sin key → 409 BENEFICIO YA CONSUMIDO', async () => {
      const r = await req('POST', `/v1/benefits/${s.benefits['2026-10-16']}/redeem`, { headers: bearer(), body: {} })
      expect(r.status).toBe(409)
      expect(r.json.error).toMatchObject({ code: 'ALREADY_CONSUMED', message: 'BENEFICIO YA CONSUMIDO' })
      expect(r.json.data.consumption.operator).toBe('Effi ERP')
    })

    it('QR de otro día → 422 NOT_TODAY; expirado → 422 EXPIRED; inválido → 404', async () => {
      const t17 = await tokenFor(s.db, s.benefits['2026-10-17'])
      const other = await req('POST', '/v1/benefits/redeem', { headers: bearer(), body: { token: t17 } })
      expect(other.status).toBe(422)
      expect(other.json.error.message).toBe('QR NO VÁLIDO PARA HOY')
      const exp = await req('POST', `/v1/benefits/${s.benefits['2026-10-15']}/redeem`, { headers: bearer(), body: {} })
      expect(exp.status).toBe(422)
      expect(exp.json.error.code).toBe('EXPIRED')
      const inv = await req('POST', '/v1/benefits/redeem', { headers: bearer(), body: { token: 'x'.repeat(43) } })
      expect(inv.status).toBe(404)
      expect(inv.json.error.code).toBe('INVALID_QR')
      expect(inv.json.data.attendee).toBeNull()
    })

    it('token de un beneficio distinto al id de la ruta → no coincide (404)', async () => {
      const t17 = await tokenFor(s.db, s.benefits['2026-10-17'])
      const r = await req('POST', `/v1/benefits/${s.benefits['2026-10-16']}/redeem`, { headers: bearer(), body: { token: t17 } })
      expect(r.status).toBe(404)
    })

    it('Idempotency-Key inválida → 400', async () => {
      const r = await req('POST', `/v1/benefits/${s.benefits['2026-10-17']}/redeem`, { headers: { ...bearer(), 'idempotency-key': 'short' }, body: {} })
      expect(r.status).toBe(400)
    })

    it('consultas: beneficio, consumos y estadísticas', async () => {
      const b = await req('GET', `/v1/benefits/${s.benefits['2026-10-16']}`, { headers: bearer() })
      expect(b.json.data.status).toBe('CONSUMED')
      const c = await req('GET', '/v1/consumptions?effi_id=123456', { headers: bearer() })
      expect(c.json.meta.total).toBe(1)
      const one = await req('GET', `/v1/consumptions/${c.json.data[0].id}`, { headers: bearer() })
      expect(one.json.data.operator).toMatchObject({ type: 'integration', label: 'Effi ERP' })
      const st = await req('GET', '/v1/statistics', { headers: bearer() })
      expect(st.json.data.totals.consumed).toBe(1)
      const days = await req('GET', '/v1/event-days', { headers: bearer() })
      expect(days.json.data).toHaveLength(3)
    })
  })

  describe('rate limiting', () => {
    it('429 con Retry-After y cabeceras X-RateLimit al superar el límite de estadísticas (30/min)', async () => {
      let last: Awaited<ReturnType<typeof req>> | undefined
      for (let i = 0; i < 31; i++) last = await req('GET', '/v1/statistics', { headers: { 'x-api-key': full.api_key } })
      expect(last!.status).toBe(429)
      expect(last!.json.error.code).toBe('RATE_LIMITED')
      expect(Number(last!.headers.get('retry-after'))).toBeGreaterThan(0)
      expect(last!.headers.get('x-ratelimit-remaining')).toBe('0')
    })
  })

  describe('administración de integraciones (staff)', () => {
    it('staff crea integración, credencial, rota y revoca', async () => {
      const jwt = fakeSupabaseJwt(s.admin.authId)
      const i = await req('POST', '/v1/admin/integrations', { headers: bearer(jwt), body: { name: 'Boletería', allowed_scopes: ['attendees:read', 'attendees:write'] } })
      expect(i.status).toBe(201)
      const c = await req('POST', `/v1/admin/integrations/${i.json.data.id}/credentials`, { headers: bearer(jwt), body: { scopes: ['attendees:read'] } })
      expect(c.status).toBe(201)
      expect(c.json.data.client_secret).toMatch(/^edp_sk_/)
      const rot = await req('POST', `/v1/admin/credentials/${c.json.data.id}/rotate`, { headers: bearer(jwt) })
      expect(rot.status).toBe(201)
      const old = await req('GET', '/v1/me', { headers: { 'x-api-key': c.json.data.api_key } })
      expect(old.status).toBe(401)
      expect(old.json.error.code).toBe('CREDENTIAL_REVOKED')
      const rev = await req('POST', `/v1/admin/credentials/${rot.json.data.id}/revoke`, { headers: bearer(jwt), body: { reason: 'prueba' } })
      expect(rev.status).toBe(200)
    })

    it('una integración nunca puede usar endpoints de administración', async () => {
      const r = await req('POST', '/v1/admin/integrations', { headers: bearer(), body: { name: 'Hack', allowed_scopes: [] } })
      expect(r.status).toBe(403)
    })

    it('un operador (sin integrations:manage) tampoco', async () => {
      const r = await req('POST', '/v1/admin/integrations', { headers: bearer(fakeSupabaseJwt(s.operator.authId)), body: { name: 'Hack', allowed_scopes: [] } })
      expect(r.status).toBe(403)
    })
  })

  it('los logs no contienen secretos ni tokens', () => {
    const dump = JSON.stringify(logs)
    expect(dump).not.toContain(full.client_secret)
    expect(dump).not.toContain(accessToken)
  })
})

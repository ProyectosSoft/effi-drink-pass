import { describe, it, expect, beforeAll } from 'vitest'
import { rpc, asService, tokenFor, one, as } from './harness'
import { scenario, type Scenario } from './fixtures'

type Cred = { id: string; client_id: string; client_secret: string; api_key: string; scopes: string[] }
type Begin = {
  ok: boolean
  error?: string
  principal?: { type: string; integration_id: string; credential_id: string; scopes: string[]; label: string }
  rate?: { allowed: boolean; remaining: number; limit: number }
}

const begin = (s: Scenario, p: unknown) =>
  asService<{ r: Begin }>(s.db, `select public.api_begin_request($1::jsonb) as r`, [JSON.stringify(p)]).then((x) => x[0].r)

describe('integraciones y credenciales', () => {
  let s: Scenario
  let integrationId: string
  let cred: Cred

  beforeAll(async () => {
    s = await scenario()
    integrationId = await rpc<string>(s.db, s.admin.authId, 'create_integration', {
      p_name: 'Effi ERP', p_description: 'Consumidor externo opcional',
      p_allowed_scopes: ['attendees:read', 'benefits:read', 'benefits:validate', 'benefits:redeem', 'consumptions:read', 'statistics:read'],
      p_contact_email: 'ti@effi.example' })
    cred = await rpc<Cred>(s.db, s.admin.authId, 'create_api_credential', {
      p_integration_id: integrationId, p_scopes: ['attendees:read', 'benefits:redeem', 'benefits:validate'] })
  })

  it('el secreto se entrega una vez con formato fuerte y solo se guarda su hash', async () => {
    expect(cred.client_id).toMatch(/^edp_ci_[0-9a-f]{24}$/)
    expect(cred.client_secret).toMatch(/^edp_sk_[A-Za-z0-9_-]{43}$/)
    expect(cred.api_key).toBe(`${cred.client_id}.${cred.client_secret}`)
    const row = await one<{ credential_hash: string; secret_hint: string }>(s.db,
      `select credential_hash, secret_hint from public.api_credentials where id = $1`, [cred.id])
    expect(row.credential_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(row.credential_hash).not.toContain(cred.client_secret)
    expect(cred.client_secret.endsWith(row.secret_hint)).toBe(true)
    const audit = await s.db.query<{ m: string }>(`select metadata::text m from public.audit_logs`)
    for (const a of audit.rows) expect(a.m).not.toContain(cred.client_secret)
  })

  it('scopes exclusivos de staff no se pueden asignar a integraciones', async () => {
    await expect(rpc(s.db, s.admin.authId, 'create_integration', { p_name: 'Mala', p_description: null, p_allowed_scopes: ['users:manage'] }))
      .rejects.toThrow(/INVALID_SCOPE/)
    await expect(rpc(s.db, s.admin.authId, 'create_api_credential', { p_integration_id: integrationId, p_scopes: ['attendees:write'] }))
      .rejects.toThrow(/SCOPE_NOT_ALLOWED_FOR_INTEGRATION/)
  })

  it('autenticación client_credentials correcta devuelve principal con scopes y actualiza last_used_at', async () => {
    const r = await begin(s, { auth: { type: 'client_secret', client_id: cred.client_id, client_secret: cred.client_secret }, ip: '1.2.3.4', rate: { name: 'default', limit: 100, window: 60 } })
    expect(r.ok).toBe(true)
    expect(r.principal?.label).toBe('Effi ERP')
    expect(r.principal?.scopes.sort()).toEqual(['attendees:read', 'benefits:redeem', 'benefits:validate'])
    expect(r.rate?.allowed).toBe(true)
    const row = await one<{ last_used_at: string | null; last_used_ip: string }>(s.db, `select last_used_at, last_used_ip from public.api_credentials where id = $1`, [cred.id])
    expect(row.last_used_at).not.toBeNull()
    expect(row.last_used_ip).toBe('1.2.3.4')
  })

  it('secreto incorrecto → INVALID_CREDENTIALS y auditoría API_AUTH_FAILED', async () => {
    const r = await begin(s, { auth: { type: 'client_secret', client_id: cred.client_id, client_secret: 'edp_sk_wrong' }, ip: '9.9.9.9' })
    expect(r).toMatchObject({ ok: false, error: 'INVALID_CREDENTIALS' })
    const a = await one<{ n: number }>(s.db, `select count(*)::int n from public.audit_logs where action = 'API_AUTH_FAILED'`)
    expect(a.n).toBe(1)
  })

  it('rate limit: al superar el límite allowed=false', async () => {
    let last: Begin | undefined
    for (let i = 0; i < 4; i++) {
      last = await begin(s, { auth: { type: 'credential', credential_id: cred.id }, rate: { name: 'tight', limit: 3, window: 60 } })
    }
    expect(last?.rate?.allowed).toBe(false)
    expect(last?.rate?.remaining).toBe(0)
  })

  it('consumo vía API: scope requerido, auditado como integración y consumo atribuido', async () => {
    const principal = (await begin(s, { auth: { type: 'credential', credential_id: cred.id } })).principal
    const token = await tokenFor(s.db, s.benefits['2026-10-16'])
    const res = await asService<{ r: { code: string } }>(s.db,
      `select public.api_benefit_process($1::jsonb, 'redeem', $2, null, 'api-key-1234', '{}'::jsonb) as r`, [JSON.stringify(principal), token])
    expect(res[0].r.code).toBe('APPROVED')
    const c = await one<{ integration_id: string; credential_id: string; operator_label: string }>(s.db,
      `select integration_id, credential_id, operator_label from public.consumptions`)
    expect(c).toEqual({ integration_id: integrationId, credential_id: cred.id, operator_label: 'Effi ERP' })
    const b = await one<{ consumed_by_integration: string }>(s.db, `select consumed_by_integration from public.benefits where id = $1`, [s.benefits['2026-10-16']])
    expect(b.consumed_by_integration).toBe(integrationId)
    const a = await one<{ actor_type: string; integration_id: string }>(s.db,
      `select actor_type, integration_id from public.audit_logs where action = 'REDEEM_BENEFIT'`)
    expect(a).toEqual({ actor_type: 'integration', integration_id: integrationId })
  })

  it('scope insuficiente → INSUFFICIENT_SCOPE', async () => {
    const principal = (await begin(s, { auth: { type: 'credential', credential_id: cred.id } })).principal
    await expect(asService(s.db, `select public.api_statistics($1::jsonb, '{}'::jsonb)`, [JSON.stringify(principal)]))
      .rejects.toThrow(/INSUFFICIENT_SCOPE/)
    await expect(asService(s.db, `select public.api_upsert_attendee($1::jsonb, null, '{"nombres":"x"}'::jsonb, false)`, [JSON.stringify(principal)]))
      .rejects.toThrow(/INSUFFICIENT_SCOPE/)
  })

  it('rotar: la credencial nueva funciona y la anterior queda revocada', async () => {
    const next = await rpc<Cred>(s.db, s.admin.authId, 'rotate_api_credential', { p_credential_id: cred.id })
    expect(next.client_id).not.toBe(cred.client_id)
    expect((await begin(s, { auth: { type: 'client_secret', client_id: cred.client_id, client_secret: cred.client_secret } })).error).toBe('CREDENTIAL_REVOKED')
    expect((await begin(s, { auth: { type: 'client_secret', client_id: next.client_id, client_secret: next.client_secret } })).ok).toBe(true)
    // Un access token emitido antes (autenticado por credential_id) también deja de funcionar.
    expect((await begin(s, { auth: { type: 'credential', credential_id: cred.id } })).error).toBe('CREDENTIAL_REVOKED')

    await rpc(s.db, s.admin.authId, 'revoke_api_credential', { p_credential_id: next.id, p_reason: 'fin de prueba' })
    expect((await begin(s, { auth: { type: 'client_secret', client_id: next.client_id, client_secret: next.client_secret } })).error).toBe('CREDENTIAL_REVOKED')
    const acts = await s.db.query<{ action: string }>(`select action from public.audit_logs where action in ('CREATE_INTEGRATION','CREATE_API_KEY','ROTATE_API_KEY','REVOKE_API_KEY') order by id`)
    expect(acts.rows.map((x) => x.action)).toEqual(['CREATE_INTEGRATION', 'CREATE_API_KEY', 'ROTATE_API_KEY', 'REVOKE_API_KEY'])
  })

  it('desactivar la integración bloquea todas sus credenciales', async () => {
    const c2 = await rpc<Cred>(s.db, s.admin.authId, 'create_api_credential', { p_integration_id: integrationId, p_scopes: ['attendees:read'] })
    await rpc(s.db, s.admin.authId, 'update_integration', {
      p_id: integrationId, p_name: 'Effi ERP', p_description: null, p_allowed_scopes: ['attendees:read'], p_contact_email: null, p_active: false })
    expect((await begin(s, { auth: { type: 'credential', credential_id: c2.id } })).error).toBe('INTEGRATION_DISABLED')
  })

  it('principal de staff vía API usa sus permisos como scopes', async () => {
    const r = await begin(s, { auth: { type: 'user', auth_user_id: s.operator.authId } })
    expect(r.principal?.scopes.sort()).toEqual(['benefits:redeem', 'benefits:validate', 'event-days:read'])
    expect((await begin(s, { auth: { type: 'user', auth_user_id: s.attendeeAuth } })).error).toBe('USER_NOT_AUTHORIZED')
  })

  it('usuarios sin integrations:manage no ven integraciones ni credenciales', async () => {
    expect(await as(s.db, s.viewer.authId, `select * from public.api_integrations`)).toHaveLength(0)
    expect(await as(s.db, s.viewer.authId, `select id from public.api_credentials`)).toHaveLength(0)
    await expect(rpc(s.db, s.viewer.authId, 'create_integration', { p_name: 'x', p_description: null, p_allowed_scopes: [] })).rejects.toThrow(/FORBIDDEN/)
  })
})

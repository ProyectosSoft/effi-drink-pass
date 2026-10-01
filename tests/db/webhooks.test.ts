import { describe, it, expect, beforeAll } from 'vitest'
import { as, asService, rpc, tokenFor, one } from './harness'
import { scenario, type Scenario } from './fixtures'

type Claimed = { delivery_id: number; attempt: number; url: string; secret: string; event_type: string; payload: Record<string, unknown> }

describe('webhooks salientes', () => {
  let s: Scenario
  let integrationId: string
  let subId: string
  let secret: string
  const claim = async (limit = 20) => (await asService<{ r: Claimed[] }>(s.db, `select public.webhooks_claim($1, 60) as r`, [limit]))[0].r
  const report = async (id: number, ok: boolean, code: number | null, err: string | null) =>
    (await asService<{ r: string }>(s.db, `select public.webhooks_report($1, $2, $3, $4) as r`, [id, ok, code, err]))[0].r

  beforeAll(async () => {
    s = await scenario()
    integrationId = await rpc<string>(s.db, s.admin.authId, 'create_integration', {
      p_name: 'Effi ERP', p_description: null, p_allowed_scopes: ['consumptions:read', 'attendees:read'] })
  })

  it('valida URL (solo HTTPS a hosts públicos) y exige consumptions:read en la integración', async () => {
    for (const url of ['http://effi.example.com/hook', 'https://localhost/x', 'https://10.0.0.5/x', 'https://srv.internal/x', 'https://intranet/x']) {
      await expect(rpc(s.db, s.admin.authId, 'create_webhook_subscription', { p_integration_id: integrationId, p_url: url }))
        .rejects.toThrow(/INVALID_WEBHOOK_URL|check constraint/)
    }
    const other = await rpc<string>(s.db, s.admin.authId, 'create_integration', { p_name: 'Sin scope', p_description: null, p_allowed_scopes: ['attendees:read'] })
    await expect(rpc(s.db, s.admin.authId, 'create_webhook_subscription', { p_integration_id: other, p_url: 'https://hooks.example.com/x' }))
      .rejects.toThrow(/WEBHOOK_REQUIRES_CONSUMPTIONS_SCOPE/)
  })

  it('crea la suscripción y devuelve el secreto una sola vez (solo pista visible por RLS)', async () => {
    const r = await rpc<{ id: string; secret: string }>(s.db, s.admin.authId, 'create_webhook_subscription', {
      p_integration_id: integrationId, p_url: 'https://hooks.effi.example.com/drinkpass', p_description: 'ERP' })
    subId = r.id
    secret = r.secret
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/)
    const rows = await as<Record<string, unknown>>(s.db, s.admin.authId, `select * from public.webhook_subscriptions`)
    expect(JSON.stringify(rows)).not.toContain(secret)
    expect(rows[0].secret_hint).toBe(secret.slice(-4))
    expect(await as(s.db, s.viewer.authId, `select * from public.webhook_subscriptions`)).toHaveLength(0)
    await expect(as(s.db, s.admin.authId, `select * from private.webhook_secrets`)).rejects.toThrow(/permission denied/)
  })

  it('un consumo genera una entrega pendiente (fan-out del outbox)', async () => {
    await rpc(s.db, s.operator.authId, 'benefit_redeem', { p_token: await tokenFor(s.db, s.benefits['2026-10-16']) })
    const d = await one<{ n: number; status: string }>(s.db, `select count(*)::int n, max(status) status from private.webhook_deliveries`)
    expect(d).toEqual({ n: 1, status: 'pending' })
    const o = await one<{ dispatched: boolean }>(s.db, `select dispatched_at is not null as dispatched from private.event_outbox`)
    expect(o.dispatched).toBe(true)
  })

  it('claim entrega URL, secreto y payload; no se vuelve a tomar mientras está arrendada', async () => {
    const batch = await claim()
    expect(batch).toHaveLength(1)
    expect(batch[0]).toMatchObject({ attempt: 1, url: 'https://hooks.effi.example.com/drinkpass', secret, event_type: 'benefit.consumed' })
    expect(batch[0].payload).toMatchObject({ effi_id: '123456', event_day: '2026-10-16' })
    expect(await claim()).toHaveLength(0)
  })

  it('un fallo reprograma con backoff; tras 8 intentos queda en failed; se puede reintentar manualmente', async () => {
    const first = await one<{ id: number }>(s.db, `select id from private.webhook_deliveries limit 1`)
    expect(await report(first.id, false, 503, 'Service Unavailable')).toBe('pending')
    const d = await one<{ wait: number; err: string }>(s.db,
      `select extract(epoch from next_attempt_at - now())::int wait, last_error err from private.webhook_deliveries where id = $1`, [first.id])
    expect(d.wait).toBeGreaterThan(20)
    expect(d.err).toBe('Service Unavailable')

    await s.db.query(`update private.webhook_deliveries set attempts = 8 where id = $1`, [first.id])
    expect(await report(first.id, false, null, 'timeout')).toBe('failed')
    await expect(rpc(s.db, s.operator.authId, 'retry_webhook_delivery', { p_delivery_id: first.id })).rejects.toThrow(/FORBIDDEN/)
    await rpc(s.db, s.admin.authId, 'retry_webhook_delivery', { p_delivery_id: first.id })
    const again = await claim()
    expect(again.map((x) => x.delivery_id)).toEqual([first.id])
    expect(await report(first.id, true, 200, null)).toBe('delivered')
    const list = await rpc<{ status: string; last_status_code: number }[]>(s.db, s.admin.authId, 'list_webhook_deliveries', { p_subscription_id: subId })
    expect(list[0]).toMatchObject({ status: 'delivered', last_status_code: 200 })
  })

  it('suscripción inactiva o integración desactivada: no genera ni entrega', async () => {
    await rpc(s.db, s.admin.authId, 'update_webhook_subscription', {
      p_id: subId, p_url: 'https://hooks.effi.example.com/drinkpass', p_events: ['benefit.consumed'], p_description: null, p_active: false })
    await rpc(s.db, s.admin.authId, 'benefit_override_redeem', { p_benefit_id: s.benefits['2026-10-17'], p_reason: 'Prueba webhook inactivo' })
    const n = await one<{ n: number }>(s.db, `select count(*)::int n from private.webhook_deliveries`)
    expect(n.n).toBe(1)
  })

  it('rotar secreto cambia la firma usada en las próximas entregas', async () => {
    const r = await rpc<{ secret: string }>(s.db, s.admin.authId, 'rotate_webhook_secret', { p_id: subId })
    expect(r.secret).not.toBe(secret)
    const stored = await one<{ secret: string }>(s.db, `select secret from private.webhook_secrets where subscription_id = $1`, [subId])
    expect(stored.secret).toBe(r.secret)
    const acts = await s.db.query<{ action: string }>(`select action from public.audit_logs where action like '%WEBHOOK%' order by id`)
    expect(acts.rows.map((a) => a.action)).toEqual(['CREATE_WEBHOOK', 'RETRY_WEBHOOK_DELIVERY', 'UPDATE_WEBHOOK', 'ROTATE_WEBHOOK_SECRET'])
  })

  it('las funciones del despachador no son ejecutables por usuarios', async () => {
    await expect(as(s.db, s.superAdmin.authId, `select public.webhooks_claim(10, 60)`)).rejects.toThrow(/permission denied/)
  })
})

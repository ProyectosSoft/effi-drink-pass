import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { scenario, type Scenario } from './fixtures'
import { as, one, rpc } from './harness'

describe('historial unificado de consumos', () => {
  let s: Scenario
  beforeAll(async () => {
    s = await scenario()
    const company = await rpc<string>(s.db, s.admin.authId, 'upsert_drink_company', {
      p_data: { effi_id: '1077', name: 'Empresa historial', user_count: 5 }, p_event_day_ids: Object.values(s.days),
    })
    const pass = await one<{ id: string }>(s.db, 'select id from public.company_drink_days where company_id = $1 and event_day_id = $2', [company, s.days['2026-10-15']])
    await rpc(s.db, s.superAdmin.authId, 'record_manual_company_delivery', {
      p_company_day_id: pass.id, p_quantity: 2, p_reason: 'Entrega manual del día anterior', p_idempotency_key: 'history-manual-001',
    })
    const token = await rpc<{ token: string }>(s.db, s.attendeeAuth, 'get_my_benefit_token', { p_benefit_id: s.benefits['2026-10-16'] })
    await rpc(s.db, s.operator.authId, 'drink_pass_redeem', { p_token: token.token, p_quantity: 1, p_idempotency_key: 'history-personal-001' })
  })
  afterAll(async () => { await s?.db.close() })

  it('incluye empresas y pases individuales sin duplicar ni sumar registros', async () => {
    const rows = await as(s.db, s.admin.authId, 'select source, quantity from public.consumption_history order by source')
    expect(rows).toEqual([{ source: 'company', quantity: 2 }, { source: 'individual', quantity: 1 }])
  })

  it('filtra ID y día efectivo aunque el registro manual se cargó después', async () => {
    const rows = await as(s.db, s.admin.authId, "select source, event_date::text, channel, quantity, (recorded_at at time zone 'America/Bogota')::date::text as registered_date from public.consumption_history where effi_id = '1077' and event_date >= '2026-10-15' and event_date <= '2026-10-15'")
    expect(rows).toEqual([{ source: 'company', event_date: '2026-10-15', channel: 'Manual', quantity: 2, registered_date: '2026-10-16' }])
  })

  it('conserva RLS: viewer consulta, operador y asistente no acceden al historial administrativo', async () => {
    expect(await as(s.db, s.viewer.authId, 'select id from public.consumption_history')).toHaveLength(2)
    expect(await as(s.db, s.operator.authId, 'select id from public.consumption_history')).toHaveLength(0)
    expect(await as(s.db, s.attendeeAuth, 'select id from public.consumption_history')).toHaveLength(0)
    await expect(as(s.db, null, 'select id from public.consumption_history')).rejects.toThrow()
  })
})

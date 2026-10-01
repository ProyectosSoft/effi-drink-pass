import { describe, it, expect, beforeAll } from 'vitest'
import { asService, rpc, tokenFor } from './harness'
import { scenario, type Scenario } from './fixtures'

const ALL_READ = ['attendees:read', 'event-days:read', 'benefits:read', 'consumptions:read', 'statistics:read']

describe('lecturas API v1 (service_role)', () => {
  let s: Scenario
  const actor = JSON.stringify({ type: 'integration', label: 'Test', scopes: ALL_READ })
  const call = async <T>(sql: string, params: unknown[] = []) =>
    (await asService<{ r: T }>(s.db, sql, params))[0].r

  beforeAll(async () => {
    s = await scenario()
    for (let i = 0; i < 5; i++) {
      await s.db.query(`insert into public.attendees (nombres, apellidos, effi_id, empresa) values ($1, 'Zeta', $2, 'Globex')`, [`N${i}`, `Z-${i}`])
    }
    await rpc(s.db, s.operator.authId, 'benefit_redeem', { p_token: await tokenFor(s.db, s.benefits['2026-10-16']) })
  })

  it('consulta de asistente por effi_id (sincronización futura con Effi)', async () => {
    const r = await call<{ data: { id: string; effi_username: string; has_account: boolean }[]; meta: { total: number } }>(
      `select public.api_list_attendees($1::jsonb, '{"effi_id":"123456"}'::jsonb, 1, 50) as r`, [actor])
    expect(r.meta.total).toBe(1)
    expect(r.data[0]).toMatchObject({ id: s.attendeeId, effi_username: 'juan.perez', has_account: true })
    expect(JSON.stringify(r)).not.toMatch(/auth_user_id|token/)
  })

  it('paginación y búsqueda', async () => {
    const p1 = await call<{ data: unknown[]; meta: { total: number; total_pages: number } }>(
      `select public.api_list_attendees($1::jsonb, '{"empresa":"globex"}'::jsonb, 1, 2) as r`, [actor])
    expect(p1.meta).toMatchObject({ total: 5, total_pages: 3 })
    expect(p1.data).toHaveLength(2)
    const p3 = await call<{ data: unknown[] }>(`select public.api_list_attendees($1::jsonb, '{"empresa":"globex"}'::jsonb, 3, 2) as r`, [actor])
    expect(p3.data).toHaveLength(1)
    const q = await call<{ meta: { total: number } }>(`select public.api_list_attendees($1::jsonb, '{"q":"juan pé"}'::jsonb, 1, 50) as r`, [actor])
    expect(q.meta.total).toBe(1)
    const big = await call<{ meta: { page_size: number } }>(`select public.api_list_attendees($1::jsonb, '{}'::jsonb, 1, 5000) as r`, [actor])
    expect(big.meta.page_size).toBe(200)
  })

  it('detalle de asistente incluye días de elegibilidad', async () => {
    const r = await call<{ data: { event_days: { date: string; eligible: boolean }[] } }>(
      `select public.api_get_attendee($1::jsonb, $2) as r`, [actor, s.attendeeId])
    expect(r.data.event_days.map((d) => d.date)).toEqual(['2026-10-15', '2026-10-16', '2026-10-17'])
  })

  it('beneficios del asistente con estado efectivo y sin token', async () => {
    const r = await call<{ data: { effective_status: string; event_day: { date: string } }[] }>(
      `select public.api_attendee_benefits($1::jsonb, $2) as r`, [actor, s.attendeeId])
    expect(r.data.map((b) => [b.event_day.date, b.effective_status])).toEqual([
      ['2026-10-15', 'EXPIRED'], ['2026-10-16', 'CONSUMED'], ['2026-10-17', 'PENDING']])
    expect(JSON.stringify(r)).not.toMatch(/token/)
  })

  it('detalle de beneficio consumido incluye el consumo', async () => {
    const r = await call<{ data: { status: string; consumption: { operator: { type: string; label: string } } } }>(
      `select public.api_get_benefit($1::jsonb, $2) as r`, [actor, s.benefits['2026-10-16']])
    expect(r.data.status).toBe('CONSUMED')
    expect(r.data.consumption.operator.type).toBe('staff')
  })

  it('listado de beneficios filtrado por estado y de consumos por effi_id', async () => {
    const b = await call<{ meta: { total: number } }>(`select public.api_list_benefits($1::jsonb, '{"status":"pending"}'::jsonb, 1, 50) as r`, [actor])
    expect(b.meta.total).toBe(1)
    const c = await call<{ data: { id: string }[]; meta: { total: number } }>(
      `select public.api_list_consumptions($1::jsonb, '{"effi_id":"123456"}'::jsonb, 1, 50) as r`, [actor])
    expect(c.meta.total).toBe(1)
    const one = await call<{ data: { benefit_id: string } }>(`select public.api_get_consumption($1::jsonb, $2) as r`, [actor, c.data[0].id])
    expect(one.data.benefit_id).toBe(s.benefits['2026-10-16'])
  })

  it('días del evento marcan is_today según la hora del servidor', async () => {
    const r = await call<{ data: { date: string; is_today: boolean }[] }>(`select public.api_list_event_days($1::jsonb) as r`, [actor])
    expect(r.data.filter((d) => d.is_today).map((d) => d.date)).toEqual(['2026-10-16'])
  })

  it('404 para ids inexistentes y 403 sin scope', async () => {
    await expect(call(`select public.api_get_attendee($1::jsonb, gen_random_uuid()) as r`, [actor])).rejects.toThrow(/NOT_FOUND/)
    const noScope = JSON.stringify({ type: 'integration', scopes: ['event-days:read'] })
    await expect(call(`select public.api_list_consumptions($1::jsonb, '{}'::jsonb, 1, 10) as r`, [noScope])).rejects.toThrow(/INSUFFICIENT_SCOPE/)
  })
})

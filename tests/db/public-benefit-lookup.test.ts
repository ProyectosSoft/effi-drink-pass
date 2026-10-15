import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scenario, type Scenario } from './fixtures'
import { as, one, rpc, setNow, tokenFor } from './harness'

type Lookup = { available: boolean; code: string; token?: string; retry_after?: number; event_day?: { date: string } }

describe('consulta pública por correo o ID Effi', () => {
  let s: Scenario
  beforeEach(async () => { s = await scenario() })
  afterEach(async () => { await s?.db.close() })

  const lookup = (kind = 'email', identifier = 'juan.perez@test.local') =>
    rpc<Lookup>(s.db, null, 'lookup_drink_benefit', { p_kind: kind, p_identifier: identifier })

  it('un visitante obtiene el token existente de hoy por correo normalizado, sin consumir', async () => {
    const result = await lookup('email', '  JUAN.PEREZ@test.local  ')
    expect(result.available).toBe(true)
    expect(result.event_day?.date).toBe('2026-10-16')
    expect(result.token).toBe(await tokenFor(s.db, s.benefits['2026-10-16']))
    expect(await one(s.db, `select count(*)::int n from public.consumptions`)).toEqual({ n: 0 })
    expect(await one(s.db, `select status from public.benefits where id = $1`, [s.benefits['2026-10-16']])).toEqual({ status: 'PENDING' })
    expect(Object.keys(result).sort()).toEqual(['available', 'code', 'event_day', 'server_time', 'token'])
    await expect(as(s.db, null, 'select id from public.attendees')).rejects.toThrow('permission denied')
  })

  it('acepta el ID Effi exacto, incluyendo espacios exteriores', async () => {
    expect((await lookup('effi_id', ' 123456 ')).token).toBe(await tokenFor(s.db, s.benefits['2026-10-16']))
    expect((await lookup('effi_id', 'juan.perez')).available).toBe(false)
  })

  it('no revela perfiles ni tokens para identificadores inexistentes o tipos inválidos', async () => {
    for (const [kind, value] of [['email', 'otro@test.local'], ['effi_id', '123'], ['email', ''], ['effi_id', 'x'.repeat(65)], ['unknown', '123456']]) {
      expect(await lookup(kind, value)).toEqual({ available: false, code: 'NOT_AVAILABLE' })
    }
  })

  it('no entrega el token de ayer ni el de mañana cuando hoy no tiene beneficio', async () => {
    await s.db.query(`delete from public.attendee_event_days where attendee_id = $1 and event_day_id = $2`, [s.attendeeId, s.days['2026-10-16']])
    const result = await lookup()
    expect(result.available).toBe(false)
    expect(result.token).toBeUndefined()
  })

  it('consulta reiterada conserva el mismo QR; tras el canje ya no lo entrega', async () => {
    const result = await lookup()
    expect((await lookup()).token).toBe(result.token)
    await rpc(s.db, s.operator.authId, 'benefit_redeem', { p_token: result.token, p_idempotency_key: 'public-lookup-test' })
    expect(await lookup()).toEqual({ available: false, code: 'ALREADY_CONSUMED' })
    const second = await rpc<{ code: string }>(s.db, s.operator2.authId, 'benefit_redeem', { p_token: result.token, p_idempotency_key: 'public-lookup-second' })
    expect(second.code).toBe('ALREADY_CONSUMED')
    expect(await one(s.db, 'select count(*)::int n from public.consumptions')).toEqual({ n: 1 })
  })

  it('reutiliza los rechazos por inicio y cierre de horario', async () => {
    await setNow(s.db, '2026-10-16T12:00:00Z')
    expect(await lookup()).toEqual({ available: false, code: 'NOT_STARTED' })
    await setNow(s.db, '2026-10-17T01:00:00Z')
    expect(await lookup()).toEqual({ available: false, code: 'EXPIRED' })
  })

  it('no entrega QR a un asistente inactivo o no elegible', async () => {
    await s.db.query('update public.attendees set activo = false where id = $1', [s.attendeeId])
    expect(await lookup()).toEqual({ available: false, code: 'ATTENDEE_INACTIVE' })
    await s.db.query('update public.attendees set activo = true where id = $1', [s.attendeeId])
    await s.db.query('update public.attendee_event_days set eligible = false where attendee_id = $1', [s.attendeeId])
    expect(await lookup()).toEqual({ available: false, code: 'NOT_ELIGIBLE' })
  })

  it('no entrega QR cancelados ni de un día deshabilitado', async () => {
    await s.db.query('update public.event_days set active = false where id = $1', [s.days['2026-10-16']])
    expect(await lookup()).toEqual({ available: false, code: 'DAY_INACTIVE' })
    await s.db.query('update public.event_days set active = true where id = $1', [s.days['2026-10-16']])
    await rpc(s.db, s.admin.authId, 'cancel_benefit', { p_benefit_id: s.benefits['2026-10-16'], p_reason: 'Prueba de consulta pública' })
    expect(await lookup()).toEqual({ available: false, code: 'CANCELLED' })
  })

  it('limita consultas por IP sin habilitar el canje anónimo', async () => {
    const bucket = 'public-benefit:unknown'
    await s.db.query(`select private.rate_limit_hit($1, 1, 60) from generate_series(1, 60)`, [bucket])
    const result = await lookup()
    expect(result.code).toBe('RATE_LIMITED')
    expect(result.token).toBeUndefined()
    expect(result.retry_after).toBeGreaterThan(0)
    await expect(rpc(s.db, null, 'benefit_redeem', { p_benefit_id: s.benefits['2026-10-16'] })).rejects.toThrow()
  })
})

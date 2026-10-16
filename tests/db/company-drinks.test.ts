import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { scenario, type Scenario } from './fixtures'
import { as, one, rpc, setNow } from './harness'

type Result = { code: string; available?: boolean; token?: string; quantity?: number; idempotent_replay?: boolean; company: { quota: number; delivered: number; remaining: number } }
describe('cupos de bebidas por empresa y día', () => {
  let s: Scenario
  let companyId: string
  let token: string
  beforeEach(async () => {
    s = await scenario()
    companyId = await rpc<string>(s.db, s.admin.authId, 'upsert_drink_company', {
      p_data: { effi_id: 'EMP-001', name: 'Empresa prueba', email: 'empresa@test.local', user_count: 5 },
      p_event_day_ids: Object.values(s.days),
    })
    token = (await lookup()).token!
  })
  afterEach(async () => { await s?.db.close() })
  const lookup = (kind = 'effi_id', identifier = 'EMP-001') => rpc<Result>(s.db, null, 'lookup_company_drink_pass', { p_kind: kind, p_identifier: identifier })
  const deliver = (quantity: number, key = 'company-delivery-001', actor?: string) => rpc<Result>(s.db, actor ?? s.operator.authId, 'drink_pass_redeem', { p_token: token, p_quantity: quantity, p_idempotency_key: key })
  const save = (count: number | string | undefined, days?: string[]) => rpc(s.db, s.admin.authId, 'upsert_drink_company', {
    p_data: { effi_id: 'EMP-001', name: 'Empresa prueba', user_count: count }, p_event_day_ids: days ?? null,
  })

  it('correo e ID de empresa entregan el mismo pase diario sin exponer el contacto ni consumir', async () => {
    const byEmail = await lookup('email', ' EMPRESA@test.local ')
    expect(byEmail.token).toBe(token)
    expect(byEmail.company).toMatchObject({ quota: 5, delivered: 0, remaining: 5 })
    expect(byEmail).not.toHaveProperty('email')
    expect(await one(s.db, 'select count(*)::int n from public.company_drink_deliveries')).toEqual({ n: 0 })
    expect((await lookup('effi_id', 'EMP-otro')).available).toBe(false)
  })

  it('cantidad vacía u omitida da exactamente 1 por defecto', async () => {
    await save('')
    expect((await lookup()).company.quota).toBe(1)
    await save(undefined)
    expect((await lookup()).company.quota).toBe(1)
  })

  it('entregas parciales 2 + 3 agotan el cupo; el QR es el mismo mientras hay saldo', async () => {
    expect(await deliver(2)).toMatchObject({ code: 'APPROVED', quantity: 2, company: { quota: 5, delivered: 2, remaining: 3 } })
    expect((await lookup()).token).toBe(token)
    expect(await deliver(3, 'company-delivery-002')).toMatchObject({ code: 'APPROVED', company: { delivered: 5, remaining: 0 } })
    expect(await lookup()).toMatchObject({ available: false, code: 'QUOTA_EXHAUSTED' })
    expect(await deliver(1, 'company-delivery-003')).toMatchObject({ code: 'QUOTA_EXHAUSTED' })
    expect(await one(s.db, 'select sum(quantity)::int n from public.company_drink_deliveries')).toEqual({ n: 5 })
  })

  it('no acepta cantidades que superen el saldo ni modifica el contador al rechazarlas', async () => {
    expect((await deliver(6)).code).toBe('INSUFFICIENT_QUOTA')
    expect((await lookup()).company.delivered).toBe(0)
    await deliver(4, 'company-delivery-004')
    expect((await deliver(2, 'company-delivery-005')).code).toBe('INSUFFICIENT_QUOTA')
    expect((await lookup()).company.remaining).toBe(1)
  })

  it('dos operadores con la misma lectura de saldo no pueden entregar más que el cupo', async () => {
    expect((await rpc<Result>(s.db, s.operator.authId, 'drink_pass_validate', { p_token: token })).company.remaining).toBe(5)
    expect((await rpc<Result>(s.db, s.operator2.authId, 'drink_pass_validate', { p_token: token })).company.remaining).toBe(5)
    expect((await deliver(4, 'operator-one-0001')).code).toBe('APPROVED')
    expect((await deliver(4, 'operator-two-0001', s.operator2.authId)).code).toBe('INSUFFICIENT_QUOTA')
    expect((await lookup()).company.remaining).toBe(1)
  })

  it('reintento con misma clave no descuenta dos veces; cambiar cantidad con la misma clave se rechaza', async () => {
    await deliver(2)
    expect(await deliver(2)).toMatchObject({ code: 'APPROVED', idempotent_replay: true, quantity: 2 })
    expect((await deliver(3)).code).toBe('IDEMPOTENCY_KEY_REUSED')
    expect((await lookup()).company.delivered).toBe(2)
    expect(await one(s.db, 'select count(*)::int n from public.company_drink_deliveries')).toEqual({ n: 1 })
  })

  it('la misma clave en otro operador constituye otra entrega, sujeta al saldo', async () => {
    await deliver(2)
    expect((await deliver(2, 'company-delivery-001', s.operator2.authId)).code).toBe('APPROVED')
    expect((await lookup()).company.delivered).toBe(4)
  })

  it('rechaza cero, negativos, cantidades fraccionarias y falta de clave', async () => {
    for (const qty of [0, -1, 100001, 1.5]) await expect(deliver(qty)).rejects.toThrow()
    await expect(deliver(1, '')).rejects.toThrow()
    expect((await lookup()).company.remaining).toBe(5)
  })

  it('el siguiente día tiene su propio cupo completo; no acumula saldo ni acepta el QR de ayer', async () => {
    await deliver(2)
    await setNow(s.db, '2026-10-17T15:00:00Z')
    const tomorrow = await lookup()
    expect(tomorrow.company).toMatchObject({ quota: 5, delivered: 0, remaining: 5 })
    expect(tomorrow.token).not.toBe(token)
    expect((await deliver(1, 'company-old-day-001')).code).toBe('EXPIRED')
  })

  it('respeta horario, empresa inactiva, día deshabilitado y elegibilidad', async () => {
    await setNow(s.db, '2026-10-16T12:00:00Z')
    expect((await lookup()).code).toBe('NOT_STARTED')
    await setNow(s.db, '2026-10-17T01:00:00Z')
    expect((await lookup()).code).toBe('EXPIRED')
    await setNow(s.db, '2026-10-16T15:00:00Z')
    await s.db.query('update public.drink_companies set active = false where id = $1', [companyId])
    expect((await lookup()).code).toBe('COMPANY_INACTIVE')
    await s.db.query('update public.drink_companies set active = true where id = $1', [companyId])
    await s.db.query('update public.event_days set active = false where id = $1', [s.days['2026-10-16']])
    expect((await lookup()).code).toBe('DAY_INACTIVE')
    await s.db.query('update public.event_days set active = true where id = $1', [s.days['2026-10-16']])
    await save(5, [])
    expect((await lookup()).code).toBe('NOT_ELIGIBLE')
  })

  it('no permite reducir el cupo por debajo de lo entregado ni reinicia el contador al editar', async () => {
    await deliver(3)
    await expect(save(2)).rejects.toThrow('QUOTA_BELOW_DELIVERED')
    await save(7)
    expect((await lookup()).company).toMatchObject({ quota: 7, delivered: 3, remaining: 4 })
  })

  it('anon y viewer no entregan; operador no administra empresas ni importa', async () => {
    await expect(rpc(s.db, null, 'drink_pass_redeem', { p_token: token, p_quantity: 1, p_idempotency_key: 'anonymous-0001' })).rejects.toThrow()
    await expect(deliver(1, 'viewer-00001', s.viewer.authId)).rejects.toThrow('FORBIDDEN')
    await expect(rpc(s.db, s.operator.authId, 'upsert_drink_company', { p_data: { effi_id: 'X', name: 'No' } })).rejects.toThrow('FORBIDDEN')
    await expect(as(s.db, s.operator.authId, 'select * from public.drink_companies')).resolves.toEqual([])
    await expect(as(s.db, s.admin.authId, 'select token_hash from public.company_drink_days')).rejects.toThrow('permission denied')
    await expect(as(s.db, s.admin.authId, 'update public.company_drink_days set delivered = 0')).rejects.toThrow('permission denied')
  })

  it('cada entrega conserva cantidad, operador, hora y auditoría inmutables', async () => {
    await deliver(2)
    expect(await rpc(s.db, s.admin.authId, 'get_company_drink_statistics')).toMatchObject({ companies: 1, quota: 5, delivered: 2, remaining: 3 })
    expect(await one(s.db, 'select quantity, operator_id, delivered_at from public.company_drink_deliveries')).toMatchObject({ quantity: 2, operator_id: s.operator.profileId })
    expect(await one(s.db, `select count(*)::int n from public.audit_logs where action = 'COMPANY_DRINK_DELIVERY' and success`)).toEqual({ n: 1 })
    await expect(s.db.exec('delete from public.company_drink_deliveries')).rejects.toThrow()
    expect((await as(s.db, s.admin.authId, 'select * from public.company_drink_balances')).length).toBe(3)
    expect((await as(s.db, s.admin.authId, 'select quantity from public.company_drink_deliveries'))[0]).toEqual({ quantity: 2 })
  })

  it('importación simula sin guardar y aplica el cupo por defecto al confirmar', async () => {
    const args = { p_rows: [{ effi_id: 'NEW-1', name: 'Nueva', user_count: '' }], p_event_day_ids: [s.days['2026-10-16']], p_dry_run: true }
    await rpc(s.db, s.admin.authId, 'import_drink_companies', args)
    expect((await lookup('effi_id', 'NEW-1')).available).toBe(false)
    await rpc(s.db, s.admin.authId, 'import_drink_companies', { ...args, p_dry_run: false })
    expect((await lookup('effi_id', 'NEW-1')).company.quota).toBe(1)
  })

  it('un lote inválido es atómico y detecta ID o correos duplicados', async () => {
    const args = { p_event_day_ids: [s.days['2026-10-16']], p_dry_run: false }
    await expect(rpc(s.db, s.admin.authId, 'import_drink_companies', { ...args, p_rows: [{ effi_id: 'NEW-2', name: 'Nueva' }, { effi_id: 'INVALID', name: '' }] })).rejects.toThrow()
    expect((await lookup('effi_id', 'NEW-2')).available).toBe(false)
    await expect(rpc(s.db, s.admin.authId, 'import_drink_companies', { ...args, p_rows: [{ effi_id: 'DUP', name: 'Uno' }, { effi_id: 'DUP', name: 'Dos' }] })).rejects.toThrow('DUPLICATE_COMPANY_ID')
    await expect(rpc(s.db, s.admin.authId, 'import_drink_companies', { ...args, p_rows: [{ effi_id: 'E1', name: 'Uno', email: 'same@test.local' }, { effi_id: 'E2', name: 'Dos', email: 'SAME@test.local' }] })).rejects.toThrow('COMPANY_EMAIL_CONFLICT')
  })

  it('los pases individuales existentes mantienen el máximo de una bebida', async () => {
    const personal = await rpc<{ token: string }>(s.db, s.attendeeAuth, 'get_my_benefit_token', { p_benefit_id: s.benefits['2026-10-16'] })
    token = personal.token
    await expect(deliver(2)).rejects.toThrow('INDIVIDUAL_QUANTITY_ONE')
    expect((await deliver(1)).code).toBe('APPROVED')
    expect((await deliver(1, 'individual-second')).code).toBe('ALREADY_CONSUMED')
  })
})

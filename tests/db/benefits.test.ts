import { describe, it, expect, beforeAll } from 'vitest'
import { rpc, tokenFor, setNow, one, as } from './harness'
import { scenario, type Scenario } from './fixtures'

type Result = {
  ok: boolean
  code: string
  message: string
  idempotent_replay?: boolean
  benefit: { id: string; status: string } | null
  attendee: { nombres: string; effi_id: string } | null
  consumption: { operator: string; consumed_at: string } | null
}

describe('beneficios: generación y tokens', () => {
  let s: Scenario
  beforeAll(async () => {
    s = await scenario()
  })

  it('genera un beneficio por día elegible automáticamente', async () => {
    expect(Object.keys(s.benefits).sort()).toEqual(['2026-10-15', '2026-10-16', '2026-10-17'])
  })

  it('cada beneficio tiene token distinto, de 43 caracteres base64url, y solo se guarda su hash', async () => {
    const tokens = await Promise.all(Object.values(s.benefits).map((id) => tokenFor(s.db, id)))
    expect(new Set(tokens).size).toBe(3)
    for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const r = await s.db.query<{ token_hash: string }>(`select token_hash from public.benefits`)
    for (const row of r.rows) {
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/)
      expect(tokens).not.toContain(row.token_hash)
    }
    // El token no aparece en ninguna columna de ninguna tabla pública.
    const dump = await s.db.query<{ j: string }>(
      `select (select json_agg(b)::text from public.benefits b) || (select coalesce(json_agg(a)::text,'') from public.audit_logs a) as j`)
    for (const t of tokens) expect(dump.rows[0].j).not.toContain(t)
  })

  it('el expiration_at es el fin del día en hora de Bogotá', async () => {
    const r = await one<{ e: string }>(s.db, `select expiration_at::text e from public.benefits where id = $1`, [s.benefits['2026-10-16']])
    expect(new Date(r.e).toISOString()).toBe('2026-10-17T01:00:00.000Z') // 20:00 COT = 01:00Z
  })

  it('el asistente obtiene su token; otro usuario no', async () => {
    const mine = await rpc<{ available: boolean; token: string }>(s.db, s.attendeeAuth, 'get_my_benefit_token', { p_benefit_id: s.benefits['2026-10-16'] })
    expect(mine.available).toBe(true)
    expect(mine.token).toBe(await tokenFor(s.db, s.benefits['2026-10-16']))
    await expect(rpc(s.db, s.operator.authId, 'get_my_benefit_token', { p_benefit_id: s.benefits['2026-10-16'] })).rejects.toThrow(/NOT_FOUND/)
  })

  it('el portal muestra estados por día (ayer expirado, hoy disponible, mañana próximo)', async () => {
    const r = await rpc<{ attendee: { effi_id: string }; benefits: { event_day: { date: string }; display_status: string }[] }>(
      s.db, s.attendeeAuth, 'get_my_benefits')
    expect(r.attendee.effi_id).toBe('123456')
    expect(r.benefits.map((b) => [b.event_day.date, b.display_status])).toEqual([
      ['2026-10-15', 'EXPIRED'], ['2026-10-16', 'AVAILABLE'], ['2026-10-17', 'UPCOMING'],
    ])
  })
})

describe('beneficios: validación y consumo', () => {
  let s: Scenario
  beforeAll(async () => {
    s = await scenario()
  })

  it('operador valida sin consumir', async () => {
    const token = await tokenFor(s.db, s.benefits['2026-10-16'])
    const r = await rpc<Result>(s.db, s.operator.authId, 'benefit_validate', { p_token: token })
    expect(r.code).toBe('VALID')
    expect(r.attendee?.effi_id).toBe('123456')
    const b = await one<{ status: string }>(s.db, `select status from public.benefits where id = $1`, [s.benefits['2026-10-16']])
    expect(b.status).toBe('PENDING')
  })

  it('operador consume: CONSUMED, registro de consumo, auditoría y evento outbox', async () => {
    const token = await tokenFor(s.db, s.benefits['2026-10-16'])
    const r = await rpc<Result>(s.db, s.operator.authId, 'benefit_redeem', { p_token: token })
    expect(r.ok).toBe(true)
    expect(r.code).toBe('APPROVED')
    expect(r.message).toBe('BENEFICIO APROBADO')
    expect(r.consumption?.operator).toContain('op1')

    const b = await one<{ status: string; consumed_by: string }>(s.db, `select status, consumed_by from public.benefits where id = $1`, [s.benefits['2026-10-16']])
    expect(b).toEqual({ status: 'CONSUMED', consumed_by: s.operator.profileId })
    const c = await one<{ n: number; op: string }>(s.db, `select count(*)::int n, max(operator_id::text) op from public.consumptions where benefit_id = $1`, [s.benefits['2026-10-16']])
    expect(c).toEqual({ n: 1, op: s.operator.profileId })
    const a = await one<{ n: number }>(s.db, `select count(*)::int n from public.audit_logs where action = 'REDEEM_BENEFIT' and resource_id = $1`, [s.benefits['2026-10-16']])
    expect(a.n).toBe(1)
    const o = await one<{ n: number }>(s.db, `select count(*)::int n from private.event_outbox where event_type = 'benefit.consumed'`)
    expect(o.n).toBe(1)
  })

  it('segundo consumo (otro operador) → BENEFICIO YA CONSUMIDO, sin nuevo registro', async () => {
    const token = await tokenFor(s.db, s.benefits['2026-10-16'])
    const r = await rpc<Result>(s.db, s.operator2.authId, 'benefit_redeem', { p_token: token })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('ALREADY_CONSUMED')
    expect(r.message).toBe('BENEFICIO YA CONSUMIDO')
    expect(r.consumption?.operator).toContain('op1')
    const c = await one<{ n: number }>(s.db, `select count(*)::int n from public.consumptions`)
    expect(c.n).toBe(1)
    const f = await one<{ n: number }>(s.db, `select count(*)::int n from public.audit_logs where action = 'FAILED_REDEEM'`)
    expect(f.n).toBe(1)
  })

  it('beneficio de mañana → QR NO VÁLIDO PARA HOY', async () => {
    const r = await rpc<Result>(s.db, s.operator.authId, 'benefit_redeem', { p_token: await tokenFor(s.db, s.benefits['2026-10-17']) })
    expect(r.code).toBe('NOT_TODAY')
    expect(r.message).toBe('QR NO VÁLIDO PARA HOY')
  })

  it('beneficio de ayer → BENEFICIO EXPIRADO (y se persiste EXPIRED)', async () => {
    const r = await rpc<Result>(s.db, s.operator.authId, 'benefit_redeem', { p_token: await tokenFor(s.db, s.benefits['2026-10-15']) })
    expect(r.code).toBe('EXPIRED')
    const b = await one<{ status: string }>(s.db, `select status from public.benefits where id = $1`, [s.benefits['2026-10-15']])
    expect(b.status).toBe('EXPIRED')
  })

  it('token inexistente o malformado → QR INVÁLIDO sin revelar datos', async () => {
    for (const t of ['x'.repeat(43), 'abc', "' or 1=1 --", 'https://evil/qr/123']) {
      const r = await rpc<Result>(s.db, s.operator.authId, 'benefit_validate', { p_token: t })
      expect(r.code).toBe('INVALID_QR')
      expect(r.benefit).toBeNull()
      expect(r.attendee).toBeNull()
    }
  })

  it('antes de la hora de inicio → FUERA DE HORARIO; después del cierre → EXPIRADO', async () => {
    await setNow(s.db, '2026-10-17T12:30:00Z') // 07:30 COT
    let r = await rpc<Result>(s.db, s.operator.authId, 'benefit_validate', { p_token: await tokenFor(s.db, s.benefits['2026-10-17']) })
    expect(r.code).toBe('NOT_STARTED')
    await setNow(s.db, '2026-10-18T01:00:00Z') // 20:00 COT del 17
    r = await rpc<Result>(s.db, s.operator.authId, 'benefit_validate', { p_token: await tokenFor(s.db, s.benefits['2026-10-17']) })
    expect(r.code).toBe('EXPIRED')
    await setNow(s.db, '2026-10-16T15:00:00Z')
  })

  it('usuario no elegible y usuario inactivo', async () => {
    await s.db.query(`update public.attendee_event_days set eligible = false where attendee_id = $1 and event_day_id = $2`, [s.attendeeId, s.days['2026-10-17']])
    await setNow(s.db, '2026-10-17T15:00:00Z')
    let r = await rpc<Result>(s.db, s.operator.authId, 'benefit_validate', { p_token: await tokenFor(s.db, s.benefits['2026-10-17']) })
    expect(r.code).toBe('NOT_ELIGIBLE')
    await s.db.query(`update public.attendee_event_days set eligible = true where attendee_id = $1`, [s.attendeeId])
    await s.db.query(`update public.attendees set activo = false where id = $1`, [s.attendeeId])
    r = await rpc<Result>(s.db, s.operator.authId, 'benefit_validate', { p_token: await tokenFor(s.db, s.benefits['2026-10-17']) })
    expect(r.code).toBe('ATTENDEE_INACTIVE')
    await s.db.query(`update public.attendees set activo = true where id = $1`, [s.attendeeId])
    await setNow(s.db, '2026-10-16T15:00:00Z')
  })

  it('la hora del servidor manda: sin override de reloj habilitado se ignora app.now_override', async () => {
    await s.db.exec(`update private.config set value = 'false' where key = 'allow_clock_override'`)
    const t = await one<{ now: string }>(s.db, `select private.app_now()::text as now`)
    expect(Math.abs(new Date(t.now).getTime() - Date.now())).toBeLessThan(60_000)
    await s.db.exec(`update private.config set value = 'true' where key = 'allow_clock_override'`)
  })

  it('consumo excepcional: exige permiso override y motivo, queda auditado', async () => {
    await expect(rpc(s.db, s.operator.authId, 'benefit_override_redeem', { p_benefit_id: s.benefits['2026-10-17'], p_reason: 'Cliente VIP' }))
      .rejects.toThrow(/FORBIDDEN/)
    await expect(rpc(s.db, s.admin.authId, 'benefit_override_redeem', { p_benefit_id: s.benefits['2026-10-17'], p_reason: '' }))
      .rejects.toThrow(/REASON_REQUIRED/)
    const r = await rpc<Result>(s.db, s.admin.authId, 'benefit_override_redeem', { p_benefit_id: s.benefits['2026-10-17'], p_reason: 'Autorizado por gerencia' })
    expect(r.code).toBe('APPROVED')
    const c = await one<{ is_override: boolean; override_reason: string }>(s.db, `select is_override, override_reason from public.consumptions where benefit_id = $1`, [s.benefits['2026-10-17']])
    expect(c).toEqual({ is_override: true, override_reason: 'Autorizado por gerencia' })
    const a = await one<{ n: number }>(s.db, `select count(*)::int n from public.audit_logs where action = 'OVERRIDE_REDEEM'`)
    expect(a.n).toBe(1)
  })

  it('viewer y asistente no pueden validar ni consumir', async () => {
    const token = 'A'.repeat(43)
    await expect(rpc(s.db, s.viewer.authId, 'benefit_redeem', { p_token: token })).rejects.toThrow(/FORBIDDEN/)
    await expect(rpc(s.db, s.attendeeAuth, 'benefit_validate', { p_token: token })).rejects.toThrow(/FORBIDDEN/)
    await expect(rpc(s.db, null, 'benefit_redeem', { p_token: token })).rejects.toThrow(/permission denied/)
  })
})

describe('integridad: doble consumo imposible a nivel de base de datos', () => {
  let s: Scenario
  beforeAll(async () => {
    s = await scenario()
    await rpc(s.db, s.operator.authId, 'benefit_redeem', { p_token: await tokenFor(s.db, s.benefits['2026-10-16']) })
  })

  it('CONSUMED es estado terminal (ni siquiera el superusuario lo revierte)', async () => {
    await expect(s.db.query(`update public.benefits set status = 'PENDING', consumed_at = null where id = $1`, [s.benefits['2026-10-16']]))
      .rejects.toThrow(/BENEFIT_ALREADY_CONSUMED/)
  })

  it('UNIQUE(benefit_id) impide un segundo registro de consumo', async () => {
    await expect(s.db.query(
      `insert into public.consumptions (benefit_id, attendee_id, event_day_id, operator_id, consumed_at)
       select benefit_id, attendee_id, event_day_id, operator_id, now() from public.consumptions limit 1`)).rejects.toThrow(/duplicate key/)
  })

  it('consumos y auditoría son inmutables (UPDATE/DELETE/TRUNCATE)', async () => {
    await expect(s.db.query(`delete from public.consumptions`)).rejects.toThrow(/inmutable/)
    await expect(s.db.query(`update public.consumptions set consumed_at = now()`)).rejects.toThrow(/inmutable/)
    await expect(s.db.query(`truncate public.consumptions cascade`)).rejects.toThrow(/inmutable/)
    await expect(s.db.query(`delete from public.audit_logs`)).rejects.toThrow(/inmutable/)
    await expect(s.db.query(`update public.audit_logs set action = 'x'`)).rejects.toThrow(/inmutable/)
  })

  it('los beneficios no se pueden borrar', async () => {
    await expect(s.db.query(`delete from public.benefits where id = $1`, [s.benefits['2026-10-17']])).rejects.toThrow(/inmutable/)
  })
})

describe('idempotencia del consumo', () => {
  let s: Scenario
  beforeAll(async () => {
    s = await scenario()
  })

  it('un reintento con la misma Idempotency-Key devuelve la respuesta original (no ALREADY_CONSUMED)', async () => {
    const token = await tokenFor(s.db, s.benefits['2026-10-16'])
    const key = 'retry-key-0001'
    const first = await rpc<Result>(s.db, s.operator.authId, 'benefit_redeem', { p_token: token, p_idempotency_key: key })
    const again = await rpc<Result>(s.db, s.operator.authId, 'benefit_redeem', { p_token: token, p_idempotency_key: key })
    expect(first.code).toBe('APPROVED')
    expect(again.code).toBe('APPROVED')
    expect(again.idempotent_replay).toBe(true)
    const c = await one<{ n: number }>(s.db, `select count(*)::int n from public.consumptions`)
    expect(c.n).toBe(1)
  })

  it('misma key con otros parámetros → IDEMPOTENCY_KEY_REUSED', async () => {
    const r = await rpc<Result>(s.db, s.operator.authId, 'benefit_redeem', {
      p_token: await tokenFor(s.db, s.benefits['2026-10-17']), p_idempotency_key: 'retry-key-0001' })
    expect(r.code).toBe('IDEMPOTENCY_KEY_REUSED')
  })

  it('la key es por actor: otro operador con la misma key no recibe la respuesta ajena', async () => {
    const r = await rpc<Result>(s.db, s.operator2.authId, 'benefit_redeem', {
      p_token: await tokenFor(s.db, s.benefits['2026-10-16']), p_idempotency_key: 'retry-key-0001' })
    expect(r.code).toBe('ALREADY_CONSUMED')
    expect(r.idempotent_replay).toBeUndefined()
  })
})

describe('administración de beneficios', () => {
  let s: Scenario
  beforeAll(async () => {
    s = await scenario()
  })

  it('cancelar → CANCELADO; restaurar → PENDING; ambos auditados', async () => {
    const id = s.benefits['2026-10-16']
    await rpc(s.db, s.admin.authId, 'cancel_benefit', { p_benefit_id: id, p_reason: 'Duplicado' })
    const r = await rpc<Result>(s.db, s.operator.authId, 'benefit_validate', { p_token: await tokenFor(s.db, id) })
    expect(r.code).toBe('CANCELLED')
    await rpc(s.db, s.admin.authId, 'restore_benefit', { p_benefit_id: id, p_reason: 'Error corregido' })
    const r2 = await rpc<Result>(s.db, s.operator.authId, 'benefit_validate', { p_token: await tokenFor(s.db, id) })
    expect(r2.code).toBe('VALID')
    const a = await s.db.query<{ action: string }>(`select action from public.audit_logs where action in ('CANCEL_BENEFIT','RESTORE_BENEFIT') order by id`)
    expect(a.rows.map((x) => x.action)).toEqual(['CANCEL_BENEFIT', 'RESTORE_BENEFIT'])
  })

  it('rotar token invalida el QR anterior', async () => {
    const id = s.benefits['2026-10-16']
    const oldToken = await tokenFor(s.db, id)
    await rpc(s.db, s.admin.authId, 'regenerate_benefit_token', { p_benefit_id: id, p_reason: 'Captura filtrada' })
    const newToken = await tokenFor(s.db, id)
    expect(newToken).not.toBe(oldToken)
    expect((await rpc<Result>(s.db, s.operator.authId, 'benefit_validate', { p_token: oldToken })).code).toBe('INVALID_QR')
    expect((await rpc<Result>(s.db, s.operator.authId, 'benefit_validate', { p_token: newToken })).code).toBe('VALID')
  })

  it('expire_benefits persiste EXPIRED en días pasados', async () => {
    const n = await rpc<number>(s.db, s.admin.authId, 'expire_benefits')
    expect(n).toBe(1)
  })

  it('operador no puede cancelar', async () => {
    await expect(rpc(s.db, s.operator.authId, 'cancel_benefit', { p_benefit_id: s.benefits['2026-10-17'], p_reason: 'x' + 'yz' }))
      .rejects.toThrow(/FORBIDDEN/)
  })

  it('las estadísticas reflejan consumos por día, hora, operador y tipo de acceso', async () => {
    await rpc(s.db, s.operator.authId, 'benefit_redeem', { p_token: await tokenFor(s.db, s.benefits['2026-10-16']) })
    const st = await rpc<{
      totals: Record<string, number>
      by_hour: { hour: number; count: number }[]
      by_operator: { operator: string; count: number }[]
      by_access_type: { tipo_acceso: string; count: number }[]
    }>(s.db, s.viewer.authId, 'get_statistics', { p_filters: {} })
    expect(st.totals.consumed).toBe(1)
    expect(st.totals.consumed_today).toBe(1)
    expect(st.totals.expired).toBe(1)
    expect(st.totals.pending).toBe(1)
    expect(st.by_hour.find((h) => h.hour === 10)?.count).toBe(1)
    expect(st.by_operator[0].count).toBe(1)
    expect(st.by_access_type).toEqual([{ tipo_acceso: 'VIP', count: 1 }])
    await expect(rpc(s.db, s.operator.authId, 'get_statistics', { p_filters: {} })).rejects.toThrow(/FORBIDDEN/)
  })

  it('reportes: consumidos, pendientes, elegibles', async () => {
    const consumed = await rpc<unknown[]>(s.db, s.viewer.authId, 'get_report', { p_kind: 'benefits_consumed' })
    expect(consumed).toHaveLength(1)
    const pending = await rpc<unknown[]>(s.db, s.viewer.authId, 'get_report', { p_kind: 'benefits_pending' })
    expect(pending).toHaveLength(1)
    const eligible = await rpc<{ dias_elegibles: string }[]>(s.db, s.viewer.authId, 'get_report', { p_kind: 'eligible_attendees' })
    expect(eligible[0].dias_elegibles).toBe('2026-10-15 | 2026-10-16 | 2026-10-17')
    for (const kind of ['daily_consumptions', 'hourly_consumptions', 'operator_consumptions']) {
      expect(await rpc<unknown[]>(s.db, s.viewer.authId, 'get_report', { p_kind: kind })).toHaveLength(1)
    }
  })

  it('la vista consumption_details trae el nombre del operador aunque el lector no pueda ver profiles', async () => {
    const rows = await as<{ operator_label: string }>(s.db, s.viewer.authId, `select operator_label from public.consumption_details`)
    expect(rows[0].operator_label).toContain('op1')
  })
})

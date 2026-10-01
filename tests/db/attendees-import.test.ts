import { describe, it, expect, beforeAll } from 'vitest'
import { rpc, one } from './harness'
import { scenario, type Scenario } from './fixtures'

type ImportResult = {
  dry_run: boolean
  summary: { total: number; insert: number; update: number; skip: number; error: number }
  rows: { row: number; action: string; attendee_id: string | null; errors: string[]; warnings: string[] }[]
}

describe('asistentes: CRUD vía funciones', () => {
  let s: Scenario
  beforeAll(async () => {
    s = await scenario()
  })

  it('crea asistente sin effi_id (independencia de Effi) y con días → beneficios', async () => {
    const id = await rpc<string>(s.db, s.admin.authId, 'upsert_attendee', {
      p_id: null,
      p_data: { nombres: '  Laura   ', apellidos: 'Gómez', email: 'LAURA@Test.local', tipo_acceso: 'general' },
      p_partial: false,
      p_event_day_ids: [s.days['2026-10-16'], s.days['2026-10-17']],
    })
    const a = await one<{ nombres: string; email: string; effi_id: string | null; tipo_acceso: string }>(s.db,
      `select nombres, email, effi_id, tipo_acceso from public.attendees where id = $1`, [id])
    expect(a).toEqual({ nombres: 'Laura', email: 'laura@test.local', effi_id: null, tipo_acceso: 'GENERAL' })
    const b = await one<{ n: number }>(s.db, `select count(*)::int n from public.benefits where attendee_id = $1`, [id])
    expect(b.n).toBe(2)
  })

  it('PATCH parcial solo cambia los campos enviados', async () => {
    await rpc(s.db, s.admin.authId, 'upsert_attendee', { p_id: s.attendeeId, p_data: { empresa: 'Nueva SAS' }, p_partial: true })
    const a = await one<{ empresa: string; effi_id: string }>(s.db, `select empresa, effi_id from public.attendees where id = $1`, [s.attendeeId])
    expect(a).toEqual({ empresa: 'Nueva SAS', effi_id: '123456' })
  })

  it('rechaza effi_id duplicado, email inválido y campos desconocidos', async () => {
    await expect(rpc(s.db, s.admin.authId, 'upsert_attendee', { p_id: null, p_data: { nombres: 'X', effi_id: '123456' }, p_partial: false }))
      .rejects.toThrow(/duplicate key|unique/)
    await expect(rpc(s.db, s.admin.authId, 'upsert_attendee', { p_id: null, p_data: { nombres: 'X', email: 'no-es-email' }, p_partial: false }))
      .rejects.toThrow(/check constraint/)
    await expect(rpc(s.db, s.admin.authId, 'upsert_attendee', { p_id: null, p_data: { nombres: 'X', id: 'hack' }, p_partial: false }))
      .rejects.toThrow(/UNKNOWN_FIELD/)
  })

  it('quitar un día de elegibilidad marca eligible=false sin borrar el beneficio', async () => {
    await rpc(s.db, s.admin.authId, 'set_attendee_days', { p_attendee_id: s.attendeeId, p_event_day_ids: [s.days['2026-10-16']] })
    const r = await s.db.query<{ eligible: boolean }>(`select eligible from public.attendee_event_days where attendee_id = $1 order by eligible`, [s.attendeeId])
    expect(r.rows.map((x) => x.eligible)).toEqual([false, false, true])
    const b = await one<{ n: number }>(s.db, `select count(*)::int n from public.benefits where attendee_id = $1`, [s.attendeeId])
    expect(b.n).toBe(3)
  })

  it('auditoría registra CREATE_ATTENDEE y UPDATE_ATTENDEE con el actor', async () => {
    const r = await s.db.query<{ action: string; actor_profile_id: string }>(
      `select action, actor_profile_id from public.audit_logs where action in ('CREATE_ATTENDEE','UPDATE_ATTENDEE') and actor_profile_id is not null`)
    expect(r.rows.some((x) => x.action === 'CREATE_ATTENDEE' && x.actor_profile_id === s.admin.profileId)).toBe(true)
    expect(r.rows.some((x) => x.action === 'UPDATE_ATTENDEE')).toBe(true)
  })

  it('viewer y operador no pueden crear asistentes', async () => {
    await expect(rpc(s.db, s.viewer.authId, 'upsert_attendee', { p_id: null, p_data: { nombres: 'X' }, p_partial: false })).rejects.toThrow(/FORBIDDEN/)
    await expect(rpc(s.db, s.operator.authId, 'upsert_attendee', { p_id: null, p_data: { nombres: 'X' }, p_partial: false })).rejects.toThrow(/FORBIDDEN/)
  })
})

describe('importación masiva', () => {
  let s: Scenario
  const rows = [
    { row: 2, nombres: 'Ana', apellidos: 'Ríos', email: 'ana@x.co', effi_id: 'E-1', effi_username: 'ana.rios', tipo_acceso: 'vip', empresa: 'Uno' },
    { row: 3, nombres: 'Juan Actualizado', email: 'juan.perez@test.local', empresa: 'ACME 2' }, // existe → update
    { row: 4, nombres: '', email: 'sin-nombre@x.co' }, // error
    { row: 5, nombres: 'Dup', email: 'ana@x.co' }, // duplicado en archivo
    { row: 6, nombres: 'Mal email', email: 'mal@' }, // error
    { row: 7, nombres: 'Sin ids' }, // warning
  ]

  beforeAll(async () => {
    s = await scenario()
  })

  it('dry-run: previsualiza sin escribir', async () => {
    const before = await one<{ n: number }>(s.db, `select count(*)::int n from public.attendees`)
    const r = await rpc<ImportResult>(s.db, s.admin.authId, 'import_attendees', { p_rows: rows, p_mode: 'upsert', p_dry_run: true })
    expect(r.summary).toEqual({ total: 6, insert: 2, update: 1, skip: 0, error: 3 })
    expect(r.rows.find((x) => x.row === 4)?.errors).toContain('nombres es obligatorio')
    expect(r.rows.find((x) => x.row === 5)?.errors[0]).toMatch(/duplicado en el archivo/)
    expect(r.rows.find((x) => x.row === 7)?.warnings.join()).toMatch(/sin email/)
    const after = await one<{ n: number }>(s.db, `select count(*)::int n from public.attendees`)
    expect(after.n).toBe(before.n)
  })

  it('modo insert_only omite existentes', async () => {
    const r = await rpc<ImportResult>(s.db, s.admin.authId, 'import_attendees', { p_rows: rows, p_mode: 'insert_only', p_dry_run: true })
    expect(r.summary.skip).toBe(1)
    expect(r.summary.update).toBe(0)
  })

  it('import real: inserta, actualiza sin borrar datos, asigna días, genera beneficios y audita', async () => {
    const r = await rpc<ImportResult>(s.db, s.admin.authId, 'import_attendees', {
      p_rows: rows, p_mode: 'upsert', p_dry_run: false, p_event_day_ids: [s.days['2026-10-16']], p_file_name: 'asistentes.csv' })
    expect(r.summary).toEqual({ total: 6, insert: 2, update: 1, skip: 0, error: 3 })
    const juan = await one<{ nombres: string; empresa: string; effi_id: string }>(s.db,
      `select nombres, empresa, effi_id from public.attendees where id = $1`, [s.attendeeId])
    expect(juan).toEqual({ nombres: 'Juan Actualizado', empresa: 'ACME 2', effi_id: '123456' })
    const ana = await one<{ id: string; tipo_acceso: string }>(s.db, `select id, tipo_acceso from public.attendees where effi_id = 'E-1'`)
    expect(ana.tipo_acceso).toBe('VIP')
    const b = await one<{ n: number }>(s.db, `select count(*)::int n from public.benefits where attendee_id = $1`, [ana.id])
    expect(b.n).toBe(1)
    const a = await one<{ metadata: { inserted: number; file_name: string } }>(s.db,
      `select metadata from public.audit_logs where action = 'IMPORT_ATTENDEES'`)
    expect(a.metadata).toMatchObject({ inserted: 2, file_name: 'asistentes.csv' })
  })

  it('identificadores que apuntan a asistentes distintos → error (nunca fusiona silenciosamente)', async () => {
    const r = await rpc<ImportResult>(s.db, s.admin.authId, 'import_attendees', {
      p_rows: [{ row: 2, nombres: 'Mix', effi_id: '123456', email: 'ana@x.co' }], p_dry_run: true })
    expect(r.rows[0].action).toBe('error')
    expect(r.rows[0].errors[0]).toMatch(/asistentes distintos/)
  })

  it('lote de más de 1000 filas se rechaza', async () => {
    const big = Array.from({ length: 1001 }, (_, i) => ({ nombres: `N${i}` }))
    await expect(rpc(s.db, s.admin.authId, 'import_attendees', { p_rows: big })).rejects.toThrow(/BATCH_TOO_LARGE/)
  })

  it('requiere attendees:import', async () => {
    await expect(rpc(s.db, s.viewer.authId, 'import_attendees', { p_rows: [] })).rejects.toThrow(/FORBIDDEN/)
  })
})

import { readFileSync } from 'node:fs'
import { describe, it, expect, beforeAll } from 'vitest'
import { createDb, createAuthUser, rpc, one, setNow, type Db } from './harness'

const read = (p: string) => readFileSync(new URL(`../../supabase/${p}`, import.meta.url), 'utf8')

describe('scripts operativos', () => {
  let db: Db
  beforeAll(async () => {
    db = await createDb()
  })

  it('seed.sql crea días de ejemplo y asistentes DEMO con beneficios automáticos', async () => {
    await db.exec(read('seed.sql'))
    const a = await one<{ n: number; demo: number }>(db, `select count(*)::int n, count(*) filter (where is_demo)::int demo from public.attendees`)
    expect(a).toEqual({ n: 3, demo: 3 })
    const b = await one<{ n: number }>(db, `select count(*)::int n from public.benefits`)
    expect(b.n).toBe(12) // 5 + 5 + 2
  })

  it('bootstrap_super_admin.sql exige editar el email', async () => {
    await expect(db.exec(read('scripts/bootstrap_super_admin.sql'))).rejects.toThrow(/Edite el email/)
  })

  it('bootstrap_super_admin.sql crea el super admin y se vincula al primer login', async () => {
    await db.exec(read('scripts/bootstrap_super_admin.sql').replace("'admin@su-dominio.com';   -- ← CAMBIAR", "'jefe@feria.test';"))
    const uid = await createAuthUser(db, 'jefe@feria.test')
    const access = await rpc<{ roles: string[]; permissions: string[] }>(db, uid, 'on_login')
    expect(access.roles).toEqual(['super_admin'])
    expect(access.permissions).toContain('roles:manage')
  })

  it('demo_tokens.sql lista tokens solo de asistentes demo', async () => {
    const r = await db.query<{ qr_token: string }>(read('scripts/demo_tokens.sql'))
    expect(r.rows).toHaveLength(12)
    expect(r.rows[0].qr_token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('cleanup_demo.sql desactiva demo y cancela pendientes sin borrar historial', async () => {
    await setNow(db, '2026-10-16T15:00:00Z')
    await db.exec(read('scripts/cleanup_demo.sql'))
    const r = await one<{ inactive: number; pending: number; total: number }>(db,
      `select (select count(*)::int from public.attendees where is_demo and not activo) inactive,
              (select count(*)::int from public.benefits where status = 'PENDING') pending,
              (select count(*)::int from public.benefits) total`)
    expect(r).toEqual({ inactive: 3, pending: 0, total: 12 })
  })
})

import { describe, it, expect, beforeAll } from 'vitest'
import { createDb, type Db } from './harness'

describe('migraciones', () => {
  let db: Db
  beforeAll(async () => {
    db = await createDb()
  })

  it('crean todas las tablas con RLS habilitado', async () => {
    const r = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' order by 1`,
    )
    const tables = r.rows.map((x) => x.relname)
    for (const t of ['profiles', 'roles', 'permissions', 'role_permissions', 'user_roles', 'attendees', 'event_days',
      'attendee_event_days', 'benefits', 'consumptions', 'api_integrations', 'api_credentials', 'audit_logs', 'app_settings']) {
      expect(tables).toContain(t)
    }
    expect(r.rows.filter((x) => !x.relrowsecurity).map((x) => x.relname)).toEqual([])
  })

  it('siembran roles del sistema y permisos', async () => {
    const roles = await db.query<{ name: string }>(`select name from public.roles order by name`)
    expect(roles.rows.map((r) => r.name)).toEqual(['admin', 'operator', 'super_admin', 'supervisor', 'viewer'])
    const superPerms = await db.query<{ n: number }>(
      `select count(*)::int n from public.role_permissions rp join public.roles r on r.id = rp.role_id where r.name = 'super_admin'`)
    const allPerms = await db.query<{ n: number }>(`select count(*)::int n from public.permissions`)
    expect(superPerms.rows[0].n).toBe(allPerms.rows[0].n)
  })

  it('genera un secreto HMAC para QR', async () => {
    const r = await db.query<{ len: number }>(`select length(value) len from private.secrets where name = 'qr_hmac_secret'`)
    expect(r.rows[0].len).toBe(64)
  })

  it('ninguna función pública es ejecutable por anon salvo server_time', async () => {
    const r = await db.query<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute') order by 1`)
    expect(r.rows.map((x) => x.proname)).toEqual(['server_time'])
  })

  it('las funciones api_* no son ejecutables por authenticated', async () => {
    const r = await db.query<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname like 'api\_%' and has_function_privilege('authenticated', p.oid, 'execute')`)
    expect(r.rows).toEqual([])
  })

  it('authenticated no puede leer columnas sensibles', async () => {
    const r = await db.query<{ ok: boolean }>(
      `select has_column_privilege('authenticated', 'public.benefits', 'token_hash', 'select') or
              has_column_privilege('authenticated', 'public.benefits', 'token_salt', 'select') or
              has_column_privilege('authenticated', 'public.api_credentials', 'credential_hash', 'select') as ok`)
    expect(r.rows[0].ok).toBe(false)
  })
})

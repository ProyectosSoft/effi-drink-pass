import { describe, it, expect, beforeAll } from 'vitest'
import { as, rpc, createAuthUser, one } from './harness'
import { scenario, type Scenario } from './fixtures'

describe('RLS', () => {
  let s: Scenario
  let otherAttendeeAuth: string
  beforeAll(async () => {
    s = await scenario()
    otherAttendeeAuth = await createAuthUser(s.db, 'maria@test.local')
    await s.db.query(`insert into public.attendees (nombres, email, auth_user_id) values ('María', 'maria@test.local', $1)`, [otherAttendeeAuth])
  })

  it('anon no ve asistentes, beneficios ni auditoría; sí ve días del evento', async () => {
    await expect(as(s.db, null, `select * from public.attendees`)).rejects.toThrow(/permission denied/)
    await expect(as(s.db, null, `select id from public.benefits`)).rejects.toThrow(/permission denied/)
    await expect(as(s.db, null, `select * from public.audit_logs`)).rejects.toThrow(/permission denied/)
    expect(await as(s.db, null, `select * from public.event_days`)).toHaveLength(3)
  })

  it('un asistente solo ve su propio registro, beneficios y consumos', async () => {
    const atts = await as<{ nombres: string }>(s.db, otherAttendeeAuth, `select nombres from public.attendees`)
    expect(atts.map((a) => a.nombres)).toEqual(['María'])
    expect(await as(s.db, otherAttendeeAuth, `select id from public.benefits`)).toHaveLength(0)
    const own = await as(s.db, s.attendeeAuth, `select id from public.benefits`)
    expect(own).toHaveLength(3)
  })

  it('nadie puede leer token_hash ni token_salt vía API', async () => {
    await expect(as(s.db, s.superAdmin.authId, `select token_hash from public.benefits`)).rejects.toThrow(/permission denied/)
    await expect(as(s.db, s.attendeeAuth, `select token_salt from public.benefits`)).rejects.toThrow(/permission denied/)
  })

  it('escrituras directas denegadas incluso para admin (solo vía funciones)', async () => {
    await expect(as(s.db, s.admin.authId, `insert into public.attendees (nombres) values ('X')`)).rejects.toThrow(/permission denied/)
    await expect(as(s.db, s.admin.authId, `update public.benefits set status = 'CONSUMED'`)).rejects.toThrow(/permission denied/)
    await expect(as(s.db, s.superAdmin.authId, `delete from public.audit_logs`)).rejects.toThrow(/permission denied/)
    await expect(as(s.db, s.attendeeAuth, `update public.attendees set activo = true`)).rejects.toThrow(/permission denied/)
  })

  it('operador no ve asistentes, auditoría, integraciones ni perfiles ajenos', async () => {
    expect(await as(s.db, s.operator.authId, `select * from public.attendees`)).toHaveLength(0)
    expect(await as(s.db, s.operator.authId, `select * from public.audit_logs`)).toHaveLength(0)
    expect(await as(s.db, s.operator.authId, `select * from public.api_integrations`)).toHaveLength(0)
    const profiles = await as<{ email: string }>(s.db, s.operator.authId, `select email from public.profiles`)
    expect(profiles.map((p) => p.email)).toEqual(['op1@test.local'])
  })

  it('viewer lee asistentes y beneficios pero no auditoría', async () => {
    expect((await as(s.db, s.viewer.authId, `select * from public.attendees`)).length).toBe(2)
    expect((await as(s.db, s.viewer.authId, `select id from public.benefits`)).length).toBe(3)
    expect(await as(s.db, s.viewer.authId, `select * from public.audit_logs`)).toHaveLength(0)
  })

  it('admin lee la auditoría', async () => {
    expect((await as(s.db, s.admin.authId, `select * from public.audit_logs`)).length).toBeGreaterThan(0)
  })

  it('un perfil inactivo pierde todos sus permisos', async () => {
    await s.db.query(`update public.profiles set activo = false where id = $1`, [s.viewer.profileId])
    expect(await as(s.db, s.viewer.authId, `select * from public.attendees`)).toHaveLength(0)
    await s.db.query(`update public.profiles set activo = true where id = $1`, [s.viewer.profileId])
  })
})

describe('roles y usuarios', () => {
  let s: Scenario
  beforeAll(async () => {
    s = await scenario()
  })

  const roleId = async (s: Scenario, name: string) =>
    (await one<{ id: string }>(s.db, `select id from public.roles where name = $1`, [name])).id

  it('my_access devuelve roles y permisos', async () => {
    const a = await rpc<{ roles: string[]; permissions: string[] }>(s.db, s.operator.authId, 'my_access')
    expect(a.roles).toEqual(['operator'])
    expect(a.permissions.sort()).toEqual(['benefits:redeem', 'benefits:validate', 'event-days:read'])
  })

  it('admin crea staff y le asigna operador; queda auditado CHANGE_ROLE', async () => {
    const id = await rpc<string>(s.db, s.admin.authId, 'upsert_staff_profile', {
      p_id: null, p_email: 'Nuevo.Op@Test.local', p_nombres: 'Nuevo', p_apellidos: 'Operador' })
    await rpc(s.db, s.admin.authId, 'set_user_roles', { p_profile_id: id, p_role_ids: [await roleId(s, 'operator')] })
    const p = await one<{ email: string }>(s.db, `select email from public.profiles where id = $1`, [id])
    expect(p.email).toBe('nuevo.op@test.local')
    const a = await one<{ n: number }>(s.db, `select count(*)::int n from public.audit_logs where action = 'CHANGE_ROLE' and resource_id = $1`, [id])
    expect(a.n).toBe(1)
  })

  it('admin NO puede otorgar super_admin (solo un super_admin)', async () => {
    await expect(rpc(s.db, s.admin.authId, 'set_user_roles', { p_profile_id: s.viewer.profileId, p_role_ids: [await roleId(s, 'super_admin')] }))
      .rejects.toThrow(/ONLY_SUPER_ADMIN/)
  })

  it('anti-escalamiento: no se otorga un rol con permisos que el otorgante no tiene', async () => {
    const custom = await rpc<string>(s.db, s.superAdmin.authId, 'upsert_role', { p_id: null, p_name: 'role_admin_lite', p_description: 'x', p_active: true })
    await rpc(s.db, s.superAdmin.authId, 'set_role_permissions', { p_role_id: custom, p_permissions: ['roles:manage'] })
    await expect(rpc(s.db, s.admin.authId, 'set_user_roles', { p_profile_id: s.viewer.profileId, p_role_ids: [custom] }))
      .rejects.toThrow(/PRIVILEGE_ESCALATION/)
  })

  it('no se puede quitar el último super_admin ni desactivarse a sí mismo', async () => {
    await expect(rpc(s.db, s.superAdmin.authId, 'set_user_roles', { p_profile_id: s.superAdmin.profileId, p_role_ids: [await roleId(s, 'admin')] }))
      .rejects.toThrow(/LAST_SUPER_ADMIN/)
    await expect(rpc(s.db, s.admin.authId, 'upsert_staff_profile', {
      p_id: s.admin.profileId, p_email: 'admin@test.local', p_nombres: 'a', p_apellidos: '', p_telefono: null, p_activo: false }))
      .rejects.toThrow(/CANNOT_DEACTIVATE_SELF/)
  })

  it('los permisos del rol super_admin son inmutables', async () => {
    await expect(rpc(s.db, s.superAdmin.authId, 'set_role_permissions', { p_role_id: await roleId(s, 'super_admin'), p_permissions: [] }))
      .rejects.toThrow(/SUPER_ADMIN_ROLE_IMMUTABLE/)
  })

  it('admin no gestiona roles (sin roles:manage)', async () => {
    await expect(rpc(s.db, s.admin.authId, 'upsert_role', { p_id: null, p_name: 'otro', p_description: null, p_active: true }))
      .rejects.toThrow(/FORBIDDEN/)
  })

  it('on_login vincula por email verificado (y no si no está verificado)', async () => {
    await s.db.query(`insert into public.attendees (nombres, email) values ('Ana', 'ana@test.local'), ('Beto', 'beto@test.local')`)
    const ana = await createAuthUser(s.db, 'ANA@test.local', true)
    const beto = await createAuthUser(s.db, 'beto@test.local', false)
    const accessAna = await rpc<{ attendee: { nombres: string } | null }>(s.db, ana, 'on_login')
    const accessBeto = await rpc<{ attendee: unknown }>(s.db, beto, 'on_login')
    expect(accessAna.attendee?.nombres).toBe('Ana')
    expect(accessBeto.attendee).toBeNull()
    const logins = await one<{ n: number }>(s.db, `select count(*)::int n from public.audit_logs where action = 'LOGIN'`)
    expect(logins.n).toBe(2)
  })

  it('pre-registro de staff: se vincula al iniciar sesión con ese email', async () => {
    await rpc(s.db, s.admin.authId, 'upsert_staff_profile', { p_id: null, p_email: 'barra3@test.local', p_nombres: 'Barra', p_apellidos: 'Tres' })
    const u = await createAuthUser(s.db, 'barra3@test.local')
    const acc = await rpc<{ profile: { email: string } }>(s.db, u, 'on_login')
    expect(acc.profile.email).toBe('barra3@test.local')
  })
})

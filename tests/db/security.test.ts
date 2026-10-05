/**
 * Regresiones de la auditoría de seguridad (migración 0011_security_hardening).
 * Cada bloque reproduce el ataque original y comprueba que ahora se rechaza.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { as, asService, createAuthUser, createStaff, one, rpc } from './harness'
import { scenario, type Scenario } from './fixtures'

describe('toma de cuenta vía upsert_staff_profile', () => {
  let s: Scenario
  let pendingSuper: string
  beforeAll(async () => {
    s = await scenario()
    // super_admin pre-registrado que aún no ha iniciado sesión (auth_user_id nulo).
    pendingSuper = (await one<{ id: string }>(s.db,
      `insert into public.profiles (email, nombres) values ('nuevo.root@test.local', 'Root') returning id`)).id
    await s.db.query(`insert into public.user_roles (user_id, role_id) select $1, id from public.roles where name = 'super_admin'`, [pendingSuper])
  })

  it('un admin NO puede cambiar el email de un super_admin pendiente para apropiarse de él', async () => {
    await expect(rpc(s.db, s.admin.authId, 'upsert_staff_profile', {
      p_id: pendingSuper, p_email: 'atacante@test.local', p_nombres: 'X' })).rejects.toThrow(/ONLY_SUPER_ADMIN_CAN_MANAGE_SUPER_ADMIN/)
    // Y aunque el atacante inicie sesión con su correo, no obtiene nada.
    const attacker = await createAuthUser(s.db, 'atacante@test.local')
    const acc = await rpc<{ roles: string[] }>(s.db, attacker, 'on_login')
    expect(acc.roles).toEqual([])
  })

  it('un admin NO puede desactivar a un super_admin', async () => {
    await expect(rpc(s.db, s.admin.authId, 'upsert_staff_profile', {
      p_id: s.superAdmin.profileId, p_email: 'root@test.local', p_nombres: 'root', p_activo: false }))
      .rejects.toThrow(/ONLY_SUPER_ADMIN/)
  })

  it('anti-escalamiento: no se edita un perfil con permisos que el editor no tiene', async () => {
    const custom = await rpc<string>(s.db, s.superAdmin.authId, 'upsert_role', { p_id: null, p_name: 'gestor_roles', p_description: null, p_active: true })
    await rpc(s.db, s.superAdmin.authId, 'set_role_permissions', { p_role_id: custom, p_permissions: ['roles:manage'] })
    const target = await createStaff(s.db, 'gestor@test.local', ['gestor_roles'])
    await expect(rpc(s.db, s.admin.authId, 'upsert_staff_profile', {
      p_id: target.profileId, p_email: 'otro@test.local', p_nombres: 'G' })).rejects.toThrow(/PRIVILEGE_ESCALATION/)
  })

  it('se mantiene lo legítimo: admin edita operadores y super_admin edita a cualquiera', async () => {
    await rpc(s.db, s.admin.authId, 'upsert_staff_profile', { p_id: s.operator.profileId, p_email: 'op1@test.local', p_nombres: 'Op Uno' })
    await rpc(s.db, s.superAdmin.authId, 'upsert_staff_profile', { p_id: pendingSuper, p_email: 'root2@test.local', p_nombres: 'Root 2' })
    const p = await one<{ email: string }>(s.db, `select email from public.profiles where id = $1`, [pendingSuper])
    expect(p.email).toBe('root2@test.local')
  })
})

describe('auditoría no inflable por cuentas registradas', () => {
  let s: Scenario
  let stranger: string
  beforeAll(async () => {
    s = await scenario()
    stranger = await createAuthUser(s.db, 'cualquiera@test.local') // registro abierto, sin rol
  })

  it('on_login responde siempre, pero audita como máximo 10 LOGIN por minuto y usuario', async () => {
    for (let i = 0; i < 15; i++) await rpc(s.db, stranger, 'on_login')
    const n = await one<{ n: number }>(s.db, `select count(*)::int n from public.audit_logs where action = 'LOGIN' and resource_id = $1`, [stranger])
    expect(n.n).toBe(10)
  })

  it('una cuenta sin rol solo puede registrar LOGOUT', async () => {
    await rpc(s.db, stranger, 'log_client_event', { p_action: 'LOGOUT', p_metadata: {} })
    await expect(rpc(s.db, stranger, 'log_client_event', { p_action: 'EXPORT_REPORT', p_metadata: {} })).rejects.toThrow(/FORBIDDEN/)
  })

  it('log_client_event tiene límite de frecuencia (30 por minuto)', async () => {
    for (let i = 0; i < 30; i++) await rpc(s.db, s.operator.authId, 'log_client_event', { p_action: 'SCANNER_OPENED', p_metadata: {} })
    await expect(rpc(s.db, s.operator.authId, 'log_client_event', { p_action: 'SCANNER_OPENED', p_metadata: {} })).rejects.toThrow(/RATE_LIMITED/)
  })
})

describe('catálogo RBAC y configuración solo para staff', () => {
  let s: Scenario
  beforeAll(async () => {
    s = await scenario()
  })

  it('asistentes y cuentas sin rol no ven roles, permisos ni app_settings', async () => {
    for (const t of ['roles', 'permissions', 'role_permissions', 'app_settings']) {
      expect(await as(s.db, s.attendeeAuth, `select * from public.${t}`), t).toHaveLength(0)
    }
  })

  it('el staff (incluso operador) sí los ve', async () => {
    expect((await as(s.db, s.operator.authId, `select * from public.app_settings`)).length).toBeGreaterThan(0)
    expect((await as(s.db, s.admin.authId, `select * from public.roles`)).length).toBe(5)
  })
})

describe('IP de auditoría', () => {
  it('request_ip prefiere cf-connecting-ip sobre x-forwarded-for', async () => {
    const s = await scenario()
    await s.db.query(`select set_config('request.headers', $1, false)`,
      [JSON.stringify({ 'x-forwarded-for': '6.6.6.6', 'cf-connecting-ip': '1.1.1.1' })])
    expect((await one<{ ip: string }>(s.db, `select private.request_ip() as ip`)).ip).toBe('1.1.1.1')
    await s.db.query(`select set_config('request.headers', $1, false)`, [JSON.stringify({ 'x-forwarded-for': '6.6.6.6, 1.1.1.1' })])
    expect((await one<{ ip: string }>(s.db, `select private.request_ip() as ip`)).ip).toBe('6.6.6.6')
    await s.db.query(`select set_config('request.headers', '', false)`)
  })
})

describe('webhooks', () => {
  let s: Scenario
  let integrationId: string
  beforeAll(async () => {
    s = await scenario()
    integrationId = await rpc<string>(s.db, s.admin.authId, 'create_integration', {
      p_name: 'ERP', p_description: null, p_allowed_scopes: ['consumptions:read'] })
  })

  it('rechaza userinfo, punto final y .arpa en la URL', async () => {
    for (const url of ['https://a@169.254.169.254/x', 'https://localhost./x', 'https://srv.internal./x', 'https://x.in-addr.arpa/x']) {
      await expect(rpc(s.db, s.admin.authId, 'create_webhook_subscription', { p_integration_id: integrationId, p_url: url }), url)
        .rejects.toThrow(/INVALID_WEBHOOK_URL|check constraint/)
    }
  })

  it('al retirar consumptions:read de la integración deja de generar y de entregar eventos', async () => {
    await rpc(s.db, s.admin.authId, 'create_webhook_subscription', { p_integration_id: integrationId, p_url: 'https://hooks.example.com/x' })
    await rpc(s.db, s.admin.authId, 'benefit_override_redeem', { p_benefit_id: s.benefits['2026-10-16'], p_reason: 'Prueba scope 1' })
    expect((await one<{ n: number }>(s.db, `select count(*)::int n from private.webhook_deliveries`)).n).toBe(1)

    // Se retira el scope con la entrega aún pendiente.
    await s.db.query(`update public.api_integrations set allowed_scopes = '{attendees:read}' where id = $1`, [integrationId])
    const claimed = (await asService<{ r: unknown[] }>(s.db, `select public.webhooks_claim(10, 60) as r`))[0].r
    expect(claimed).toHaveLength(0)
    await rpc(s.db, s.admin.authId, 'benefit_override_redeem', { p_benefit_id: s.benefits['2026-10-17'], p_reason: 'Prueba scope 2' })
    expect((await one<{ n: number }>(s.db, `select count(*)::int n from private.webhook_deliveries`)).n).toBe(1)
  })
})

describe('consumo vía API', () => {
  it('api_benefit_process rechaza metadata de más de 2 KB', async () => {
    const s = await scenario()
    const actor = { type: 'integration', channel: 'api', scopes: ['benefits:validate'], label: 'test' }
    await expect(asService(s.db, `select public.api_benefit_process($1, 'validate', null, $2, null, $3)`,
      [actor, s.benefits['2026-10-16'], { blob: 'x'.repeat(3000) }])).rejects.toThrow(/METADATA_TOO_LARGE/)
  })
})

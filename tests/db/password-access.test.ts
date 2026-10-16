import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scenario, type Scenario } from './fixtures'
import { createAuthUser, rpc } from './harness'

describe('asignación de contraseña temporal', () => {
  let s: Scenario
  beforeEach(async () => { s = await scenario() })
  afterEach(async () => { await s?.db.close() })
  it('solo permite a Super Admin resolver una cuenta activa registrada', async () => {
    const email = 'existing-password@test.local'
    const userId = await createAuthUser(s.db, email)
    await s.db.query("insert into public.profiles(email,nombres,apellidos) values ($1,'Persona','Prueba')", [email])
    for (const actor of [null, s.admin.authId, s.operator.authId]) {
      await expect(rpc(s.db, actor, 'password_access_target', { p_email: email })).rejects.toThrow()
    }
    expect(await rpc(s.db, s.superAdmin.authId, 'password_access_target', { p_email: email.toUpperCase() })).toEqual({ email, user_id: userId })
    await expect(rpc(s.db, s.superAdmin.authId, 'password_access_target', { p_email: 'unknown@test.local' })).rejects.toThrow('NOT_FOUND')
  })
})

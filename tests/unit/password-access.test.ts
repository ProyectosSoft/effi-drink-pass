import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), update: vi.fn(), create: vi.fn(), rpc: vi.fn() }))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({
  auth: { getUser: mocks.getUser, admin: { updateUserById: mocks.update, createUser: mocks.create } }, rpc: mocks.rpc,
}) }))
let handle: (req: Request) => Promise<Response>
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks()
  vi.stubGlobal('Deno', { env: { get: (key: string) => key === 'SUPABASE_URL' ? 'https://example.supabase.co' : 'test' }, serve: (handler: typeof handle) => { handle = handler } })
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'actor', app_metadata: {} } } })
  mocks.update.mockResolvedValue({ data: {}, error: null })
  mocks.create.mockResolvedValue({ data: {}, error: null })
  mocks.rpc.mockResolvedValue({ data: { user_id: 'target', email: 'user@example.com' }, error: null })
  await import('../../supabase/functions/password-access/index')
})
const request = (body: object, jwt = 'valid') => handle(new Request('https://example.com', { method: 'POST', headers: jwt ? { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' } : {}, body: JSON.stringify(body) }))

describe('contraseñas sin correo', () => {
  it('rechaza solicitudes sin sesión antes de tocar Auth', async () => {
    expect((await request({ action: 'temporary', email: 'user@example.com' }, '')).status).toBe(401)
    expect(mocks.update).not.toHaveBeenCalled()
  })
  it('no cambia contraseñas cuando la RPC rechaza los permisos o el registro', async () => {
    mocks.rpc.mockResolvedValue({ error: { message: 'FORBIDDEN' }, data: null })
    expect((await request({ action: 'temporary', email: 'user@example.com' })).status).toBe(403)
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it('resuelve el destino en el servidor y genera una contraseña aleatoria sin correo', async () => {
    const response = await request({ action: 'temporary', email: ' USER@EXAMPLE.COM ', user_id: 'victim' })
    const result = await response.json()
    expect(result.password).toMatch(/^[0-9a-f]{48}$/)
    expect(mocks.rpc).toHaveBeenCalledWith('password_access_target', { p_email: 'user@example.com' })
    expect(mocks.update).toHaveBeenCalledWith('target', expect.objectContaining({ password: result.password, app_metadata: { must_change_password: true } }))
  })
  it('solo permite completar la contraseña del propio usuario con contraseña temporal', async () => {
    expect((await request({ action: 'complete', password: 'new-password-123' })).status).toBe(403)
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'actor', app_metadata: { must_change_password: true, provider: 'email' } } } })
    expect((await request({ action: 'complete', password: 'new-password-123', user_id: 'victim' })).status).toBe(200)
    expect(mocks.update).toHaveBeenCalledWith('actor', { password: 'new-password-123', app_metadata: { must_change_password: false, provider: 'email' } })
  })
  it('no guarda contraseñas demasiado cortas', async () => {
    expect((await request({ action: 'complete', password: 'short' })).status).toBe(400)
    expect(mocks.update).not.toHaveBeenCalled()
  })
})

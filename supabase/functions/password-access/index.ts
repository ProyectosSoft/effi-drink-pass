/// <reference path="../_shared/deno.d.ts" />
import { createClient } from '@supabase/supabase-js'

const url = Deno.env.get('SUPABASE_URL')!
const anon = Deno.env.get('SUPABASE_ANON_KEY')!
const service = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } })
const origins = new Set((Deno.env.get('PASSWORD_ACCESS_ORIGINS') ?? 'https://proyectossoft.github.io,http://localhost:5173').split(',').map(x => x.trim()))

Deno.serve(async (req) => {
  const origin = req.headers.get('origin') ?? ''
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origins.has(origin) ? origin : '', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Vary': 'Origin' }
  const reply = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers })
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers })
  if (req.method !== 'POST') return reply({ error: 'Método no permitido.' }, 405)
  try {
    const jwt = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    if (!jwt) return reply({ error: 'Inicia sesión nuevamente.' }, 401)
    const { data: actor, error: authError } = await service.auth.getUser(jwt)
    if (authError || !actor.user) return reply({ error: 'Inicia sesión nuevamente.' }, 401)
    const body = await req.json()
    if (body.action === 'complete') {
      if (typeof body.password !== 'string' || body.password.length < 10 || body.password.length > 72) return reply({ error: 'Usa entre 10 y 72 caracteres.' }, 400)
      if (actor.user.app_metadata.must_change_password !== true) return reply({ error: 'Usa Mi cuenta para cambiar tu contraseña.' }, 403)
      // JWT validado: solo puede cambiar su propia contraseña temporal.
      const { error } = await service.auth.admin.updateUserById(actor.user.id, { password: body.password, app_metadata: { ...actor.user.app_metadata, must_change_password: false } })
      if (error) return reply({ error: 'No se pudo guardar la contraseña. Usa entre 10 y 72 caracteres.' }, 400)
      return reply({ ok: true })
    }
    if (body.action !== 'temporary' || typeof body.email !== 'string') return reply({ error: 'Solicitud inválida.' }, 400)
    const userClient = createClient(url, anon, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${jwt}` } } })
    // La RPC comprueba super_admin, registro previo, actividad, límite y deja auditoría.
    const { data: target, error: targetError } = await userClient.rpc('password_access_target', { p_email: body.email.trim().toLowerCase() })
    if (targetError || !target) return reply({ error: 'No autorizado o correo sin registro activo. Solo un Super Admin puede asignar contraseñas temporales.' }, 403)
    const bytes = crypto.getRandomValues(new Uint8Array(24))
    const password = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
    const result = target.user_id
      ? await service.auth.admin.updateUserById(target.user_id, { password, email_confirm: true, app_metadata: { must_change_password: true } })
      : await service.auth.admin.createUser({ email: target.email, password, email_confirm: true, app_metadata: { must_change_password: true } })
    if (result.error) return reply({ error: 'No se pudo asignar la contraseña. Revisa el registro y vuelve a intentar.' }, 400)
    return reply({ ok: true, password }, 200)
  } catch {
    return reply({ error: 'No se pudo procesar la solicitud.' }, 400)
  }
})

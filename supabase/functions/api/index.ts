/**
 * Edge Function "api" — punto de entrada Deno de la API pública /api/v1.
 * URL: https://<project-ref>.supabase.co/functions/v1/api/v1/<recurso>
 * Desplegar con verify_jwt = false (la función hace su propia autenticación).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createApi, type DbPort } from '../_shared/app.ts'
import { DbError } from '../_shared/errors.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')
const API_JWT_SECRET = Deno.env.get('API_JWT_SECRET')

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY || !API_JWT_SECRET || API_JWT_SECRET.length < 32) {
  throw new Error('Configuración incompleta: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY y API_JWT_SECRET (>=32) son obligatorios')
}

const clientOptions = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
const service: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, clientOptions)

async function call<T>(client: SupabaseClient, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await client.rpc(fn, args)
  if (error) throw new DbError(error)
  return data as T
}

const db: DbPort = {
  rpc: (fn, args) => call(service, fn, args),
  rpcAsUser: (jwt, fn, args) => {
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      ...clientOptions,
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    })
    return call(userClient, fn, args)
  },
  async getAuthUserId(jwt) {
    const { data, error } = await service.auth.getUser(jwt)
    if (error || !data.user) return null
    return data.user.id
  },
}

const handle = createApi(db, {
  jwtSecret: API_JWT_SECRET,
  allowedOrigins: (Deno.env.get('API_ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  tokenTtlSeconds: Number(Deno.env.get('API_TOKEN_TTL_SECONDS') ?? '3600'),
})

Deno.serve(handle)

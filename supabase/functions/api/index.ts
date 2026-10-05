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

// Falla al arrancar (no en cada petición) si falta configuración. API_JWT_SECRET firma los access
// tokens HS256 de la API: se exigen ≥32 caracteres para que no sea atacable por fuerza bruta.
if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY || !API_JWT_SECRET || API_JWT_SECRET.length < 32) {
  throw new Error('Configuración incompleta: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY y API_JWT_SECRET (>=32) son obligatorios')
}

// Entorno servidor sin estado: ninguna sesión se guarda ni se refresca entre peticiones.
const clientOptions = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
/**
 * Cliente con service_role (salta RLS). Solo se usa para RPC diseñadas para la API, que reciben la
 * identidad de la integración ya autenticada y verifican scopes internamente. La clave nunca sale de aquí.
 */
const service: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, clientOptions)

/** Ejecuta una RPC y convierte el error de PostgREST en DbError (que luego traduce mapDbError). */
async function call<T>(client: SupabaseClient, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await client.rpc(fn, args)
  if (error) throw new DbError(error)
  return data as T
}

/** Implementación real del puerto de datos que consume createApi (en tests se sustituye por un doble). */
const db: DbPort = {
  rpc: (fn, args) => call(service, fn, args),
  // Cliente efímero por petición con la anon key + JWT del usuario: Postgres aplica RLS y los
  // permisos del propio usuario, exactamente igual que desde el frontend.
  rpcAsUser: (jwt, fn, args) => {
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      ...clientOptions,
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    })
    return call(userClient, fn, args)
  },
  async getAuthUserId(jwt) {
    // getUser consulta a Supabase Auth (valida firma, expiración y que la sesión siga vigente).
    const { data, error } = await service.auth.getUser(jwt)
    if (error || !data.user) return null
    return data.user.id
  },
}

const handle = createApi(db, {
  jwtSecret: API_JWT_SECRET,
  // Orígenes CORS permitidos, separados por comas ('*' = cualquiera; vacío = ninguno, solo servidor a servidor).
  allowedOrigins: (Deno.env.get('API_ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  // Vida de los access tokens emitidos por POST /v1/oauth/token (1 h por defecto).
  tokenTtlSeconds: Number(Deno.env.get('API_TOKEN_TTL_SECONDS') ?? '3600'),
})

Deno.serve(handle)

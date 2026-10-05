/** Configuración pública del frontend (solo variables VITE_*; nunca secretos). */
const env = import.meta.env

/**
 * Valores resueltos en tiempo de build por Vite. Todo lo que está aquí termina en el bundle
 * público, por eso solo se admite la anon/publishable key (ver validación al final del archivo).
 */
export const config = {
  supabaseUrl: (env.VITE_SUPABASE_URL ?? '').trim(),
  /** Clave pública de Supabase; la seguridad real la imponen RLS y las funciones RPC. */
  supabaseAnonKey: (env.VITE_SUPABASE_ANON_KEY ?? '').trim(),
  /** URL pública del sitio (contenido del QR y redirects de Auth). */
  publicAppUrl: ((env.VITE_PUBLIC_APP_URL ?? '').trim() || window.location.origin + import.meta.env.BASE_URL).replace(/\/+$/, ''),
  /** Prefijo de despliegue de Vite (BASE_URL), p. ej. la subruta de GitHub Pages. */
  basePath: import.meta.env.BASE_URL,
}

/** false si faltan variables de entorno: la app muestra una pantalla de configuración en vez de fallar. */
export const isConfigured = Boolean(config.supabaseUrl && config.supabaseAnonKey)

/** URL base de la API REST pública (Edge Function "api"). */
export const apiBaseUrl = config.supabaseUrl ? `${config.supabaseUrl.replace(/\/+$/, '')}/functions/v1/api` : ''

// Defensa: la service role key jamás debe llegar al navegador.
// Si alguien la configura por error, se aborta la carga del módulo (y por ende de la app)
// en lugar de publicar una clave que salta RLS y da acceso total a la base de datos.
if (config.supabaseAnonKey) {
  // Claves legacy (JWT): se decodifica el payload (sin verificar firma; solo interesa el claim role).
  try {
    const payload = JSON.parse(atob(config.supabaseAnonKey.split('.')[1] ?? ''))
    if (payload?.role === 'service_role') {
      throw new Error('VITE_SUPABASE_ANON_KEY contiene una service_role key. Nunca la exponga en el frontend.')
    }
  } catch (e) {
    // Solo se relanza nuestro propio error; un JWT malformado o una clave no-JWT se ignora aquí.
    if (e instanceof Error && e.message.includes('service_role')) throw e
  }
  // Claves nuevas de Supabase: las secretas llevan el prefijo sb_secret_ (las públicas, sb_publishable_).
  if (config.supabaseAnonKey.startsWith('sb_secret_')) {
    throw new Error('Se configuró una secret key de Supabase en el frontend. Use la publishable/anon key.')
  }
}

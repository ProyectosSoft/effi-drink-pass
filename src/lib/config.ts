/** Configuración pública del frontend (solo variables VITE_*; nunca secretos). */
const env = import.meta.env

export const config = {
  supabaseUrl: (env.VITE_SUPABASE_URL ?? '').trim(),
  supabaseAnonKey: (env.VITE_SUPABASE_ANON_KEY ?? '').trim(),
  /** URL pública del sitio (contenido del QR y redirects de Auth). */
  publicAppUrl: ((env.VITE_PUBLIC_APP_URL ?? '').trim() || window.location.origin + import.meta.env.BASE_URL).replace(/\/+$/, ''),
  basePath: import.meta.env.BASE_URL,
}

export const isConfigured = Boolean(config.supabaseUrl && config.supabaseAnonKey)

/** URL base de la API REST pública (Edge Function "api"). */
export const apiBaseUrl = config.supabaseUrl ? `${config.supabaseUrl.replace(/\/+$/, '')}/functions/v1/api` : ''

// Defensa: la service role key jamás debe llegar al navegador.
if (config.supabaseAnonKey) {
  try {
    const payload = JSON.parse(atob(config.supabaseAnonKey.split('.')[1] ?? ''))
    if (payload?.role === 'service_role') {
      throw new Error('VITE_SUPABASE_ANON_KEY contiene una service_role key. Nunca la exponga en el frontend.')
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes('service_role')) throw e
  }
  if (config.supabaseAnonKey.startsWith('sb_secret_')) {
    throw new Error('Se configuró una secret key de Supabase en el frontend. Use la publishable/anon key.')
  }
}

/**
 * Pantalla que se muestra en lugar de la app cuando faltan las variables públicas de Supabase
 * en el build. Explica cómo configurarlas en local y en GitHub Pages.
 */
export function ConfigMissing() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-4 p-6">
      <h1 className="text-2xl font-bold">Configuración pendiente</h1>
      <p className="text-muted">
        Faltan las variables públicas <code className="text-brand">VITE_SUPABASE_URL</code> y{' '}
        <code className="text-brand">VITE_SUPABASE_ANON_KEY</code>.
      </p>
      <ol className="list-decimal space-y-2 pl-5 text-sm text-muted">
        <li>Local: copie <code>.env.example</code> a <code>.env.local</code> y complete los valores.</li>
        <li>GitHub Pages: configure las <em>Repository variables</em> del mismo nombre y vuelva a ejecutar el workflow.</li>
        <li>Nunca use la <code>service_role</code> key en el frontend.</li>
      </ol>
      <p className="text-xs text-faint">Ver docs/DEPLOYMENT.md</p>
    </main>
  )
}

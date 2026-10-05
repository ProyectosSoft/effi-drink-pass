import { useEffect, useRef } from 'react'
import { Link } from 'react-router'
import SwaggerUIBundle from 'swagger-ui-dist/swagger-ui-es-bundle.js'
import 'swagger-ui-dist/swagger-ui.css'
import specUrl from '../../docs/openapi.yaml?url'
import { Logo } from '@/components/layout'
import { apiBaseUrl } from '@/lib/config'

/**
 * Documentación interactiva de la API (Swagger UI) a partir de docs/openapi.yaml.
 * Página pública: solo muestra la especificación; "Try it out" está desactivado y no se
 * persiste ninguna credencial en el navegador.
 */
export default function ApiDocs() {
  const ref = useRef<HTMLDivElement>(null)
  // Swagger UI se monta una sola vez sobre el nodo del ref (no es un componente React).
  useEffect(() => {
    if (!ref.current) return
    SwaggerUIBundle({
      domNode: ref.current,
      url: specUrl,
      deepLinking: true,
      tryItOutEnabled: false,
      persistAuthorization: false,
      requestInterceptor: (req: { url: string }) => {
        // Redirige el servidor de ejemplo al proyecto configurado.
        if (apiBaseUrl) req.url = req.url.replace(/^https:\/\/YOUR-PROJECT-REF\.supabase\.co\/functions\/v1\/api/, apiBaseUrl)
        return req
      },
    })
  }, [])
  return (
    <div className="min-h-dvh bg-white">
      <header className="flex items-center justify-between bg-bg px-4 py-3">
        <Logo />
        <Link to="/" className="text-sm text-muted hover:text-ink">Inicio</Link>
      </header>
      <div ref={ref} />
    </div>
  )
}

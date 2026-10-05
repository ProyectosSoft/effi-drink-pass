import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router'
import '@fontsource-variable/montserrat'
import './index.css'
import { App } from './App'
import { isConfigured } from './lib/config'
import { AuthProvider } from './lib/auth'
import { ToastProvider } from './components/ui'
import { ConfigMissing } from './pages/ConfigMissing'

/**
 * Caché de TanStack Query: un reintento ante fallos, refresco al volver a la pestaña y
 * datos considerados frescos durante 15 s para no repetir consultas al navegar.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 15_000 },
    // Las mutaciones nunca se reintentan automáticamente (el consumo usa Idempotency-Key explícita).
    mutations: { retry: 0 },
  },
})

// Punto de entrada. Orden de proveedores: caché de datos → router → toasts → sesión/permisos,
// de modo que AuthProvider y las páginas puedan usar todos los anteriores.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Sin variables de entorno no se monta nada que use Supabase: se muestra una guía de configuración. */}
    {isConfigured ? (
      <QueryClientProvider client={queryClient}>
        {/* basename sin barra final: permite servir la app bajo una subruta (GitHub Pages). */}
        <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <ToastProvider>
            <AuthProvider>
              <App />
            </AuthProvider>
          </ToastProvider>
        </BrowserRouter>
      </QueryClientProvider>
    ) : (
      <ConfigMissing />
    )}
  </StrictMode>,
)

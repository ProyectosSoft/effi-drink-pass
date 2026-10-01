import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router'
import './index.css'
import { App } from './App'
import { isConfigured } from './lib/config'
import { AuthProvider } from './lib/auth'
import { ToastProvider } from './components/ui'
import { ConfigMissing } from './pages/ConfigMissing'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 15_000 },
    // Las mutaciones nunca se reintentan automáticamente (el consumo usa Idempotency-Key explícita).
    mutations: { retry: 0 },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isConfigured ? (
      <QueryClientProvider client={queryClient}>
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

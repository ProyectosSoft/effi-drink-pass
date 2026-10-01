/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
  readonly VITE_PUBLIC_APP_URL?: string
  readonly VITE_BASE_PATH?: string
}

declare module 'swagger-ui-dist/swagger-ui-es-bundle.js' {
  const SwaggerUIBundle: (opts: Record<string, unknown>) => unknown
  export default SwaggerUIBundle
}

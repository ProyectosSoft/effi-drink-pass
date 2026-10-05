import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { copyFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

/** GitHub Pages no tiene rewrites: 404.html = index.html permite rutas del SPA (/admin/scanner, /qr/…). */
function spaFallback(): Plugin {
  let outDir = 'dist'
  return {
    name: 'spa-404-fallback',
    apply: 'build',
    configResolved(c) {
      outDir = c.build.outDir
    },
    closeBundle() {
      const index = resolve(outDir, 'index.html')
      if (existsSync(index)) copyFileSync(index, resolve(outDir, '404.html'))
    },
  }
}

/**
 * Content-Security-Policy por <meta> (GitHub Pages no permite cabeceras HTTP propias).
 * Segunda línea de defensa ante XSS: solo se ejecuta JavaScript del propio sitio y solo se
 * conecta a este origen y a Supabase, así un script inyectado no puede cargar código externo
 * ni enviar la sesión a otro servidor. Solo en build: el servidor de desarrollo usa scripts
 * inline y websockets para HMR.
 */
function contentSecurityPolicy(supabaseUrl: string): Plugin {
  let supabase = ''
  try {
    const u = new URL(supabaseUrl)
    supabase = `${u.origin} wss://${u.host}` // REST/RPC/Auth y Realtime
  } catch {
    /* sin URL configurada: solo 'self' */
  }
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'", // estilos en línea de Swagger UI y Recharts
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${supabase}`.trim(),
    "worker-src 'self' blob:", // service worker de la PWA y worker de qr-scanner
    "media-src 'self' blob:", // cámara del escáner
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ')
  return {
    name: 'content-security-policy',
    apply: 'build',
    transformIndexHtml: () => [
      { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: policy }, injectTo: 'head-prepend' },
    ],
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const base = env.VITE_BASE_PATH || '/'

  return {
    base,
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        '@shared': fileURLToPath(new URL('./supabase/functions/_shared', import.meta.url)),
      },
    },
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon.svg', 'apple-touch-icon-180x180.png'],
        manifest: {
          name: 'Effi Drink Pass — Feria Effix 2026',
          short_name: 'Drink Pass',
          description: 'Beneficios de bebidas de la Feria Effix 2026',
          lang: 'es-CO',
          theme_color: '#01121d',
          background_color: '#01121d',
          display: 'standalone',
          orientation: 'portrait',
          start_url: base,
          scope: base,
          icons: [
            { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
            { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
            { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
            { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          // Solo se precachea el "app shell". Las llamadas a Supabase NUNCA se cachean:
          // validar/consumir exige conexión (no hay consumo offline).
          globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
          globIgnores: ['**/ApiDocs-*', '**/swagger*', '**/montserrat-*cyrillic*', '**/montserrat-vietnamese*'],
          navigateFallback: `${base}index.html`,
          runtimeCaching: [],
          cleanupOutdatedCaches: true,
        },
      }),
      spaFallback(),
      contentSecurityPolicy(env.VITE_SUPABASE_URL ?? ''),
    ],
    build: {
      target: 'es2022',
      chunkSizeWarningLimit: 1600,
    },
  }
})

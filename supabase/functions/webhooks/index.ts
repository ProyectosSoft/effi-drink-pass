/**
 * Edge Function "webhooks" — despachador programado de webhooks salientes.
 * Se invoca cada minuto (pg_cron + pg_net, ver supabase/scripts/schedule_webhooks.sql) con
 *   Authorization: Bearer <WEBHOOK_DISPATCHER_SECRET>
 * Desplegar con --no-verify-jwt (usa su propio secreto).
 */
import { createClient } from '@supabase/supabase-js'
import { dispatchWebhooks, type Claimed } from '../_shared/webhooks.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const DISPATCHER_SECRET = Deno.env.get('WEBHOOK_DISPATCHER_SECRET')

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !DISPATCHER_SECRET || DISPATCHER_SECRET.length < 32) {
  throw new Error('Configuración incompleta: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY y WEBHOOK_DISPATCHER_SECRET (>=32) son obligatorios')
}

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

Deno.serve(async (req) => {
  const auth = req.headers.get('authorization') ?? ''
  if (req.method !== 'POST' || !safeEqual(auth, `Bearer ${DISPATCHER_SECRET}`)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } })
  }
  const summary = await dispatchWebhooks({
    async claim(limit, lease) {
      const { data, error } = await db.rpc('webhooks_claim', { p_limit: limit, p_lease_seconds: lease })
      if (error) throw new Error(error.message)
      return data as Claimed[]
    },
    async report(id, ok, status, err) {
      const { data, error } = await db.rpc('webhooks_report', { p_delivery_id: id, p_ok: ok, p_status_code: status, p_error: err })
      if (error) throw new Error(error.message)
      return data as string
    },
  })
  console.log(JSON.stringify({ level: 'info', fn: 'webhooks', ...summary }))
  return new Response(JSON.stringify(summary), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
})

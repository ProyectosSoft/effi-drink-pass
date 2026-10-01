/**
 * Despachador de webhooks salientes. Independiente del runtime (Deno / Node) para poder probarlo.
 *
 * Firma: X-EDP-Signature: t=<unix>,v1=<hex(HMAC-SHA256(secret, `${t}.${body}`))>
 * El receptor debe: recalcular la firma con el cuerpo crudo, comparar en tiempo constante,
 * rechazar timestamps con más de 5 minutos de diferencia y deduplicar por X-EDP-Delivery / data.consumption_id.
 */

export type Claimed = {
  delivery_id: number
  attempt: number
  url: string
  secret: string
  event_id: number
  event_type: string
  occurred_at: string
  payload: Record<string, unknown>
}

export interface WebhookDbPort {
  claim(limit: number, leaseSeconds: number): Promise<Claimed[]>
  report(deliveryId: number, ok: boolean, statusCode: number | null, error: string | null): Promise<string>
}

export type DispatchOptions = {
  fetchFn?: typeof fetch
  now?: () => Date
  batchSize?: number
  concurrency?: number
  timeoutMs?: number
  /** Presupuesto total de tiempo por ejecución (la función programada corre cada minuto). */
  budgetMs?: number
}

export type DispatchSummary = { claimed: number; delivered: number; retrying: number; failed: number }

const enc = new TextEncoder()

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function signWebhook(secret: string, timestamp: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${timestamp}.${body}`))
  return `t=${timestamp},v1=${hex(sig)}`
}

/** Verificación de referencia para receptores (también documentada en docs/INTEGRATIONS.md). */
export async function verifyWebhook(secret: string, header: string, body: string, nowSeconds: number, toleranceSeconds = 300): Promise<boolean> {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=', 2) as [string, string]))
  const t = Number(parts.t)
  if (!Number.isFinite(t) || Math.abs(nowSeconds - t) > toleranceSeconds || !parts.v1) return false
  const expected = (await signWebhook(secret, t, body)).split('v1=')[1]
  if (expected.length !== parts.v1.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ parts.v1.charCodeAt(i)
  return diff === 0
}

/** Defensa adicional en el despachador (la BD ya valida al crear la suscripción). */
export function isAllowedTarget(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  const host = u.hostname.toLowerCase()
  if (u.protocol !== 'https:' || u.username || u.password) return false
  if (/^[\d.]+$/.test(host) || host.startsWith('[') || host.includes(':')) return false
  if (host === 'localhost' || !host.includes('.') || /\.(local|internal|localhost|lan|home|corp)$/.test(host)) return false
  return true
}

export function webhookBody(c: Claimed): string {
  return JSON.stringify({ id: `evt_${c.event_id}`, type: c.event_type, created_at: c.occurred_at, data: c.payload })
}

async function deliverOne(c: Claimed, opts: Required<Pick<DispatchOptions, 'fetchFn' | 'now' | 'timeoutMs'>>): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  if (!isAllowedTarget(c.url)) return { ok: false, status: null, error: 'URL no permitida' }
  const body = webhookBody(c)
  const ts = Math.floor(opts.now().getTime() / 1000)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
  try {
    const res = await opts.fetchFn(c.url, {
      method: 'POST',
      redirect: 'manual', // no seguir redirecciones (evita desvíos a destinos internos)
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'EffiDrinkPass-Webhooks/1.0',
        'X-EDP-Event': c.event_type,
        'X-EDP-Delivery': String(c.delivery_id),
        'X-EDP-Attempt': String(c.attempt),
        'X-EDP-Signature': await signWebhook(c.secret, ts, body),
      },
      body,
    })
    // Consumir/descartar el cuerpo para liberar la conexión.
    await res.text().catch(() => '')
    const ok = res.status >= 200 && res.status < 300
    return { ok, status: res.status, error: ok ? null : `HTTP ${res.status}` }
  } catch (e) {
    const aborted = (e as { name?: string })?.name === 'AbortError'
    return { ok: false, status: null, error: aborted ? `timeout ${opts.timeoutMs} ms` : String((e as Error)?.message ?? e).slice(0, 300) }
  } finally {
    clearTimeout(timer)
  }
}

export async function dispatchWebhooks(db: WebhookDbPort, options: DispatchOptions = {}): Promise<DispatchSummary> {
  const opts = {
    fetchFn: options.fetchFn ?? fetch,
    now: options.now ?? (() => new Date()),
    batchSize: options.batchSize ?? 20,
    concurrency: options.concurrency ?? 5,
    timeoutMs: options.timeoutMs ?? 10_000,
    budgetMs: options.budgetMs ?? 25_000,
  }
  const started = Date.now()
  const summary: DispatchSummary = { claimed: 0, delivered: 0, retrying: 0, failed: 0 }

  while (Date.now() - started < opts.budgetMs) {
    const batch = await db.claim(opts.batchSize, Math.ceil(opts.timeoutMs / 1000) + 30)
    if (batch.length === 0) break
    summary.claimed += batch.length
    for (let i = 0; i < batch.length; i += opts.concurrency) {
      await Promise.all(batch.slice(i, i + opts.concurrency).map(async (c) => {
        const r = await deliverOne(c, opts)
        const status = await db.report(c.delivery_id, r.ok, r.status, r.error)
        if (status === 'delivered') summary.delivered++
        else if (status === 'failed') summary.failed++
        else summary.retrying++
      }))
    }
    if (batch.length < opts.batchSize) break
  }
  return summary
}

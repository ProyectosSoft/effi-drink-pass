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
  /** Resolvedor DNS para la protección SSRF (null = desactivada; por defecto Deno.resolveDns). */
  resolve?: ResolveFn | null
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

/**
 * Validación sintáctica del destino (la BD ya aplica una equivalente al crear la suscripción):
 * solo HTTPS, sin credenciales en la URL, sin IPs literales y sin nombres internos.
 * Se quitan los puntos finales del host ("localhost." === "localhost" para el resolvedor DNS).
 */
export function isAllowedTarget(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  const host = u.hostname.toLowerCase().replace(/\.+$/, '')
  if (u.protocol !== 'https:' || u.username || u.password) return false
  if (/^[\d.]+$/.test(host) || host.startsWith('[') || host.includes(':')) return false
  if (host === 'localhost' || !host.includes('.') || /\.(local|internal|localhost|lan|home|corp|arpa)$/.test(host)) return false
  return true
}

/** IPv4 en notación decimal → entero sin signo de 32 bits (null si no es IPv4 válida). */
function ipv4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return null
  const o = m.slice(1).map(Number)
  if (o.some((n) => n > 255)) return null
  return ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0
}

/** Rangos IPv4 no públicos: [red, bits de prefijo]. */
const BLOCKED_V4: [string, number][] = [
  ['0.0.0.0', 8], // "esta" red
  ['10.0.0.0', 8], // privada
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (metadatos de nube: 169.254.169.254)
  ['172.16.0.0', 12], // privada
  ['192.0.0.0', 24], // asignaciones IETF
  ['192.0.2.0', 24], // documentación
  ['192.168.0.0', 16], // privada
  ['198.18.0.0', 15], // pruebas de rendimiento
  ['198.51.100.0', 24], // documentación
  ['203.0.113.0', 24], // documentación
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reservada y broadcast
]

/**
 * true si la IP (v4 o v6) NO es enrutable públicamente: privada, loopback, link-local,
 * CGNAT, multicast, reservada o IPv4 embebida en IPv6 que apunte a alguno de esos rangos.
 */
export function isPrivateIp(ip: string): boolean {
  const v4 = ipv4ToInt(ip)
  if (v4 !== null) {
    return BLOCKED_V4.some(([net, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
      return ((v4 & mask) >>> 0) === ((ipv4ToInt(net)! & mask) >>> 0)
    })
  }
  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]
  if (!v6.includes(':')) return true // formato desconocido: se bloquea por seguridad
  // IPv4 mapeada/compatible/NAT64 (::ffff:a.b.c.d, ::a.b.c.d, 64:ff9b::a.b.c.d) → evaluar la IPv4.
  const embedded = v6.match(/(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (embedded) return isPrivateIp(embedded[1])
  if (v6 === '::' || v6 === '::1') return true // no especificada / loopback
  const first = parseInt(v6.split(':')[0] || '0', 16)
  if ((first & 0xfe00) === 0xfc00) return true // fc00::/7 ULA
  if ((first & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true // fec0::/10 site-local (obsoleta)
  if ((first & 0xff00) === 0xff00) return true // ff00::/8 multicast
  if (first === 0x0064 && v6.startsWith('64:ff9b:')) return true // NAT64 en forma hexadecimal
  if (first === 0x2001 && /^2001:0?db8:/.test(v6)) return true // documentación
  if (/^::ffff:/.test(v6)) return true // IPv4 mapeada en hexadecimal (::ffff:7f00:1)
  return false
}

/** Resolvedor DNS inyectable: devuelve las IPs (A y AAAA) de un nombre. */
export type ResolveFn = (host: string) => Promise<string[]>

/**
 * Resolvedor por defecto: Deno.resolveDns en el Edge Runtime. En otros runtimes (pruebas en Node)
 * no hay resolvedor y se devuelve null; ahí la protección queda en la validación sintáctica.
 */
function defaultResolver(): ResolveFn | null {
  const deno = (globalThis as { Deno?: { resolveDns?: (h: string, t: 'A' | 'AAAA') => Promise<string[]> } }).Deno
  if (typeof deno?.resolveDns !== 'function') return null
  const resolveDns = deno.resolveDns.bind(deno)
  return async (host) => {
    const [a, aaaa] = await Promise.allSettled([resolveDns(host, 'A'), resolveDns(host, 'AAAA')])
    return [...(a.status === 'fulfilled' ? a.value : []), ...(aaaa.status === 'fulfilled' ? aaaa.value : [])]
  }
}

/**
 * Protección SSRF: el nombre del destino debe resolver SOLO a IPs públicas.
 * Evita que una URL como https://169.254.169.254.nip.io o un dominio propio con registro A
 * hacia 10.x/127.x haga que el despachador llame a servicios internos de la plataforma.
 * Riesgo residual documentado: DNS rebinding entre esta consulta y la conexión de fetch.
 */
export async function resolvesToPublicIps(url: string, resolve: ResolveFn): Promise<boolean> {
  const host = new URL(url).hostname.toLowerCase().replace(/\.+$/, '')
  let ips: string[]
  try {
    ips = await resolve(host)
  } catch {
    return false
  }
  return ips.length > 0 && ips.every((ip) => !isPrivateIp(ip))
}

/** Cuerpo JSON del evento; se firma exactamente esta cadena. */
export function webhookBody(c: Claimed): string {
  return JSON.stringify({ id: `evt_${c.event_id}`, type: c.event_type, created_at: c.occurred_at, data: c.payload })
}

type DeliverOptions = Required<Pick<DispatchOptions, 'fetchFn' | 'now' | 'timeoutMs'>> & { resolve: ResolveFn | null }

/**
 * Entrega un evento a su URL y devuelve el resultado para reprogramar o cerrar la entrega.
 * Los mensajes de error son genéricos a propósito: se muestran al admin en el historial de
 * entregas y no deben servir como oráculo para explorar la red interna (puertos, hosts).
 */
async function deliverOne(c: Claimed, opts: DeliverOptions): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  if (!isAllowedTarget(c.url)) return { ok: false, status: null, error: 'URL no permitida' }
  if (opts.resolve && !(await resolvesToPublicIps(c.url, opts.resolve))) {
    return { ok: false, status: null, error: 'Destino no permitido o no resoluble' }
  }
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
    return { ok: false, status: null, error: aborted ? `timeout ${opts.timeoutMs} ms` : 'Error de conexión' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Toma lotes de entregas vencidas, las envía con concurrencia limitada y reporta cada resultado
 * hasta vaciar la cola o agotar el presupuesto de tiempo de esta ejecución.
 */
export async function dispatchWebhooks(db: WebhookDbPort, options: DispatchOptions = {}): Promise<DispatchSummary> {
  const opts = {
    resolve: options.resolve === undefined ? defaultResolver() : options.resolve,
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

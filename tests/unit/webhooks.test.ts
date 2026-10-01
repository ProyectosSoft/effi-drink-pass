import { describe, it, expect } from 'vitest'
import { dispatchWebhooks, isAllowedTarget, signWebhook, verifyWebhook, webhookBody, type Claimed, type WebhookDbPort } from '../../supabase/functions/_shared/webhooks.ts'

const claimed = (id: number, url = 'https://hooks.example.com/x'): Claimed => ({
  delivery_id: id, attempt: 1, url, secret: 'whsec_test_secret', event_id: 100 + id, event_type: 'benefit.consumed',
  occurred_at: '2026-10-16T15:00:00Z', payload: { consumption_id: `c-${id}`, effi_id: '123456' },
})

function fakeDb(batches: Claimed[][]) {
  const reports: { id: number; ok: boolean; status: number | null; error: string | null }[] = []
  const db: WebhookDbPort = {
    claim: async () => batches.shift() ?? [],
    report: async (id, ok, status, error) => {
      reports.push({ id, ok, status, error })
      return ok ? 'delivered' : 'pending'
    },
  }
  return { db, reports }
}

describe('firma de webhooks', () => {
  it('firma y verifica (con tolerancia de tiempo y comparación exacta)', async () => {
    const body = '{"a":1}'
    const h = await signWebhook('s3cret', 1_700_000_000, body)
    expect(h).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/)
    expect(await verifyWebhook('s3cret', h, body, 1_700_000_100)).toBe(true)
    expect(await verifyWebhook('otro', h, body, 1_700_000_100)).toBe(false)
    expect(await verifyWebhook('s3cret', h, '{"a":2}', 1_700_000_100)).toBe(false)
    expect(await verifyWebhook('s3cret', h, body, 1_700_001_000)).toBe(false) // > 5 min
  })

  it('solo destinos HTTPS públicos con nombre', () => {
    expect(isAllowedTarget('https://hooks.effi.example.com/drinkpass')).toBe(true)
    for (const bad of ['http://a.com', 'https://localhost/x', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://srv.internal', 'https://u:p@a.com', 'nope']) {
      expect(isAllowedTarget(bad)).toBe(false)
    }
  })
})

describe('despachador', () => {
  it('entrega con cabeceras firmadas y reporta el resultado de cada entrega', async () => {
    const { db, reports } = fakeDb([[claimed(1), claimed(2)]])
    const calls: { url: string; init: RequestInit }[] = []
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response('ok', { status: url.endsWith('/x') ? 200 : 500 })
    }) as unknown as typeof fetch
    const summary = await dispatchWebhooks(db, { fetchFn, now: () => new Date('2026-10-16T15:00:05Z') })
    expect(summary).toEqual({ claimed: 2, delivered: 2, retrying: 0, failed: 0 })
    const h = calls[0].init.headers as Record<string, string>
    expect(h['X-EDP-Event']).toBe('benefit.consumed')
    expect(h['X-EDP-Delivery']).toBe('1')
    expect(calls[0].init.redirect).toBe('manual')
    const body = calls[0].init.body as string
    expect(JSON.parse(body)).toEqual({ id: 'evt_101', type: 'benefit.consumed', created_at: '2026-10-16T15:00:00Z', data: { consumption_id: 'c-1', effi_id: '123456' } })
    expect(body).toBe(webhookBody(claimed(1)))
    expect(await verifyWebhook('whsec_test_secret', h['X-EDP-Signature'], body, 1_792_162_805)).toBe(true)
    expect(reports.map((r) => r.ok)).toEqual([true, true])
  })

  it('errores HTTP, de red y timeouts se reportan como fallos (reintento)', async () => {
    const { db, reports } = fakeDb([[claimed(1, 'https://a.example.com/500'), claimed(2, 'https://b.example.com/net'), claimed(3, 'https://c.example.com/slow'), claimed(4, 'http://insegura.example.com')]])
    const fetchFn = (async (url: string, init: RequestInit) => {
      if (url.includes('/500')) return new Response('err', { status: 500 })
      if (url.includes('/net')) throw new TypeError('connection refused')
      return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
    }) as unknown as typeof fetch
    const summary = await dispatchWebhooks(db, { fetchFn, timeoutMs: 50 })
    expect(summary.retrying).toBe(4)
    expect(reports.sort((a, b) => a.id - b.id).map((r) => [r.id, r.status, r.error])).toEqual([
      [1, 500, 'HTTP 500'], [2, null, 'connection refused'], [3, null, 'timeout 50 ms'], [4, null, 'URL no permitida'],
    ])
  })

  it('procesa varios lotes hasta vaciar la cola', async () => {
    const full = Array.from({ length: 3 }, (_, i) => claimed(i + 1))
    const { db } = fakeDb([full, [claimed(10)]])
    const fetchFn = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch
    const summary = await dispatchWebhooks(db, { fetchFn, batchSize: 3 })
    expect(summary).toEqual({ claimed: 4, delivered: 4, retrying: 0, failed: 0 })
  })
})

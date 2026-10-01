/**
 * Pruebas contra un proyecto Supabase REAL (staging, nunca producción).
 * Se ejecutan solo si existen las variables E2E_* (ver .env.example):
 *   E2E_API_BASE_URL, E2E_CLIENT_ID, E2E_CLIENT_SECRET, E2E_BENEFIT_ID (beneficio PENDING de HOY)
 * La credencial necesita benefits:redeem y benefits:read.
 *
 * Demuestra la garantía crítica: N consumos simultáneos del mismo beneficio → exactamente 1 APPROVED.
 */
import { describe, it, expect } from 'vitest'

const base = process.env.E2E_API_BASE_URL
const clientId = process.env.E2E_CLIENT_ID
const clientSecret = process.env.E2E_CLIENT_SECRET
const benefitId = process.env.E2E_BENEFIT_ID
const enabled = Boolean(base && clientId && clientSecret && benefitId)

describe.skipIf(!enabled)('concurrencia real contra Supabase', () => {
  it('30 consumos en paralelo del mismo beneficio → 1 APPROVED y 29 ALREADY_CONSUMED', async () => {
    const tokenRes = await fetch(`${base}/v1/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
    })
    expect(tokenRes.status).toBe(200)
    const { access_token } = await tokenRes.json()

    const attempts = await Promise.all(Array.from({ length: 30 }, (_, i) =>
      fetch(`${base}/v1/benefits/${benefitId}/redeem`, {
        method: 'POST',
        headers: { authorization: `Bearer ${access_token}`, 'content-type': 'application/json', 'idempotency-key': `concurrency-${Date.now()}-${i}` },
        body: '{}',
      }).then(async (r) => ({ status: r.status, body: await r.json() }))))

    const approved = attempts.filter((a) => a.status === 200)
    const already = attempts.filter((a) => a.status === 409)
    expect(approved).toHaveLength(1)
    expect(already).toHaveLength(29)

    const check = await fetch(`${base}/v1/benefits/${benefitId}`, { headers: { authorization: `Bearer ${access_token}` } })
    const b = await check.json()
    expect(b.data.status).toBe('CONSUMED')
  })
})

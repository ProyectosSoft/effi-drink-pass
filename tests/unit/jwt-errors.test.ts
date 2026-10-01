import { describe, it, expect } from 'vitest'
import { signJwt, verifyJwt, TOKEN_AUDIENCE, TOKEN_ISSUER, type AccessTokenClaims } from '../../supabase/functions/_shared/jwt.ts'
import { DbError, mapDbError, redeemStatus } from '../../supabase/functions/_shared/errors.ts'
import { normalizePath } from '../../supabase/functions/_shared/app.ts'

const SECRET = 'x'.repeat(40)
const claims = (over: Partial<AccessTokenClaims> = {}): AccessTokenClaims => ({
  iss: TOKEN_ISSUER, aud: TOKEN_AUDIENCE, sub: 'cred', cid: 'client', int: 'int', scope: 'a:b', iat: 1000, exp: 5000, jti: 'j', ...over,
})

describe('JWT HS256', () => {
  it('firma y verifica', async () => {
    const t = await signJwt(claims(), SECRET)
    const r = await verifyJwt(t, SECRET, 2000)
    expect(r.ok && r.claims.sub).toBe('cred')
  })

  it('rechaza expirado, otro secreto, otra audiencia y secretos cortos', async () => {
    const t = await signJwt(claims(), SECRET)
    expect(await verifyJwt(t, SECRET, 6000)).toEqual({ ok: false, reason: 'expired' })
    expect(await verifyJwt(t, 'y'.repeat(40), 2000)).toEqual({ ok: false, reason: 'signature' })
    expect(await verifyJwt(await signJwt(claims({ aud: 'otra' }), SECRET), SECRET, 2000)).toEqual({ ok: false, reason: 'claims' })
    await expect(signJwt(claims(), 'corto')).rejects.toThrow(/32/)
    expect(await verifyJwt('a.b', SECRET)).toEqual({ ok: false, reason: 'malformed' })
  })
})

describe('mapeo de errores', () => {
  it('traduce SQLSTATE a HTTP sin filtrar detalles internos', () => {
    expect(mapDbError(new DbError({ code: '42501', message: 'INSUFFICIENT_SCOPE', details: 'x:y' })).status).toBe(403)
    expect(mapDbError(new DbError({ code: 'P0002', message: 'NOT_FOUND' })).status).toBe(404)
    const conflict = mapDbError(new DbError({ code: '23505', message: 'dup', details: 'Key (effi_id)=(1) already exists.' }))
    expect([conflict.status, conflict.details]).toEqual([409, { field: 'effi_id' }])
    expect(mapDbError(new DbError({ code: '22023', message: 'UNKNOWN_EVENT_DAY' })).code).toBe('UNKNOWN_EVENT_DAY')
    expect(mapDbError(new DbError({ code: '22P02', message: 'invalid input syntax for type uuid' })).status).toBe(400)
    const internal = mapDbError(new DbError({ code: 'XX000', message: 'relation secret_table does not exist' }))
    expect([internal.status, internal.message]).toEqual([500, expect.not.stringContaining('secret_table')])
    expect(mapDbError(new Error('boom')).status).toBe(500)
  })

  it('códigos de consumo → HTTP', () => {
    expect([redeemStatus('APPROVED'), redeemStatus('ALREADY_CONSUMED'), redeemStatus('INVALID_QR'), redeemStatus('NOT_TODAY'),
      redeemStatus('EXPIRED'), redeemStatus('RATE_LIMITED')]).toEqual([200, 409, 404, 422, 422, 429])
  })

  it('normaliza la ruta de la Edge Function', () => {
    expect(normalizePath('/functions/v1/api/v1/health')).toBe('/v1/health')
    expect(normalizePath('/api/v1/attendees')).toBe('/v1/attendees')
    expect(normalizePath('/v1/x')).toBe('/v1/x')
    expect(normalizePath('/api')).toBe('/')
  })
})

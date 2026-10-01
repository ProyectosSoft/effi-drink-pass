import { describe, it, expect } from 'vitest'
import { extractToken, qrPayload, TOKEN_PATTERN } from '../../supabase/functions/_shared/qr.ts'

const T = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde'.slice(0, 43)

describe('QR: contenido y extracción de token', () => {
  it('el token de ejemplo cumple el formato', () => {
    expect(T).toHaveLength(43)
    expect(TOKEN_PATTERN.test(T)).toBe(true)
  })

  it('el payload del QR es solo una URL con el token (sin datos personales)', () => {
    const p = qrPayload('https://drinkpass.example.com/', T)
    expect(p).toBe(`https://drinkpass.example.com/qr/${T}`)
    expect(p).not.toMatch(/@|effi_id|nombre/i)
  })

  it('extrae el token de token crudo, URL /qr/ y URL /r/ (con querystring)', () => {
    expect(extractToken(T)).toBe(T)
    expect(extractToken(`  ${T}\n`)).toBe(T)
    expect(extractToken(`https://x.com/qr/${T}`)).toBe(T)
    expect(extractToken(`https://x.com/app/r/${T}?utm=1`)).toBe(T)
  })

  it('rechaza contenidos que no son tokens', () => {
    for (const bad of ['', null, undefined, 'hola', `${T}x`, `https://x.com/qr/${T.slice(1)}`, 'WIFI:S:red;P:clave;;', 'x'.repeat(600)]) {
      expect(extractToken(bad as string)).toBeNull()
    }
  })
})

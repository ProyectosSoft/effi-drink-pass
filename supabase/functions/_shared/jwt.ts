/**
 * JWT HS256 mínimo sobre WebCrypto (disponible en Deno, navegadores y Node ≥ 20).
 * Se usa para los access tokens OAuth2 client_credentials de integraciones.
 */
export const TOKEN_ISSUER = 'effi-drink-pass'
export const TOKEN_AUDIENCE = 'effi-drink-pass-api'

export type AccessTokenClaims = {
  iss: string
  aud: string
  sub: string // credential_id
  cid: string // client_id
  int: string // integration_id
  scope: string // separados por espacio
  iat: number
  exp: number
  jti: string
}

const enc = new TextEncoder()

export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(input: string): Uint8Array {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (input.length % 4)) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

export async function signJwt(claims: AccessTokenClaims, secret: string): Promise<string> {
  if (secret.length < 32) throw new Error('API_JWT_SECRET debe tener al menos 32 caracteres')
  const header = base64UrlEncode(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const payload = base64UrlEncode(enc.encode(JSON.stringify(claims)))
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(`${header}.${payload}`))
  return `${header}.${payload}.${base64UrlEncode(new Uint8Array(sig))}`
}

/** Lee el payload SIN verificar (solo para decidir qué verificador aplicar). */
export function peekJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])))
  } catch {
    return null
  }
}

export type VerifyResult = { ok: true; claims: AccessTokenClaims } | { ok: false; reason: 'malformed' | 'signature' | 'expired' | 'claims' }

/**
 * Verifica firma, algoritmo, emisor, audiencia y expiración de un access token propio.
 * Nunca lanza: cualquier token mal formado devuelve { ok: false } (→ 401, no 500).
 */
export async function verifyJwt(token: string, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<VerifyResult> {
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'malformed' }
  let header: { alg?: string }
  let claims: AccessTokenClaims
  let signature: Uint8Array
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0])))
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])))
    // La firma también se decodifica aquí: un base64 inválido debe ser 'malformed', no una excepción.
    signature = base64UrlDecode(parts[2])
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (!header || typeof header !== 'object' || !claims || typeof claims !== 'object') return { ok: false, reason: 'malformed' }
  // Solo HS256: evita ataques de confusión de algoritmo ("alg": "none", RS/HS).
  if (header.alg !== 'HS256') return { ok: false, reason: 'malformed' }
  // crypto.subtle.verify compara en tiempo constante.
  const valid = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(secret),
    signature as BufferSource,
    enc.encode(`${parts[0]}.${parts[1]}`),
  )
  if (!valid) return { ok: false, reason: 'signature' }
  if (claims.iss !== TOKEN_ISSUER || claims.aud !== TOKEN_AUDIENCE || typeof claims.sub !== 'string') {
    return { ok: false, reason: 'claims' }
  }
  if (typeof claims.exp !== 'number' || claims.exp <= nowSeconds) return { ok: false, reason: 'expired' }
  return { ok: true, claims }
}

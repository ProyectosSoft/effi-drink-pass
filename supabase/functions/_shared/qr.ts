/**
 * Utilidades del contenido del QR. Compartido entre la Edge Function y el frontend.
 * El QR contiene SOLO un token opaco (o una URL …/qr/<token>): nunca datos personales.
 */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

/** Extrae el token de lo leído por la cámara: token crudo o URL que termine en /qr/<token> o /r/<token>. */
export function extractToken(raw: string | null | undefined): string | null {
  if (!raw) return null
  const text = raw.trim()
  if (text.length > 500) return null
  if (TOKEN_PATTERN.test(text)) return text
  const match = text.match(/\/(?:qr|r)\/([A-Za-z0-9_-]{43})(?:[/?#].*)?$/)
  return match ? match[1] : null
}

/** Construye el contenido del QR. baseUrl sin barra final, p. ej. https://drinkpass.example.com */
export function qrPayload(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/qr/${token}`
}

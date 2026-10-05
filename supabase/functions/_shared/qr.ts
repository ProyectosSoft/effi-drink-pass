/**
 * Utilidades del contenido del QR. Compartido entre la Edge Function y el frontend.
 * El QR contiene SOLO un token opaco (o una URL …/qr/<token>): nunca datos personales.
 */
/** Token = 32 bytes aleatorios en base64url sin relleno (43 caracteres). */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

/**
 * Extrae el token de lo leído por la cámara: token crudo o URL que termine en /qr/<token> o /r/<token>.
 * Seguridad: valida el formato exacto antes de enviarlo al servidor, de modo que contenido arbitrario
 * de un QR (texto, scripts, URLs ajenas) se descarta. No se valida el dominio de la URL: lo que
 * autoriza el canje es el token, que el servidor busca por su hash.
 */
export function extractToken(raw: string | null | undefined): string | null {
  if (!raw) return null
  const text = raw.trim()
  // Límite de longitud antes de aplicar regex sobre entrada no confiable.
  if (text.length > 500) return null
  if (TOKEN_PATTERN.test(text)) return text
  const match = text.match(/\/(?:qr|r)\/([A-Za-z0-9_-]{43})(?:[/?#].*)?$/)
  return match ? match[1] : null
}

/** Construye el contenido del QR. baseUrl sin barra final, p. ej. https://drinkpass.example.com */
export function qrPayload(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/qr/${token}`
}

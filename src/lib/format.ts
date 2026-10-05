/** Formateo de fechas siempre en la zona horaria del evento (America/Bogota). */
const TZ = 'America/Bogota'

const dateTimeFmt = new Intl.DateTimeFormat('es-CO', {
  timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
})
const timeFmt = new Intl.DateTimeFormat('es-CO', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
// Las fechas calendario ('YYYY-MM-DD') se formatean en UTC a propósito: no representan un instante,
// así que no deben desplazarse por la zona horaria (ver fmtEventDate).
const longDay = new Intl.DateTimeFormat('es-CO', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' })

/** Timestamp ISO → '16 oct, 14:30' en hora de Bogotá; '—' si no hay valor. */
export function fmtDateTime(v?: string | null): string {
  return v ? dateTimeFmt.format(new Date(v)) : '—'
}

/** Timestamp ISO → 'HH:MM:SS' en hora de Bogotá; '—' si no hay valor. */
export function fmtTime(v?: string | null): string {
  return v ? timeFmt.format(new Date(v)) : '—'
}

/** '2026-10-16' → 'viernes, 16 de octubre' (fecha calendario, sin desplazamiento de zona). */
export function fmtEventDate(isoDate?: string | null): string {
  if (!isoDate) return '—'
  // Mediodía UTC: margen de ±12 h para que el día nunca cambie, incluso si se alterara la zona.
  const s = longDay.format(new Date(`${isoDate}T12:00:00Z`))
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** '08:00:00' → '08:00' */
export function hhmm(t?: string | null): string {
  return t ? t.slice(0, 5) : '—'
}

/** Une nombres y apellidos omitiendo los vacíos; '—' si no hay ninguno. */
export function fullName(p?: { nombres?: string | null; apellidos?: string | null } | null): string {
  return [p?.nombres, p?.apellidos].filter(Boolean).join(' ') || '—'
}

/** Número con separadores de miles colombianos (1.234); null/undefined se muestran como 0. */
export function num(n?: number | null): string {
  return new Intl.NumberFormat('es-CO').format(n ?? 0)
}

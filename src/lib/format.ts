/** Formateo de fechas siempre en la zona horaria del evento (America/Bogota). */
export const TZ = 'America/Bogota'

const dateFmt = new Intl.DateTimeFormat('es-CO', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric' })
const dateTimeFmt = new Intl.DateTimeFormat('es-CO', {
  timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
})
const timeFmt = new Intl.DateTimeFormat('es-CO', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
const longDay = new Intl.DateTimeFormat('es-CO', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' })

export function fmtDate(v?: string | null): string {
  return v ? dateFmt.format(new Date(v)) : '—'
}

export function fmtDateTime(v?: string | null): string {
  return v ? dateTimeFmt.format(new Date(v)) : '—'
}

export function fmtTime(v?: string | null): string {
  return v ? timeFmt.format(new Date(v)) : '—'
}

/** '2026-10-16' → 'viernes, 16 de octubre' (fecha calendario, sin desplazamiento de zona). */
export function fmtEventDate(isoDate?: string | null): string {
  if (!isoDate) return '—'
  const s = longDay.format(new Date(`${isoDate}T12:00:00Z`))
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** '08:00:00' → '08:00' */
export function hhmm(t?: string | null): string {
  return t ? t.slice(0, 5) : '—'
}

export function fullName(p?: { nombres?: string | null; apellidos?: string | null } | null): string {
  return [p?.nombres, p?.apellidos].filter(Boolean).join(' ') || '—'
}

export function num(n?: number | null): string {
  return new Intl.NumberFormat('es-CO').format(n ?? 0)
}

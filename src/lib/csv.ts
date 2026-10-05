/** Exportación CSV (UTF-8 con BOM para que Excel respete tildes). */

/**
 * Neutraliza inyección de fórmulas en Excel/Sheets (=, +, -, @ al inicio).
 * Seguridad: los datos exportados vienen de usuarios/importaciones (nombres, empresa, metadata);
 * sin esto, una celda como `=HYPERLINK(...)` se ejecutaría al abrir el CSV (CSV injection).
 * Además aplica el escapado RFC 4180 (comillas dobles) cuando el valor contiene separadores.
 */
function sanitizeCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  // Objetos (p. ej. metadata JSONB) se serializan para no exportar "[object Object]".
  let s = typeof value === 'object' ? JSON.stringify(value) : String(value)
  // El apóstrofo inicial obliga a la hoja de cálculo a tratar la celda como texto literal.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  // Se incluye ';' porque Excel en español lo usa como separador al abrir CSV.
  if (/[",\n\r;]/.test(s)) s = `"${s.replace(/"/g, '""')}"`
  return s
}

/**
 * Serializa filas a CSV (separador coma, fin de línea CRLF).
 * Si no se indican columnas, se usa la unión de las claves de todas las filas en orden de aparición.
 */
export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  const cols = columns ?? Array.from(rows.reduce((set, r) => {
    Object.keys(r).forEach((k) => set.add(k))
    return set
  }, new Set<string>()))
  const lines = [cols.map(sanitizeCell).join(',')]
  for (const r of rows) lines.push(cols.map((c) => sanitizeCell(r[c])).join(','))
  return lines.join('\r\n')
}

/** Genera el CSV en memoria y dispara su descarga en el navegador mediante un enlace temporal. */
export function downloadCsv(filename: string, rows: Record<string, unknown>[], columns?: string[]) {
  const blob = new Blob(['﻿' + toCsv(rows, columns)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revocación diferida: algunos navegadores aún no inician la descarga cuando click() retorna.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Exportación CSV (UTF-8 con BOM para que Excel respete tildes). */

/** Neutraliza inyección de fórmulas en Excel/Sheets (=, +, -, @ al inicio). */
function sanitizeCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  let s = typeof value === 'object' ? JSON.stringify(value) : String(value)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  if (/[",\n\r;]/.test(s)) s = `"${s.replace(/"/g, '""')}"`
  return s
}

export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  const cols = columns ?? Array.from(rows.reduce((set, r) => {
    Object.keys(r).forEach((k) => set.add(k))
    return set
  }, new Set<string>()))
  const lines = [cols.map(sanitizeCell).join(',')]
  for (const r of rows) lines.push(cols.map((c) => sanitizeCell(r[c])).join(','))
  return lines.join('\r\n')
}

export function downloadCsv(filename: string, rows: Record<string, unknown>[], columns?: string[]) {
  const blob = new Blob(['﻿' + toCsv(rows, columns)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

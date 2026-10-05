/**
 * Lectura y validación de archivos de asistentes (CSV / XLSX) en el navegador.
 * El servidor vuelve a validar todo (import_attendees); esta capa da la previsualización.
 */
/** Campos del asistente que se pueden importar (el orden define la prioridad del mapeo automático). */
export const IMPORT_FIELDS = ['nombres', 'apellidos', 'email', 'telefono', 'effi_id', 'effi_username', 'tipo_acceso', 'empresa'] as const
export type ImportField = (typeof IMPORT_FIELDS)[number]
/** Fila ya mapeada; `row` es el número de fila en la hoja original (para reportar errores). */
export type ImportRow = { row: number } & Partial<Record<ImportField, string>>
/** Resultado de validar una fila: los errores bloquean su importación, las advertencias no. */
export type RowCheck = { row: number; errors: string[]; warnings: string[] }

/** Encabezados habituales (español/inglés, sin tildes) reconocidos para cada campo. */
const SYNONYMS: Record<ImportField, string[]> = {
  nombres: ['nombres', 'nombre', 'first name', 'firstname', 'name', 'primer nombre'],
  apellidos: ['apellidos', 'apellido', 'last name', 'lastname', 'surname'],
  email: ['email', 'correo', 'correo electronico', 'e-mail', 'mail'],
  telefono: ['telefono', 'celular', 'movil', 'phone', 'tel', 'whatsapp'],
  effi_id: ['effi_id', 'id effi', 'id_effi', 'effi id', 'ideffi'],
  effi_username: ['effi_username', 'usuario effi', 'usuario_effi', 'effi user', 'username', 'usuario'],
  tipo_acceso: ['tipo_acceso', 'tipo de acceso', 'acceso', 'tipo', 'categoria', 'ticket', 'access type'],
  empresa: ['empresa', 'compania', 'company', 'organizacion', 'organization'],
}

/**
 * Normaliza un encabezado para compararlo: quita tildes (NFD + marcas diacríticas),
 * pasa a minúsculas, elimina símbolos y unifica espacios/guiones. 'Correo Electrónico' → 'correo electronico'.
 */
export function normalizeHeader(h: string): string {
  return h.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9_ -]/g, '').replace(/[\s-]+/g, ' ').trim()
}

/** Propone un mapeo encabezado del archivo → campo del sistema. */
export function suggestMapping(headers: string[]): Record<string, ImportField | ''> {
  const used = new Set<ImportField>()
  const out: Record<string, ImportField | ''> = {}
  for (const h of headers) {
    const n = normalizeHeader(h)
    // Cada campo se asigna como máximo a un encabezado (el primero que coincida); se compara
    // tratando espacio y '_' como equivalentes ('effi id' ≡ 'effi_id').
    const match = IMPORT_FIELDS.find((f) => !used.has(f) && SYNONYMS[f].some((s) => normalizeHeader(s) === n || normalizeHeader(s).replace(/ /g, '_') === n.replace(/ /g, '_')))
    out[h] = match ?? ''
    if (match) used.add(match)
  }
  return out
}

/** Aplica el mapeo a las filas crudas (fila 1 = encabezados; los datos empiezan en la fila 2). */
export function applyMapping(raw: Record<string, unknown>[], mapping: Record<string, ImportField | ''>): ImportRow[] {
  return raw
    .map((r, i) => {
      const row: ImportRow = { row: i + 2 }
      for (const [header, field] of Object.entries(mapping)) {
        if (!field) continue
        const v = r[header]
        const s = v === null || v === undefined ? '' : String(v).trim()
        if (s) row[field] = s
      }
      return row
    })
    // Descarta filas sin ningún valor mapeado (filas en blanco o solo con columnas ignoradas).
    .filter((r) => IMPORT_FIELDS.some((f) => r[f]))
}

// Reflejan los CHECK de la tabla attendees (mismos límites de longitud y expresiones).
/** Validación de email deliberadamente laxa: algo@dominio.tld, sin espacios (igual que el CHECK SQL). */
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
/**
 * tipo_acceso: 1–40 caracteres alfanuméricos, espacio, '_' o '-', empezando por alfanumérico.
 * Acepta minúsculas porque el servidor lo normaliza con upper() antes de guardarlo.
 */
const TIPO = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/

/** Validación local (formato + duplicados dentro del archivo completo). */
export function validateRows(rows: ImportRow[]): RowCheck[] {
  const seen = new Map<string, number>()
  return rows.map((r) => {
    const errors: string[] = []
    const warnings: string[] = []
    if (!r.nombres) errors.push('nombres es obligatorio')
    else if (r.nombres.length > 120) errors.push('nombres excede 120 caracteres')
    if ((r.apellidos?.length ?? 0) > 120) errors.push('apellidos excede 120 caracteres')
    if (r.email && (!EMAIL.test(r.email) || r.email.length > 254)) errors.push('email inválido')
    if (r.tipo_acceso && !TIPO.test(r.tipo_acceso)) errors.push('tipo_acceso inválido')
    if ((r.effi_id?.length ?? 0) > 64) errors.push('effi_id excede 64 caracteres')
    if ((r.telefono?.length ?? 0) > 40) errors.push('telefono excede 40 caracteres')
    if ((r.empresa?.length ?? 0) > 200) errors.push('empresa excede 200 caracteres')
    if (!r.email) warnings.push('sin email: no podrá iniciar sesión')
    // Identificadores únicos: email y usuario se comparan sin distinguir mayúsculas (como los índices lower() del servidor).
    for (const [kind, value] of [['effi_id', r.effi_id], ['email', r.email?.toLowerCase()], ['effi_username', r.effi_username?.toLowerCase()]] as const) {
      if (!value) continue
      const key = `${kind}:${value}`
      const first = seen.get(key)
      if (first !== undefined) errors.push(`duplicado en el archivo (${kind} igual a la fila ${first})`)
      else seen.set(key, r.row)
    }
    return { row: r.row, errors, warnings }
  })
}

/** Divide un arreglo en lotes de `size` elementos (la importación se envía por lotes al servidor). */
export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// Límites para no bloquear ni agotar la memoria del navegador con archivos gigantes o maliciosos.
const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_ROWS = 20000

/** Lee CSV o XLSX a filas {encabezado: valor}. Carga perezosa de los parsers. */
export async function readSpreadsheet(file: File): Promise<{ headers: string[]; rows: Record<string, unknown>[] }> {
  if (file.size > MAX_FILE_BYTES) throw new Error('El archivo supera 5 MB.')
  const name = file.name.toLowerCase()
  if (name.endsWith('.csv') || name.endsWith('.txt') || file.type === 'text/csv') {
    const Papa = (await import('papaparse')).default
    const text = await file.text()
    // Se quita el BOM UTF-8 que agrega Excel para que no contamine el primer encabezado.
    const res = Papa.parse<Record<string, unknown>>(text.replace(/^﻿/, ''), {
      header: true, skipEmptyLines: 'greedy', transformHeader: (h) => h.trim(),
      // Detecta ; (Excel en español) o ,
      delimitersToGuess: [',', ';', '\t', '|'],
    })
    // Errores parciales (p. ej. filas con columnas de más) se toleran; solo se aborta si no hay datos.
    if (res.errors.length && res.data.length === 0) throw new Error(`CSV inválido: ${res.errors[0].message}`)
    const headers = (res.meta.fields ?? []).filter(Boolean)
    if (res.data.length > MAX_ROWS) throw new Error(`Máximo ${MAX_ROWS} filas por archivo.`)
    return { headers, rows: res.data }
  }
  if (name.endsWith('.xlsx')) {
    const { readSheet } = await import('read-excel-file/browser')
    // Primera hoja del libro; celdas como valores simples (texto, número, fecha, booleano).
    const sheet = (await readSheet(file)) as unknown as unknown[][]
    if (sheet.length === 0) return { headers: [], rows: [] }
    const headers = sheet[0].map((h) => String(h ?? '').trim())
    if (sheet.length - 1 > MAX_ROWS) throw new Error(`Máximo ${MAX_ROWS} filas por archivo.`)
    const rows = sheet.slice(1).map((line) => Object.fromEntries(headers.map((h, i) => [h, line[i] ?? ''])))
    return { headers: headers.filter(Boolean), rows }
  }
  throw new Error('Formato no soportado. Use .csv o .xlsx')
}

/** Plantilla descargable con los encabezados esperados y una fila de ejemplo. */
export const TEMPLATE_CSV = 'nombres,apellidos,email,telefono,effi_id,effi_username,tipo_acceso,empresa\r\nJuan,Pérez,juan.perez@ejemplo.com,3001234567,123456,juan.perez,GENERAL,Mi Empresa SAS\r\n'

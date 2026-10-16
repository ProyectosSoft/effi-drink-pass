import { normalizeHeader } from './importParser'

export type CompanyInput = { effi_id: string; name: string; email?: string; identification?: string; user_count: number; active?: boolean }
const fields: Record<string, string[]> = {
  effi_id: ['effi_id', 'ID', 'ID Effi'],
  name: ['name', 'nombre fiscal', 'empresa', 'razon social'],
  identification: ['identification', 'identificación', 'nit', 'documento'],
  email: ['email', 'correo', 'correo electronico'],
  user_count: ['user_count', 'cantidad usuario', 'cantidad usuarios', 'cantidad de usuarios'],
}

/** Una fila por empresa. Un dato vacío significa una bebida; un texto inválido nunca se adivina. */
export function parseCompanies(rows: Record<string, unknown>[]) {
  const errors: string[] = []
  const companies: CompanyInput[] = []
  let defaults = 0
  const ids = new Set<string>(), emails = new Set<string>()
  for (const [i, row] of rows.entries()) {
    const get = (field: string) => {
      const key = Object.keys(row).find((k) => fields[field].some((alias) => normalizeHeader(alias) === normalizeHeader(k)))
      return String(key ? row[key] ?? '' : '').trim()
    }
    const effi_id = get('effi_id'), name = get('name'), email = get('email').toLowerCase(), raw = get('user_count'), identification = get('identification')
    if (!effi_id && !name && !email && !raw && !identification) continue
    const countMatch = raw.match(/^(\d+)(?:\s+usuarios?)?$/i)
    const user_count = raw === '' ? 1 : countMatch ? Number(countMatch[1]) : NaN
    const issues: string[] = []
    if (!effi_id || effi_id.length > 64) issues.push('ID Effi obligatorio, máximo 64 caracteres')
    if (!name || name.length > 200) issues.push('nombre fiscal obligatorio, máximo 200 caracteres')
    if (identification && (identification.length > 64 || !/^[a-zA-Z0-9.\s-]+$/.test(identification) || !identification.replace(/[.\s-]/g, ''))) issues.push('identificación inválida')
    if (email && (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254)) issues.push('correo inválido')
    if (!Number.isInteger(user_count) || user_count < 1 || user_count > 100000) issues.push('cantidad de usuarios inválida (1 a 100000)')
    if (ids.has(effi_id)) issues.push('ID Effi duplicado')
    if (email && emails.has(email)) issues.push('correo duplicado')
    ids.add(effi_id); if (email) emails.add(email)
    if (issues.length) errors.push(`Fila ${i + 2}: ${issues.join('; ')}`)
    else {
      if (raw === '') defaults++
      companies.push({ effi_id, name, email: email || undefined, identification: identification || undefined, user_count })
    }
  }
  return { companies, errors, defaults }
}

export const COMPANY_TEMPLATE = 'ID,Nombre fiscal,Identificación,CANTIDAD USUARIO\r\n001,Empresa de ejemplo,901173460-5,4\r\n'

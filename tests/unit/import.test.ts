import { describe, it, expect } from 'vitest'
import { applyMapping, chunk, normalizeHeader, suggestMapping, validateRows } from '@/lib/importParser'

describe('importación: mapeo de columnas', () => {
  it('normaliza tildes, mayúsculas y separadores', () => {
    expect(normalizeHeader('  Teléfono ')).toBe('telefono')
    expect(normalizeHeader('Correo-Electrónico')).toBe('correo electronico')
  })

  it('sugiere el mapeo con sinónimos en español e inglés', () => {
    const m = suggestMapping(['Nombre', 'Apellidos', 'Correo', 'Celular', 'ID Effi', 'Usuario Effi', 'Tipo de acceso', 'Compañía', 'Otra'])
    expect(m).toEqual({
      Nombre: 'nombres', Apellidos: 'apellidos', Correo: 'email', Celular: 'telefono', 'ID Effi': 'effi_id',
      'Usuario Effi': 'effi_username', 'Tipo de acceso': 'tipo_acceso', 'Compañía': 'empresa', Otra: '',
    })
  })

  it('no asigna el mismo campo dos veces', () => {
    const m = suggestMapping(['email', 'correo'])
    expect(m).toEqual({ email: 'email', correo: '' })
  })

  it('aplica el mapeo, recorta y descarta filas vacías; numera desde la fila 2', () => {
    const rows = applyMapping(
      [{ N: ' Ana ', E: 'ana@x.co', Z: 'ignorado' }, { N: '', E: '' }, { N: 'Beto', E: 123 }],
      { N: 'nombres', E: 'email', Z: '' },
    )
    expect(rows).toEqual([{ row: 2, nombres: 'Ana', email: 'ana@x.co' }, { row: 4, nombres: 'Beto', email: '123' }])
  })
})

describe('importación: validación local', () => {
  it('detecta obligatorios, formatos y duplicados dentro del archivo', () => {
    const checks = validateRows([
      { row: 2, nombres: 'Ana', email: 'ana@x.co', effi_id: '1' },
      { row: 3, email: 'sin-nombre@x.co' },
      { row: 4, nombres: 'Dup', email: 'ANA@x.co' },
      { row: 5, nombres: 'Dup2', effi_id: '1' },
      { row: 6, nombres: 'Mal', email: 'mal@', tipo_acceso: 'vip!' },
      { row: 7, nombres: 'Sin email' },
    ])
    expect(checks[0].errors).toEqual([])
    expect(checks[1].errors).toContain('nombres es obligatorio')
    expect(checks[2].errors[0]).toMatch(/duplicado en el archivo \(email igual a la fila 2\)/)
    expect(checks[3].errors[0]).toMatch(/effi_id igual a la fila 2/)
    expect(checks[4].errors).toEqual(expect.arrayContaining(['email inválido', 'tipo_acceso inválido']))
    expect(checks[5].warnings[0]).toMatch(/sin email/)
  })

  it('divide en lotes', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })
})

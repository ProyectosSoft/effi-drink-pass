import { describe, expect, it } from 'vitest'
import { parseCompanies } from '../../src/lib/companyImport'

describe('archivo de empresas y cantidad de usuarios', () => {
  it('mapea el reporte fiscal y admite texto como 4 usuarios; vacíos son uno', () => {
    const result = parseCompanies([
      { ID: '001', 'Nombre fiscal': 'Empresa A', 'CANTIDAD USUARIO ': '4 usuarios' },
      { ID: '002', 'Nombre fiscal': 'Empresa B', 'CANTIDAD USUARIO ': '' },
    ])
    expect(result.errors).toEqual([])
    expect(result.defaults).toBe(1)
    expect(result.companies.map((c) => [c.effi_id, c.user_count])).toEqual([['001', 4], ['002', 1]])
  })
  it('no convierte cantidades inválidas, ilimitadas, negativas o decimales en cupos', () => {
    for (const value of ['ilimitado', '-1', '1.5', '0', '100001', '2e3']) {
      expect(parseCompanies([{ effi_id: '1', name: 'Empresa', user_count: value }]).errors.length).toBe(1)
    }
  })
  it('detecta IDs y correos duplicados en todo el archivo, sin ignorar filas erróneas', () => {
    const result = parseCompanies([{ effi_id: '1', name: 'Uno', email: 'a@b.co' }, { effi_id: '1', name: 'Dos', email: 'A@B.CO' }])
    expect(result.errors[0]).toMatch(/ID Effi duplicado/)
    expect(result.errors[0]).toMatch(/correo duplicado/)
  })
})

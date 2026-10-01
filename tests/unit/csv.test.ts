import { describe, it, expect } from 'vitest'
import { toCsv } from '@/lib/csv'

describe('exportación CSV', () => {
  it('escapa comas, comillas y saltos de línea', () => {
    expect(toCsv([{ a: 'x,y', b: 'di "hola"', c: 'l1\nl2' }])).toBe('a,b,c\r\n"x,y","di ""hola""","l1\nl2"')
  })

  it('neutraliza inyección de fórmulas (=, +, -, @)', () => {
    const csv = toCsv([{ a: '=HYPERLINK("http://evil")', b: '+1', c: '-2', d: '@SUM(A1)' }])
    expect(csv.split('\r\n')[1]).toBe(`"'=HYPERLINK(""http://evil"")",'+1,'-2,'@SUM(A1)`)
  })

  it('une columnas de todas las filas y respeta el orden indicado', () => {
    expect(toCsv([{ a: 1 }, { b: 2 }])).toBe('a,b\r\n1,\r\n,2')
    expect(toCsv([{ a: 1, b: 2 }], ['b', 'a'])).toBe('b,a\r\n2,1')
  })
})

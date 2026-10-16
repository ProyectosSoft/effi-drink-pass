// @vitest-environment jsdom
import { createClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { fetchConsumptionHistory, type HistoryFilters } from '../../src/lib/consumptionHistory'

const filters: HistoryFilters = { source: 'company', day: 'event-15', from: '2026-10-15', to: '2026-10-15', effi: ' 1077 ' }
function setup(rows: unknown, count = Array.isArray(rows) ? rows.length : 0, status = 200) {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(rows), {
    status, headers: { 'Content-Type': 'application/json', 'Content-Range': `0-${Math.max(0, (Array.isArray(rows) ? rows.length : 0) - 1)}/${count}` },
  }))
  const client = createClient('https://example.supabase.co', 'test-anon-key', { auth: { persistSession: false }, global: { fetch: fetcher } })
  return { client, fetcher }
}

describe('consulta del historial con las tablas existentes', () => {
  it('consulta empresas con filtros del día efectivo, ID y paginación antes de transformar', async () => {
    const { client, fetcher } = setup([{
      id: 'delivery', quantity: 2, delivered_at: '2026-10-16T15:00:00Z', operator_label: 'Operador', is_manual: true,
      manual_reason: 'Carga posterior', pass: { event_day_id: 'event-15', company: { effi_id: '1077', name: 'Empresa' }, day: { date: '2026-10-15' } },
    }], 101)
    const result = await fetchConsumptionHistory(client, filters, 50, 99)
    const url = new URL(String(fetcher.mock.calls[0][0]))
    expect(url.pathname).toBe('/rest/v1/company_drink_deliveries')
    expect(url.searchParams.get('pass.company.effi_id')).toBe('eq.1077')
    expect(url.searchParams.get('pass.event_day_id')).toBe('eq.event-15')
    expect(url.searchParams.getAll('pass.day.date')).toEqual(['gte.2026-10-15', 'lte.2026-10-15'])
    expect(url.searchParams.get('offset')).toBe('50')
    expect(url.searchParams.get('limit')).toBe('50')
    expect(url.searchParams.get('select')).toContain('!inner')
    expect(result.count).toBe(101)
    expect(result.data[0]).toMatchObject({ source: 'company', event_date: '2026-10-15', recorded_at: '2026-10-16T15:00:00Z', quantity: 2, channel: 'Manual', effi_id: '1077' })
  })

  it('mantiene consumos individuales y su canal API sin mezclarlos con empresas', async () => {
    const { client, fetcher } = setup([{ id: 'individual', attendee_id: 'attendee', event_day_id: 'event-15', consumed_at: '2026-10-15T15:00:00Z', event_date: '2026-10-15', nombres: 'Juan', apellidos: 'Pérez', effi_id: '1077', integration_id: 'api', is_override: true, override_reason: 'Excepción', operator_label: 'API' }])
    const result = await fetchConsumptionHistory(client, { ...filters, source: 'individual' }, 0, 49)
    const url = new URL(String(fetcher.mock.calls[0][0]))
    expect(url.pathname).toBe('/rest/v1/consumption_details')
    expect(url.searchParams.getAll('event_date')).toEqual(['gte.2026-10-15', 'lte.2026-10-15'])
    expect(result.data[0]).toMatchObject({ source: 'individual', display_name: 'Juan Pérez', quantity: 1, channel: 'API', reason: 'Excepción' })
  })

  it('no presenta un error de consulta como un historial vacío', async () => {
    const { client } = setup({ message: 'permission denied', code: '42501' }, 0, 403)
    await expect(fetchConsumptionHistory(client, filters, 0, 49)).rejects.toThrow()
  })
})

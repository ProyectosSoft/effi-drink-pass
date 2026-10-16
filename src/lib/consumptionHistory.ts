import type { SupabaseClient } from '@supabase/supabase-js'
import { query } from './supabase'

export type HistorySource = 'company' | 'individual'
export type HistoryFilters = { source: HistorySource; day: string; from: string; to: string; effi: string }
export type HistoryRow = {
  id: string; source: HistorySource; attendee_id: string | null; event_day_id: string
  recorded_at: string; event_date: string; effi_id: string | null; display_name: string
  quantity: number; operator_label: string | null; channel: string; reason: string | null
}
type CompanyDelivery = {
  id: string; quantity: number; delivered_at: string; operator_label: string | null
  is_manual: boolean; manual_reason: string | null
  pass: { event_day_id: string; company: { effi_id: string; name: string }; day: { date: string } }
}
type IndividualDelivery = {
  id: string; attendee_id: string; event_day_id: string; consumed_at: string; event_date: string
  effi_id: string | null; nombres: string; apellidos: string; operator_label: string | null
  integration_id: string | null; is_override: boolean; override_reason: string | null
}

/** Consultas paginadas sobre las fuentes existentes, protegidas por sus políticas RLS. */
export async function fetchConsumptionHistory(client: SupabaseClient, filters: HistoryFilters, start: number, end: number) {
  if (filters.source === 'company') {
    let req = client.from('company_drink_deliveries').select(
      'id,quantity,delivered_at,operator_label,is_manual,manual_reason,pass:company_drink_days!inner(event_day_id,company:drink_companies!inner(effi_id,name),day:event_days!inner(date))',
      { count: 'exact' },
    )
    if (filters.day) req = req.eq('pass.event_day_id', filters.day)
    if (filters.from) req = req.gte('pass.day.date', filters.from)
    if (filters.to) req = req.lte('pass.day.date', filters.to)
    if (filters.effi.trim()) req = req.eq('pass.company.effi_id', filters.effi.trim())
    const result = await query<CompanyDelivery[]>(req.order('delivered_at', { ascending: false }).order('id').range(start, end).returns<CompanyDelivery[]>())
    return { count: result.count, data: result.data.map((r): HistoryRow => ({
      id: r.id, source: 'company', attendee_id: null, event_day_id: r.pass.event_day_id,
      recorded_at: r.delivered_at, event_date: r.pass.day.date, effi_id: r.pass.company.effi_id,
      display_name: r.pass.company.name, quantity: r.quantity, operator_label: r.operator_label,
      channel: r.is_manual ? 'Manual' : 'QR', reason: r.manual_reason,
    })) }
  }
  let req = client.from('consumption_details').select('*', { count: 'exact' })
  if (filters.day) req = req.eq('event_day_id', filters.day)
  if (filters.from) req = req.gte('event_date', filters.from)
  if (filters.to) req = req.lte('event_date', filters.to)
  if (filters.effi.trim()) req = req.eq('effi_id', filters.effi.trim())
  const result = await query<IndividualDelivery[]>(req.order('consumed_at', { ascending: false }).order('id').range(start, end))
  return { count: result.count, data: result.data.map((r): HistoryRow => ({
    id: r.id, source: 'individual', attendee_id: r.attendee_id, event_day_id: r.event_day_id,
    recorded_at: r.consumed_at, event_date: r.event_date, effi_id: r.effi_id,
    display_name: `${r.nombres ?? ''} ${r.apellidos ?? ''}`.trim(), quantity: 1,
    operator_label: r.operator_label, channel: r.integration_id ? 'API' : 'QR',
    reason: r.is_override ? r.override_reason : null,
  })) }
}

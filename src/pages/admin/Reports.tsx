import { useQuery } from '@tanstack/react-query'
import { Download, Play } from 'lucide-react'
import { useState } from 'react'
import { Button, Card, ErrorBox, Field, Input, PageHeader, Select } from '@/components/ui'
import { downloadCsv } from '@/lib/csv'
import { query, rpc, supabase } from '@/lib/supabase'
import type { EventDay } from '@/lib/types'

/** Tipos de reporte que acepta la RPC `get_report` (clave) y su etiqueta visible (valor). */
const KINDS = {
  daily_consumptions: 'Consumos diarios',
  hourly_consumptions: 'Consumos por hora',
  operator_consumptions: 'Consumos por operador',
  benefits_pending: 'Beneficios pendientes',
  benefits_consumed: 'Beneficios consumidos',
  benefits_expired: 'Beneficios expirados',
  eligible_attendees: 'Asistentes elegibles',
} as const
type Kind = keyof typeof KINDS

/**
 * /admin/reports — generador de reportes. Requiere `reportsRead`.
 * Ejecuta la RPC `get_report` bajo demanda (no es un useQuery: solo al pulsar "Generar"),
 * muestra una vista previa de hasta 500 filas y exporta el resultado completo a CSV
 * (saneado contra CSV injection), registrando EXPORT_REPORT en auditoría.
 */
export default function Reports() {
  const [kind, setKind] = useState<Kind>('daily_consumptions')
  const [day, setDay] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const days = useQuery({ queryKey: ['event-days'], queryFn: async () => (await query<EventDay[]>(supabase.from('event_days').select('*').order('date'))).data })

  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      // Solo se envían los filtros con valor.
      const filters = Object.fromEntries(Object.entries({ event_day_id: day, date_from: from, date_to: to }).filter(([, v]) => v))
      setRows(await rpc<Record<string, unknown>[]>('get_report', { p_kind: kind, p_filters: filters }))
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  // Las columnas se derivan de la primera fila: cada tipo de reporte tiene su propia forma.
  const cols = rows?.[0] ? Object.keys(rows[0]) : []
  // El rango de fechas solo aplica a los reportes de consumos; en los demás se deshabilita.
  const usesDates = kind.endsWith('consumptions')

  return (
    <div className="space-y-4">
      <PageHeader title="Reportes" subtitle="Genere, revise y exporte a CSV (UTF-8, compatible con Excel)." />
      <Card>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="Reporte" className="lg:col-span-2">
            {/* Al cambiar de tipo se descartan los resultados para no exportar datos de otro reporte. */}
            <Select value={kind} onChange={(e) => { setKind(e.target.value as Kind); setRows(null) }}>
              {Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          <Field label="Día del evento"><Select value={day} onChange={(e) => setDay(e.target.value)}>
            <option value="">Todos</option>
            {days.data?.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.date}</option>)}
          </Select></Field>
          <Field label="Desde"><Input type="date" value={from} disabled={!usesDates} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="Hasta"><Input type="date" value={to} disabled={!usesDates} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button loading={busy} icon={<Play className="size-4" />} onClick={run}>Generar</Button>
          <Button variant="secondary" disabled={!rows?.length} icon={<Download className="size-4" />} onClick={() => {
            downloadCsv(`${kind}-${new Date().toISOString().slice(0, 10)}.csv`, rows!)
            void rpc('log_client_event', { p_action: 'EXPORT_REPORT', p_metadata: { report: kind, rows: rows!.length } }).catch(() => {})
          }}>Descargar CSV</Button>
        </div>
      </Card>
      <ErrorBox error={error} />
      {rows && (
        <Card title={`${KINDS[kind]} · ${rows.length} filas`}>
          {rows.length === 0 ? <p className="text-sm text-muted">Sin datos.</p> : (
            <div className="max-h-[60vh] overflow-auto">
              <table className="table-base">
                <thead className="sticky top-0 bg-surface"><tr>{cols.map((c) => <th key={c}>{c.replace(/_/g, ' ')}</th>)}</tr></thead>
                <tbody>{rows.slice(0, 500).map((r, i) => (
                  <tr key={i}>{cols.map((c) => <td key={c} className={typeof r[c] === 'number' ? 'text-right tabular-nums' : ''}>{r[c] === null ? '—' : String(r[c])}</td>)}</tr>
                ))}</tbody>
              </table>
              {rows.length > 500 && <p className="p-2 text-xs text-muted">Vista previa de 500 filas. El CSV incluye todas.</p>}
            </div>
          )}
        </Card>
      )}
    </div>
  )
}

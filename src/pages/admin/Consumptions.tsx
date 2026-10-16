import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { Badge, Button, ErrorBox, Field, Input, PageHeader, Pagination, Select, Spinner } from '@/components/ui'
import { downloadCsv } from '@/lib/csv'
import { fmtDateTime } from '@/lib/format'
import { query, rpc, supabase } from '@/lib/supabase'
import { fetchConsumptionHistory, type HistorySource } from '@/lib/consumptionHistory'
import type { EventDay } from '@/lib/types'

const PAGE = 50

/** Historial de empresas e individuales; fechas filtradas por día efectivo del evento. */
export default function Consumptions() {
  const [day, setDay] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [effi, setEffi] = useState('')
  const [source, setSource] = useState<HistorySource>('company')
  const [page, setPage] = useState(1)

  const days = useQuery({ queryKey: ['event-days'], queryFn: async () => (await query<EventDay[]>(supabase.from('event_days').select('*').order('date'))).data })
  const filters = { source, day, from, to, effi }
  const list = useQuery({
    queryKey: ['consumptions', day, from, to, effi, source, page],
    placeholderData: keepPreviousData,
    refetchInterval: 20_000,
    queryFn: () => fetchConsumptionHistory(supabase, filters, (page - 1) * PAGE, page * PAGE - 1),
  })

  /** Exporta hasta 50 000 filas; el log de auditoría es best-effort y no bloquea la descarga. */
  const exportCsv = async () => {
    const { data } = await fetchConsumptionHistory(supabase, filters, 0, 49_999)
    // Mismos filtros que la tabla; la fecha efectiva y la de registro se conservan por separado.
    downloadCsv('consumos.csv', data.map((r) => ({
      registrado_en: fmtDateTime(r.recorded_at), dia_consumo: r.event_date, tipo: r.source === 'company' ? 'Empresa' : 'Individual',
      empresa_o_asistente: r.display_name, effi_id: r.effi_id, cantidad: r.quantity,
      operador: r.operator_label, canal: r.channel, motivo: r.reason ?? '',
    })))
    void rpc('log_client_event', { p_action: 'EXPORT_REPORT', p_metadata: { report: 'consumptions', rows: data.length } }).catch(() => {})
  }

  return (
    <div>
      <PageHeader title="Consumos" subtitle="Entregas por empresa y pases individuales. Las fechas filtran el día del consumo, también para registros manuales posteriores." actions={<Button variant="secondary" icon={<Download className="size-4" />} onClick={exportCsv}>CSV</Button>} />
      <div className="card mb-4 grid grid-cols-2 gap-3 p-4 sm:grid-cols-4">
        <Field label="Día"><Select value={day} onChange={(e) => { setDay(e.target.value); setPage(1) }}>
          <option value="">Todos</option>
          {days.data?.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.date}</option>)}
        </Select></Field>
        <Field label="Tipo"><Select value={source} onChange={(e) => { setSource(e.target.value as HistorySource); setPage(1) }}>
          <option value="company">Empresas</option><option value="individual">Individuales</option>
        </Select></Field>
        <Field label="Desde"><Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1) }} /></Field>
        <Field label="Hasta"><Input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1) }} /></Field>
        <Field label="ID Effi"><Input value={effi} onChange={(e) => { setEffi(e.target.value); setPage(1) }} /></Field>
      </div>
      <Button variant="ghost" className="mb-3" onClick={() => { setDay(''); setFrom(''); setTo(''); setEffi(''); setSource('company'); setPage(1) }}>Limpiar filtros</Button>
      <ErrorBox error={list.error} />
      <div className="card overflow-x-auto p-2">
        {list.isLoading ? <Spinner /> : (
          <table className="table-base min-w-[760px]">
            <thead><tr><th>Registrado el</th><th>Empresa / asistente</th><th>ID Effi</th><th>Día del consumo</th><th>Cantidad</th><th>Operador</th><th>Canal / motivo</th></tr></thead>
            <tbody>
              {list.data?.data.map((c) => (
                <tr key={`${c.source}:${c.id}`}>
                  <td className="whitespace-nowrap tabular-nums">{fmtDateTime(c.recorded_at)}</td>
                  <td>{c.attendee_id ? <Link className="hover:text-brand" to={`/admin/attendees/${c.attendee_id}`}>{c.display_name}</Link> : c.display_name}<span className="block text-xs text-muted">{c.source === 'company' ? 'Empresa' : 'Individual'}</span></td>
                  <td className="font-mono">{c.effi_id ?? '—'}</td>
                  <td>{c.event_date}</td><td>{c.quantity}</td>
                  <td>{c.operator_label ?? '—'} </td>
                  <td><Badge tone={c.channel === 'Manual' ? 'warn' : 'neutral'}>{c.channel}</Badge>{c.reason && <p className="mt-1 text-sm">{c.reason}</p>}</td>
                </tr>
              ))}
              {list.data?.data.length === 0 && <tr><td colSpan={7} className="py-8 text-center text-muted">Sin consumos con estos filtros. Revisa el día y el ID Effi o limpia los filtros.</td></tr>}
            </tbody>
          </table>
        )}
        {list.data && <div className="px-2"><Pagination page={page} pageSize={PAGE} total={list.data.count} onPage={setPage} /></div>}
      </div>
    </div>
  )
}

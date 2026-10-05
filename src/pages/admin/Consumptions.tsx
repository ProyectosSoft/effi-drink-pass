import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { Badge, Button, ErrorBox, Field, Input, PageHeader, Pagination, Select, Spinner } from '@/components/ui'
import { downloadCsv } from '@/lib/csv'
import { fmtDateTime, fullName } from '@/lib/format'
import { query, rpc, supabase } from '@/lib/supabase'
import type { EventDay } from '@/lib/types'

type Row = {
  id: string; benefit_id: string; attendee_id: string; consumed_at: string; is_override: boolean; override_reason: string | null
  nombres: string; apellidos: string; effi_id: string | null; effi_username: string | null; tipo_acceso: string; empresa: string | null
  event_date: string; operator_label: string | null; integration_id: string | null; metadata: Record<string, unknown>
}
const PAGE = 50

/** Inicio del día en Bogotá (UTC-5, sin horario de verano) expresado en UTC. */
const bogotaStart = (d: string) => `${d}T05:00:00Z`
/** Inicio del día siguiente en Bogotá (límite exclusivo para el filtro "Hasta"). */
const bogotaEnd = (d: string) => new Date(new Date(`${d}T05:00:00Z`).getTime() + 86_400_000).toISOString()

/**
 * /admin/consumptions — historial inmutable de consumos (vista `consumption_details`).
 * Requiere `consumptionsRead`. Se refresca cada 20 s, distingue canjes por API y excepciones
 * (override) y permite exportar a CSV (celdas saneadas en `downloadCsv`), registrando
 * EXPORT_REPORT en auditoría.
 */
export default function Consumptions() {
  const [day, setDay] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [effi, setEffi] = useState('')
  const [page, setPage] = useState(1)

  const days = useQuery({ queryKey: ['event-days'], queryFn: async () => (await query<EventDay[]>(supabase.from('event_days').select('*').order('date'))).data })
  /** Consulta filtrada sin paginar; compartida por el listado y la exportación CSV. */
  const build = () => {
    let q = supabase.from('consumption_details').select('*', { count: 'exact' })
    if (day) q = q.eq('event_day_id', day)
    if (from) q = q.gte('consumed_at', bogotaStart(from))
    if (to) q = q.lt('consumed_at', bogotaEnd(to))
    if (effi.trim()) q = q.eq('effi_id', effi.trim())
    return q.order('consumed_at', { ascending: false })
  }
  const list = useQuery({
    queryKey: ['consumptions', day, from, to, effi, page],
    placeholderData: keepPreviousData,
    refetchInterval: 20_000,
    queryFn: () => query<Row[]>(build().range((page - 1) * PAGE, page * PAGE - 1)),
  })

  /** Exporta hasta 50 000 filas; el log de auditoría es best-effort y no bloquea la descarga. */
  const exportCsv = async () => {
    const { data } = await query<Row[]>(build().range(0, 49_999))
    // Columnas en español; `canal` indica si el canje vino de una integración (API) o del staff.
    downloadCsv('consumos.csv', data.map((r) => ({
      consumido_en: fmtDateTime(r.consumed_at), dia: r.event_date, nombres: r.nombres, apellidos: r.apellidos, effi_id: r.effi_id,
      effi_username: r.effi_username, tipo_acceso: r.tipo_acceso, empresa: r.empresa, operador: r.operator_label,
      canal: r.integration_id ? 'API' : 'staff', excepcion: r.is_override ? r.override_reason : '',
    })))
    void rpc('log_client_event', { p_action: 'EXPORT_REPORT', p_metadata: { report: 'consumptions', rows: data.length } }).catch(() => {})
  }

  return (
    <div>
      <PageHeader title="Consumos" subtitle="Historial inmutable · se actualiza cada 20 s" actions={<Button variant="secondary" icon={<Download className="size-4" />} onClick={exportCsv}>CSV</Button>} />
      <div className="card mb-4 grid grid-cols-2 gap-3 p-4 sm:grid-cols-4">
        <Field label="Día"><Select value={day} onChange={(e) => { setDay(e.target.value); setPage(1) }}>
          <option value="">Todos</option>
          {days.data?.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.date}</option>)}
        </Select></Field>
        <Field label="Desde"><Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1) }} /></Field>
        <Field label="Hasta"><Input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1) }} /></Field>
        <Field label="ID Effi"><Input value={effi} onChange={(e) => { setEffi(e.target.value); setPage(1) }} /></Field>
      </div>
      <ErrorBox error={list.error} />
      <div className="card overflow-x-auto p-2">
        {list.isLoading ? <Spinner /> : (
          <table className="table-base min-w-[760px]">
            <thead><tr><th>Fecha y hora</th><th>Asistente</th><th>ID Effi</th><th>Día</th><th>Operador</th><th>Notas</th></tr></thead>
            <tbody>
              {list.data?.data.map((c) => (
                <tr key={c.id}>
                  <td className="whitespace-nowrap tabular-nums">{fmtDateTime(c.consumed_at)}</td>
                  <td><Link className="hover:text-brand" to={`/admin/attendees/${c.attendee_id}`}>{fullName(c)}</Link></td>
                  <td className="font-mono">{c.effi_id ?? '—'}</td>
                  <td>{c.event_date}</td>
                  <td>{c.operator_label ?? '—'} {c.integration_id && <Badge tone="accent">API</Badge>}</td>
                  <td>{c.is_override && <Badge tone="warn" className="max-w-xs truncate">Excepción: {c.override_reason}</Badge>}</td>
                </tr>
              ))}
              {list.data?.data.length === 0 && <tr><td colSpan={6} className="py-8 text-center text-muted">Sin consumos</td></tr>}
            </tbody>
          </table>
        )}
        {list.data && <div className="px-2"><Pagination page={page} pageSize={PAGE} total={list.data.count} onPage={setPage} /></div>}
      </div>
    </div>
  )
}

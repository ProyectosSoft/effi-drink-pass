import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarPlus, Download, Hourglass, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { BenefitActions } from '@/components/BenefitActions'
import { Badge, Button, ConfirmDialog, ErrorBox, Field, Input, Modal, PageHeader, Pagination, Select, Spinner, StatusBadge, useToast } from '@/components/ui'
import { useAuth } from '@/lib/auth'
import { downloadCsv } from '@/lib/csv'
import { fmtDateTime, fullName } from '@/lib/format'
import { query, rpc, supabase } from '@/lib/supabase'
import { PERMISSIONS as P, type EventDay } from '@/lib/types'

type Row = {
  id: string; attendee_id: string; status: string; effective_status: string; consumed_at: string | null; event_date: string
  event_day_name: string; nombres: string; apellidos: string; effi_id: string | null; effi_username: string | null; tipo_acceso: string; empresa: string | null
}
const PAGE = 50

/** Escapa comodines de ILIKE y neutraliza caracteres que romperían el filtro or() de PostgREST. */
function likeSafe(s: string) {
  return s.replace(/[%_\\]/g, (m) => `\\${m}`).replace(/[,()*]/g, ' ').trim()
}

/**
 * /admin/benefits — listado global de beneficios (vista `benefit_details`). Requiere `benefitsRead`.
 * · Exportación CSV de todo el filtro (celdas saneadas contra CSV injection en `downloadCsv`)
 *   y registro del evento EXPORT_REPORT en auditoría.
 * · `attendeesWrite`: asignar un día a todos los asistentes activos (RPC `assign_day_to_attendees`).
 * · `benefitsWrite`: generar beneficios faltantes (`generate_benefits`) y persistir expirados
 *   (`expire_benefits`), ambos tras confirmación.
 * · Acciones por fila vía BenefitActions (excepción, regenerar QR, cancelar, restaurar).
 */
export default function Benefits() {
  const { can } = useAuth()
  const qc = useQueryClient()
  const toast = useToast()
  const [day, setDay] = useState('')
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [page, setPage] = useState(1)
  // Acción masiva pendiente de confirmar (null = ningún diálogo abierto).
  const [confirm, setConfirm] = useState<'generate' | 'expire' | null>(null)
  const [assignOpen, setAssignOpen] = useState(false)

  // Debounce de 300 ms de la búsqueda; reinicia la paginación.
  useEffect(() => {
    const t = setTimeout(() => { setDebounced(search); setPage(1) }, 300)
    return () => clearTimeout(t)
  }, [search])

  const days = useQuery({ queryKey: ['event-days'], queryFn: async () => (await query<EventDay[]>(supabase.from('event_days').select('*').order('date'))).data })

  /**
   * Construye la consulta con los filtros actuales, sin paginar. La comparten el listado
   * y la exportación CSV para que el CSV contenga exactamente lo filtrado.
   * Se filtra por `effective_status` (calculado con la hora del servidor), no por `status`.
   */
  const build = () => {
    let q = supabase.from('benefit_details').select('*', { count: 'exact' })
    if (day) q = q.eq('event_day_id', day)
    if (status) q = q.eq('effective_status', status)
    const s = likeSafe(debounced)
    if (s) q = q.or(`nombres.ilike.%${s}%,apellidos.ilike.%${s}%,effi_id.ilike.%${s}%,effi_username.ilike.%${s}%,email.ilike.%${s}%`)
    return q.order('event_date').order('apellidos')
  }
  const list = useQuery({
    queryKey: ['benefits', day, status, debounced, page],
    placeholderData: keepPreviousData,
    queryFn: () => query<Row[]>(build().range((page - 1) * PAGE, page * PAGE - 1)),
  })
  // Invalida todas las páginas/filtros del listado (prefijo 'benefits').
  const refresh = () => void qc.invalidateQueries({ queryKey: ['benefits'] })

  /** Exporta hasta 50 000 filas del filtro actual y deja constancia en auditoría (best-effort). */
  const exportCsv = async () => {
    const { data } = await query<Row[]>(build().range(0, 49_999))
    downloadCsv('beneficios.csv', data.map((r) => ({
      dia: r.event_date, nombres: r.nombres, apellidos: r.apellidos, effi_id: r.effi_id, effi_username: r.effi_username,
      tipo_acceso: r.tipo_acceso, empresa: r.empresa, estado: r.effective_status, consumido_en: r.consumed_at,
    })))
    void rpc('log_client_event', { p_action: 'EXPORT_REPORT', p_metadata: { report: 'benefits', rows: data.length } }).catch(() => {})
  }

  return (
    <div>
      <PageHeader title="Beneficios" subtitle={list.data ? `${list.data.count} beneficios` : undefined} actions={<>
        <Button variant="secondary" icon={<Download className="size-4" />} onClick={exportCsv}>CSV</Button>
        {can(P.attendeesWrite) && <Button variant="secondary" icon={<CalendarPlus className="size-4" />} onClick={() => setAssignOpen(true)}>Asignar día a todos</Button>}
        {can(P.benefitsWrite) && <Button variant="secondary" icon={<Hourglass className="size-4" />} onClick={() => setConfirm('expire')}>Expirar vencidos</Button>}
        {can(P.benefitsWrite) && <Button icon={<Sparkles className="size-4" />} onClick={() => setConfirm('generate')}>Generar faltantes</Button>}
      </>} />

      <div className="card mb-4 grid gap-3 p-4 sm:grid-cols-[1fr_200px_180px]">
        <Input placeholder="Buscar nombre, email, ID Effi o usuario Effi" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Buscar" />
        <Select value={day} onChange={(e) => { setDay(e.target.value); setPage(1) }} aria-label="Día">
          <option value="">Todos los días</option>
          {days.data?.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.date}</option>)}
        </Select>
        <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }} aria-label="Estado">
          <option value="">Todos los estados</option>
          <option value="PENDING">Pendiente</option><option value="CONSUMED">Consumido</option>
          <option value="EXPIRED">Expirado</option><option value="CANCELLED">Cancelado</option>
        </Select>
      </div>

      <ErrorBox error={list.error} />
      <div className="card overflow-x-auto p-2">
        {list.isLoading ? <Spinner /> : (
          <table className="table-base min-w-[760px]">
            <thead><tr><th>Día</th><th>Asistente</th><th>ID Effi</th><th>Acceso</th><th>Estado</th><th>Consumido</th><th /></tr></thead>
            <tbody>
              {list.data?.data.map((b) => (
                <tr key={b.id}>
                  <td className="whitespace-nowrap">{b.event_date}</td>
                  <td><Link className="hover:text-brand" to={`/admin/attendees/${b.attendee_id}`}>{fullName(b)}</Link></td>
                  <td className="font-mono">{b.effi_id ?? '—'}</td>
                  <td><Badge>{b.tipo_acceso}</Badge></td>
                  <td><StatusBadge status={b.effective_status} /></td>
                  <td>{fmtDateTime(b.consumed_at)}</td>
                  <td className="text-right"><BenefitActions benefitId={b.id} status={b.effective_status} onDone={refresh} /></td>
                </tr>
              ))}
              {list.data?.data.length === 0 && <tr><td colSpan={7} className="py-8 text-center text-muted">Sin resultados</td></tr>}
            </tbody>
          </table>
        )}
        {list.data && <div className="px-2"><Pagination page={page} pageSize={PAGE} total={list.data.count} onPage={setPage} /></div>}
      </div>

      <ConfirmDialog open={confirm === 'generate'} title="Generar beneficios faltantes"
        message="Crea el beneficio (y su QR) de cada día elegible de cada asistente activo que aún no lo tenga. No modifica beneficios existentes."
        onClose={() => setConfirm(null)} onConfirm={async () => { const n = await rpc<number>('generate_benefits', { p_attendee_ids: null }); toast(`${n} beneficios generados`); refresh() }} />
      <ConfirmDialog open={confirm === 'expire'} title="Expirar beneficios vencidos"
        message="Marca como EXPIRADO todo beneficio pendiente cuyo día ya terminó (hora del servidor). El estado efectivo ya se calcula solo; esto lo persiste."
        onClose={() => setConfirm(null)} onConfirm={async () => { const n = await rpc<number>('expire_benefits'); toast(`${n} beneficios expirados`); refresh() }} />
      <AssignDayModal open={assignOpen} days={days.data ?? []} onClose={() => setAssignOpen(false)} onDone={(n) => { toast(`${n} asistentes habilitados`); refresh() }} />
    </div>
  )
}

/**
 * Modal para habilitar un día a todos los asistentes activos, opcionalmente solo de un tipo
 * de acceso. Llama a `assign_day_to_attendees` y devuelve cuántos asistentes se habilitaron.
 */
function AssignDayModal({ open, days, onClose, onDone }: { open: boolean; days: EventDay[]; onClose: () => void; onDone: (n: number) => void }) {
  const [day, setDay] = useState('')
  const [tipo, setTipo] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  return (
    <Modal open={open} onClose={onClose} title="Asignar un día a todos los asistentes activos" size="sm" footer={<>
      <Button variant="ghost" onClick={onClose}>Cancelar</Button>
      <Button disabled={!day} loading={busy} onClick={async () => {
        setBusy(true); setError(null)
        try { onDone(await rpc<number>('assign_day_to_attendees', { p_event_day_id: day, p_tipo_acceso: tipo.trim() || null })); onClose() }
        catch (e) { setError(e) } finally { setBusy(false) }
      }}>Asignar</Button>
    </>}>
      <div className="space-y-3">
        <Field label="Día"><Select value={day} onChange={(e) => setDay(e.target.value)}>
          <option value="">Seleccione…</option>
          {days.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.date}</option>)}
        </Select></Field>
        <Field label="Solo tipo de acceso (opcional)" hint="Vacío = todos los asistentes activos"><Input value={tipo} onChange={(e) => setTipo(e.target.value.toUpperCase())} /></Field>
        <ErrorBox error={error} />
      </div>
    </Modal>
  )
}

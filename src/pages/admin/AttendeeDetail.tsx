import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, Pencil } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { AttendeeForm } from '@/components/AttendeeForm'
import { BenefitActions } from '@/components/BenefitActions'
import { Badge, Button, Card, Checkbox, ErrorBox, Modal, PageHeader, Spinner, StatusBadge, useToast } from '@/components/ui'
import { useAuth } from '@/lib/auth'
import { fmtDateTime, fmtEventDate, fullName } from '@/lib/format'
import { query, rpc, supabase } from '@/lib/supabase'
import { PERMISSIONS as P, type Attendee, type EventDay } from '@/lib/types'

// Proyecciones parciales de las vistas que consulta esta pantalla (solo las columnas usadas).
type BenefitRow = { id: string; event_day_id: string; status: string; effective_status: string; consumed_at: string | null; expiration_at: string; cancel_reason: string | null }
type ConsumptionRow = { id: string; consumed_at: string; operator_label: string | null; is_override: boolean; override_reason: string | null; event_date: string }
type AuditRow = { id: number; occurred_at: string; action: string; actor_label: string | null; metadata: Record<string, unknown> }

/**
 * /admin/attendees/:id — ficha de un asistente. Requiere `attendeesRead`.
 * Secciones condicionadas por permiso (las consultas también se desactivan con `enabled`
 * para no pedir datos que RLS rechazaría):
 * · `attendeesWrite`: editar datos y días elegibles (RPC `set_attendee_days`, que genera beneficios).
 * · `benefitsRead`: beneficios por día con acciones (BenefitActions: excepción, regenerar QR, cancelar, restaurar).
 * · `consumptionsRead`: historial de consumos, incluidas excepciones (override).
 * · `auditRead`: últimos 50 eventos de auditoría relacionados con el asistente.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default function AttendeeDetail() {
  const { id = '' } = useParams()
  const { can } = useAuth()
  const qc = useQueryClient()
  const toast = useToast()
  const [editing, setEditing] = useState(false)

  const att = useQuery({
    queryKey: ['attendee', id],
    queryFn: async () => (await query<Attendee>(supabase.from('attendees').select('*').eq('id', id).single())).data,
  })
  const days = useQuery({ queryKey: ['event-days'], queryFn: async () => (await query<EventDay[]>(supabase.from('event_days').select('*').order('date'))).data })
  const elig = useQuery({
    queryKey: ['attendee-days', id],
    queryFn: async () => (await query<{ event_day_id: string; eligible: boolean }[]>(supabase.from('attendee_event_days').select('event_day_id,eligible').eq('attendee_id', id))).data,
  })
  const benefits = useQuery({
    queryKey: ['attendee-benefits', id],
    enabled: can(P.benefitsRead),
    queryFn: async () => (await query<BenefitRow[]>(supabase.from('benefit_details').select('id,event_day_id,status,effective_status,consumed_at,expiration_at,cancel_reason').eq('attendee_id', id))).data,
  })
  const consumptions = useQuery({
    queryKey: ['attendee-consumptions', id],
    enabled: can(P.consumptionsRead),
    queryFn: async () => (await query<ConsumptionRow[]>(supabase.from('consumption_details').select('id,consumed_at,operator_label,is_override,override_reason,event_date').eq('attendee_id', id).order('consumed_at', { ascending: false }))).data,
  })
  const audit = useQuery({
    queryKey: ['attendee-audit', id],
    // El id va dentro de un filtro or() de PostgREST: solo se usa si es un UUID, para que
    // un id manipulado en la URL (con comas o paréntesis) no pueda añadir condiciones al filtro.
    enabled: can(P.auditRead) && UUID_RE.test(id),
    // Eventos cuyo recurso es el asistente o que lo referencian en metadata (p. ej. canjes de sus beneficios).
    queryFn: async () => (await query<AuditRow[]>(supabase.from('audit_logs').select('id,occurred_at,action,actor_label,metadata')
      .or(`resource_id.eq.${id},metadata->>attendee_id.eq.${id}`).order('occurred_at', { ascending: false }).limit(50))).data,
  })

  // Copia editable de los días elegibles; se resincroniza cada vez que llegan datos del servidor.
  const [selected, setSelected] = useState<string[]>([])
  useEffect(() => {
    if (elig.data) setSelected(elig.data.filter((e) => e.eligible).map((e) => e.event_day_id))
  }, [elig.data])
  const [savingDays, setSavingDays] = useState(false)
  const [daysError, setDaysError] = useState<unknown>(null)

  /**
   * Invalida todas las consultas de esta ficha (keys `[k, id]`) y el listado de asistentes,
   * ya que editar datos, días o beneficios puede afectar a cualquiera de ellas.
   */
  const refreshAll = () => {
    for (const k of ['attendee', 'attendee-days', 'attendee-benefits', 'attendee-consumptions', 'attendee-audit']) void qc.invalidateQueries({ queryKey: [k, id] })
    void qc.invalidateQueries({ queryKey: ['attendees'] })
  }

  if (att.isLoading) return <Spinner />
  if (att.error || !att.data) return <ErrorBox error={att.error ?? new Error('No encontrado')} />
  const a = att.data
  const dayById = new Map(days.data?.map((d) => [d.id, d]))

  return (
    <div className="space-y-4">
      <Link to="/admin/attendees" className="flex items-center gap-1 text-sm text-muted hover:text-ink"><ChevronLeft className="size-4" /> Asistentes</Link>
      <PageHeader title={fullName(a)} subtitle={<span className="flex flex-wrap gap-2">
        <Badge tone="accent">{a.tipo_acceso}</Badge>
        {a.activo ? <Badge tone="ok">Activo</Badge> : <Badge tone="bad">Inactivo</Badge>}
        {a.is_demo && <Badge tone="accent">DEMO</Badge>}
      </span>} actions={can(P.attendeesWrite) && <Button variant="secondary" icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>Editar</Button>} />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Datos" className="lg:col-span-2">
          <dl className="grid gap-4 text-sm sm:grid-cols-3">
            {([['Email', a.email], ['Teléfono', a.telefono], ['Empresa', a.empresa], ['ID Effi', a.effi_id], ['Usuario Effi', a.effi_username], ['ID interno', a.id]] as const).map(([k, v]) => (
              <div key={k}><dt className="text-xs text-faint">{k}</dt><dd className={k.startsWith('ID') ? 'font-mono break-all' : 'break-words'}>{v ?? '—'}</dd></div>
            ))}
            <div><dt className="text-xs text-faint">Creado</dt><dd>{fmtDateTime(a.created_at)}</dd></div>
            <div><dt className="text-xs text-faint">Actualizado</dt><dd>{fmtDateTime(a.updated_at)}</dd></div>
          </dl>
        </Card>

        <Card title="Días elegibles">
          {days.data?.length === 0 && <p className="text-sm text-muted">No hay días configurados. Créalos en Configuración.</p>}
          <div className="space-y-1">
            {days.data?.map((d) => (
              <Checkbox key={d.id} label={`${d.name} · ${d.date}`} disabled={!can(P.attendeesWrite)} checked={selected.includes(d.id)}
                onChange={(v) => setSelected((s) => (v ? [...s, d.id] : s.filter((x) => x !== d.id)))} />
            ))}
          </div>
          {can(P.attendeesWrite) && (
            <div className="mt-3 space-y-2">
              <ErrorBox error={daysError} />
              <Button size="sm" loading={savingDays} onClick={async () => {
                setSavingDays(true); setDaysError(null)
                try {
                  // Reemplaza la elegibilidad completa; el servidor crea los beneficios de los días nuevos.
                  await rpc('set_attendee_days', { p_attendee_id: id, p_event_day_ids: selected })
                  toast('Elegibilidad actualizada; beneficios generados')
                  refreshAll()
                } catch (e) { setDaysError(e) } finally { setSavingDays(false) }
              }}>Guardar días</Button>
            </div>
          )}
        </Card>
      </div>

      {can(P.benefitsRead) && (
        <Card title="Beneficios">
          {benefits.isLoading ? <Spinner /> : (
            <div className="overflow-x-auto">
              <table className="table-base min-w-[600px]">
                <thead><tr><th>Día</th><th>Estado</th><th>Consumido</th><th>Expira</th><th>Nota</th><th /></tr></thead>
                <tbody>
                  {/* Orden cronológico según la fecha del día del evento (la vista no la incluye). */}
                  {benefits.data?.sort((x, y) => (dayById.get(x.event_day_id)?.date ?? '').localeCompare(dayById.get(y.event_day_id)?.date ?? '')).map((b) => (
                    <tr key={b.id}>
                      <td>{fmtEventDate(dayById.get(b.event_day_id)?.date)}</td>
                      <td><StatusBadge status={b.effective_status} /></td>
                      <td>{fmtDateTime(b.consumed_at)}</td>
                      <td className="text-muted">{fmtDateTime(b.expiration_at)}</td>
                      <td className="text-muted">{b.cancel_reason ?? ''}</td>
                      <td className="text-right"><BenefitActions benefitId={b.id} status={b.effective_status} onDone={refreshAll} /></td>
                    </tr>
                  ))}
                  {benefits.data?.length === 0 && <tr><td colSpan={6} className="text-center text-muted">Sin beneficios. Asigne días elegibles.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {can(P.consumptionsRead) && (
        <Card title="Consumos">
          {consumptions.data?.length ? (
            <ul className="divide-y divide-line text-sm">
              {consumptions.data.map((c) => (
                <li key={c.id} className="flex flex-wrap justify-between gap-2 py-2">
                  <span>{fmtEventDate(c.event_date)} · {fmtDateTime(c.consumed_at)}</span>
                  <span className="text-muted">{c.operator_label ?? '—'} {c.is_override && <Badge tone="warn">Excepción: {c.override_reason}</Badge>}</span>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted">Sin consumos.</p>}
        </Card>
      )}

      {can(P.auditRead) && (
        <Card title="Auditoría reciente">
          {audit.data?.length ? (
            <ul className="divide-y divide-line text-sm">
              {audit.data.map((r) => (
                <li key={r.id} className="flex flex-wrap justify-between gap-2 py-2">
                  <span><Badge>{r.action}</Badge> <span className="text-muted">{r.actor_label ?? 'sistema'}</span></span>
                  <span className="text-xs text-faint">{fmtDateTime(r.occurred_at)}</span>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted">Sin eventos.</p>}
        </Card>
      )}

      <Modal open={editing} onClose={() => setEditing(false)} title="Editar asistente" size="lg">
        <AttendeeForm attendee={a} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); toast('Asistente actualizado'); refreshAll() }} />
      </Modal>
    </div>
  )
}

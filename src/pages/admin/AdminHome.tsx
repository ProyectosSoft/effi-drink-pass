import { useQuery } from '@tanstack/react-query'
import { RefreshCcw, ScanLine } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { ChartCard } from '@/components/charts'
import { Button, ErrorBox, Field, Input, PageHeader, Select, Spinner, Stat } from '@/components/ui'
import { useAuth } from '@/lib/auth'
import { fmtDateTime, fmtEventDate, num } from '@/lib/format'
import { query, rpc, supabase } from '@/lib/supabase'
import { PERMISSIONS as P, type EventDay, type Statistics } from '@/lib/types'

/** Filtros del dashboard; se envían a `get_statistics` (cadenas vacías = sin filtro). */
type Filters = {
  event_day_id: string; date_from: string; date_to: string; operator_id: string; status: string
  effi_id: string; effi_username: string; empresa: string
}
const EMPTY: Filters = { event_day_id: '', date_from: '', date_to: '', operator_id: '', status: '', effi_id: '', effi_username: '', empresa: '' }

/**
 * /admin — dashboard de estadísticas. Requiere `statisticsRead` (sin ese permiso, AdminIndex
 * en App.tsx redirige al scanner). Llama a la RPC `get_statistics` con los filtros aplicados,
 * se refresca cada 30 s y muestra KPIs y gráficos por día, hora, operador y tipo de acceso.
 */
export default function AdminHome() {
  const { can } = useAuth()
  // `draft` se edita en el formulario; `filters` solo cambia al pulsar "Aplicar filtros",
  // así no se lanza una consulta por cada tecla.
  const [draft, setDraft] = useState<Filters>(EMPTY)
  const [filters, setFilters] = useState<Filters>(EMPTY)

  const days = useQuery({
    queryKey: ['event-days'],
    queryFn: async () => (await query<EventDay[]>(supabase.from('event_days').select('*').order('date'))).data,
  })
  const stats = useQuery({
    // Los filtros forman parte de la key: cada combinación se cachea por separado.
    queryKey: ['statistics', filters],
    // Solo se envían los filtros con valor para que el servidor ignore los vacíos.
    queryFn: () => rpc<Statistics>('get_statistics', { p_filters: Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) }),
    refetchInterval: 30_000,
  })

  const t = stats.data?.totals
  /** Crea el onChange que actualiza un campo del borrador de filtros. */
  const set = (k: keyof Filters) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [k]: e.target.value }))

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle={stats.data ? `Actualizado ${fmtDateTime(stats.data.generated_at)} · se refresca cada 30 s` : undefined}
        actions={<>
          <Button variant="secondary" icon={<RefreshCcw className="size-4" />} onClick={() => stats.refetch()} loading={stats.isFetching}>Actualizar</Button>
          {can(P.benefitsRedeem) && <Link to="/admin/scanner"><Button icon={<ScanLine className="size-4" />}>Scanner</Button></Link>}
        </>}
      />

      <form className="card mb-6 grid grid-cols-2 gap-3 p-4 sm:grid-cols-4 lg:grid-cols-8"
        onSubmit={(e) => { e.preventDefault(); setFilters(draft) }}>
        <Field label="Día">
          <Select value={draft.event_day_id} onChange={set('event_day_id')}>
            <option value="">Todos</option>
            {days.data?.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.date}</option>)}
          </Select>
        </Field>
        <Field label="Desde"><Input type="date" value={draft.date_from} onChange={set('date_from')} /></Field>
        <Field label="Hasta"><Input type="date" value={draft.date_to} onChange={set('date_to')} /></Field>
        <Field label="Estado">
          <Select value={draft.status} onChange={set('status')}>
            <option value="">Todos</option>
            <option value="PENDING">Pendiente</option>
            <option value="CONSUMED">Consumido</option>
            <option value="EXPIRED">Expirado</option>
            <option value="CANCELLED">Cancelado</option>
          </Select>
        </Field>
        <Field label="Operador">
          <Select value={draft.operator_id} onChange={set('operator_id')}>
            <option value="">Todos</option>
            {/* Opciones tomadas de las propias estadísticas (operadores con consumos); se omiten los sin id. */}
            {stats.data?.by_operator.filter((o) => o.operator_id).map((o) => <option key={o.operator_id!} value={o.operator_id!}>{o.operator}</option>)}
          </Select>
        </Field>
        <Field label="ID Effi"><Input value={draft.effi_id} onChange={set('effi_id')} /></Field>
        <Field label="Usuario Effi"><Input value={draft.effi_username} onChange={set('effi_username')} /></Field>
        <Field label="Empresa"><Input value={draft.empresa} onChange={set('empresa')} /></Field>
        <div className="col-span-full flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => { setDraft(EMPTY); setFilters(EMPTY) }}>Limpiar</Button>
          <Button type="submit">Aplicar filtros</Button>
        </div>
      </form>

      <ErrorBox error={stats.error} />
      {stats.isLoading && <Spinner />}

      {t && stats.data && (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
            <Stat label="Asistentes" value={num(t.attendees)} hint={t.attendees_inactive ? `${num(t.attendees_inactive)} inactivos` : undefined} />
            <Stat label="Elegibles" value={num(t.eligible_attendees)} />
            <Stat label="Beneficios" value={num(t.benefits)} />
            <Stat label="Consumidos" value={num(t.consumed)} tone="ok" />
            <Stat label="Pendientes" value={num(t.pending)} />
            <Stat label="Expirados" value={num(t.expired)} tone="warn" hint={t.cancelled ? `${num(t.cancelled)} cancelados` : undefined} />
            <Stat label="Consumos hoy" value={num(t.consumed_today)} tone="brand" hint={fmtEventDate(stats.data.today)} />
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <ChartCard title="Beneficios por día del evento" data={stats.data.by_day} xKey="date" xLabel="Día" stacked
              formatX={(v) => String(v).slice(5)}
              series={[{ key: 'consumed', label: 'Consumidos' }, { key: 'pending', label: 'Pendientes' }, { key: 'expired', label: 'Expirados' }]} />
            <ChartCard title="Consumos por hora (Colombia)" data={stats.data.by_hour} xKey="hour" xLabel="Hora"
              formatX={(v) => `${String(v).padStart(2, '0')}h`} series={[{ key: 'count', label: 'Consumos' }]} />
            <ChartCard title="Consumos por operador" data={stats.data.by_operator.slice(0, 15)} xKey="operator" xLabel="Operador" horizontal
              series={[{ key: 'count', label: 'Consumos' }]} />
            <ChartCard title="Consumos por tipo de acceso" data={stats.data.by_access_type} xKey="tipo_acceso" xLabel="Tipo de acceso" horizontal
              series={[{ key: 'count', label: 'Consumos' }]} />
          </div>
        </>
      )}
    </div>
  )
}

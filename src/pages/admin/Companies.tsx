import { useEffect, useState } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { Badge, Button, Card, Checkbox, ErrorBox, Field, Input, Modal, PageHeader, Pagination, Select, Spinner } from '@/components/ui'
import { useAuth } from '@/lib/auth'
import { fmtDateTime } from '@/lib/format'
import { query, rpc, supabase } from '@/lib/supabase'
import { PERMISSIONS as P, type EventDay } from '@/lib/types'
import type { CompanyInput } from '@/lib/companyImport'
import { downloadCsv } from '@/lib/csv'
import { CompanyImport } from './CompanyImport'

type Company = CompanyInput & { id: string; active: boolean }
type Balance = { id: string; company_id: string; event_day_id: string; effi_id: string; name: string; date: string; quota: number; delivered: number; remaining: number; eligible: boolean }
type Delivery = { id: string; company_day_id: string; quantity: number; operator_label: string; delivered_at: string }
const PAGE = 50

export default function Companies() {
  const { can } = useAuth()
  const qc = useQueryClient()
  const [search, setSearch] = useState(''), [page, setPage] = useState(1)
  const [editing, setEditing] = useState<Company | 'new' | null>(null)
  const [inspecting, setInspecting] = useState<Balance | null>(null)
  const [historyPage, setHistoryPage] = useState(1)
  const [day, setDay] = useState('')
  const canRead = can(P.attendeesRead)
  const [tab, setTab] = useState<'companies' | 'balances' | 'import'>(canRead ? 'companies' : 'import')
  const days = useQuery({ queryKey: ['event-days'], queryFn: async () => (await query<EventDay[]>(supabase.from('event_days').select('*').order('date'))).data })
  const companies = useQuery({
    queryKey: ['drink-companies', search, page], enabled: canRead,
    queryFn: () => query<Company[]>(supabase.from('drink_companies').select('*', { count: 'exact' }).ilike('name', `%${search}%`).order('name').range((page - 1) * PAGE, page * PAGE - 1)),
    placeholderData: keepPreviousData,
  })
  const balances = useQuery({
    queryKey: ['company-balances', day, page], enabled: canRead && tab === 'balances', refetchInterval: 15_000,
    queryFn: () => {
      let req = supabase.from('company_drink_balances').select('*', { count: 'exact' }).order('date', { ascending: false }).order('name')
      if (day) req = req.eq('event_day_id', day)
      return query<Balance[]>(req.range((page - 1) * PAGE, page * PAGE - 1))
    },
  })
  const history = useQuery({ queryKey: ['company-deliveries', inspecting?.id, historyPage], enabled: !!inspecting && can(P.consumptionsRead),
    queryFn: () => query<Delivery[]>(supabase.from('company_drink_deliveries').select('*', { count: 'exact' }).eq('company_day_id', inspecting!.id).order('delivered_at', { ascending: false }).range((historyPage - 1) * PAGE, historyPage * PAGE - 1)) })
  return (
    <div className="space-y-4">
      <PageHeader title="Empresas y bebidas" subtitle="Cupo diario por empresa = cantidad de usuarios. Las entregas parciales descuentan el saldo."
        actions={can(P.attendeesWrite) && <Button onClick={() => setEditing('new')}>Nueva empresa</Button>} />
      <div className="flex flex-wrap gap-2">
        {canRead && <><Button variant={tab === 'companies' ? 'primary' : 'secondary'} onClick={() => { setTab('companies'); setPage(1) }}>Empresas</Button>
          <Button variant={tab === 'balances' ? 'primary' : 'secondary'} onClick={() => { setTab('balances'); setPage(1) }}>Cupos y entregas por día</Button></>}
        {can(P.attendeesImport) && <Button variant={tab === 'import' ? 'primary' : 'secondary'} onClick={() => setTab('import')}>Importar empresas</Button>}
      </div>
      <ErrorBox error={days.error} />
      {tab === 'import' && can(P.attendeesImport) && <CompanyImport days={days.data ?? []} />}
      {tab === 'companies' && canRead && <Card>
        <Field label="Buscar empresa por nombre"><Input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1) }} /></Field>
        <ErrorBox error={companies.error} />{companies.isLoading && <Spinner />}
        <div className="mt-4 overflow-x-auto"><table className="table-base"><thead><tr><th>ID Effi</th><th>Empresa</th><th>Correo</th><th>Usuarios / bebidas al día</th><th>Estado</th><th /></tr></thead>
          <tbody>{companies.data?.data.map((c) => <tr key={c.id}><td>{c.effi_id}</td><td>{c.name}</td><td>{c.email ?? '—'}</td><td>{c.user_count}</td><td><Badge tone={c.active ? 'ok' : 'neutral'}>{c.active ? 'Activa' : 'Inactiva'}</Badge></td>
            <td>{can(P.attendeesWrite) && <Button size="sm" variant="secondary" onClick={() => setEditing(c)}>Editar / días</Button>}</td></tr>)}</tbody></table></div>
        {companies.data?.count === 0 && <p className="py-4 text-sm text-muted">No hay empresas registradas. Crea una o importa el archivo de empresas.</p>}
        <Pagination page={page} pageSize={PAGE} total={companies.data?.count ?? 0} onPage={setPage} />
      </Card>}
      {tab === 'balances' && canRead && <Card>
        <Field label="Día"><Select value={day} onChange={(e) => { setDay(e.target.value); setPage(1) }}><option value="">Todos los días</option>{days.data?.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.date}</option>)}</Select></Field>
        <ErrorBox error={balances.error} />{balances.isLoading && <Spinner />}
        <Button className="mt-3" variant="secondary" disabled={!balances.data?.data.length} onClick={() => downloadCsv('cupos-empresas-pagina.csv', balances.data!.data.map((b) => ({ empresa: b.name, id_effi: b.effi_id, fecha: b.date, cupo: b.quota, entregadas: b.delivered, disponibles: b.remaining })))}>CSV de esta página</Button>
        <div className="mt-4 overflow-x-auto"><table className="table-base"><thead><tr><th>Empresa</th><th>Día</th><th>Cupo</th><th>Entregadas</th><th>Disponibles</th><th>Habilitado</th><th /></tr></thead>
          <tbody>{balances.data?.data.map((b) => <tr key={b.id}><td>{b.name}<br /><span className="text-xs text-muted">{b.effi_id}</span></td><td>{b.date}</td><td>{b.quota}</td><td>{b.delivered}</td><td>{b.remaining}</td><td>{b.eligible ? 'Sí' : 'No'}</td>
            <td>{can(P.consumptionsRead) && <Button size="sm" variant="secondary" onClick={() => { setHistoryPage(1); setInspecting(b) }}>Ver entregas</Button>}</td></tr>)}</tbody></table></div>
        <Pagination page={page} pageSize={PAGE} total={balances.data?.count ?? 0} onPage={setPage} />
      </Card>}
      {editing && <CompanyModal company={editing === 'new' ? null : editing} days={days.data ?? []} onClose={() => setEditing(null)} onSaved={() => {
        setEditing(null); void qc.invalidateQueries({ queryKey: ['drink-companies'] }); void qc.invalidateQueries({ queryKey: ['company-balances'] })
      }} />}
      {inspecting && <Modal open title={`Entregas: ${inspecting.name} · ${inspecting.date}`} onClose={() => setInspecting(null)} size="lg">
        <ErrorBox error={history.error} />{history.isLoading && <Spinner />}
        <table className="table-base"><thead><tr><th>Hora</th><th>Bebidas</th><th>Operador</th></tr></thead><tbody>{history.data?.data.map((d) => <tr key={d.id}><td>{fmtDateTime(d.delivered_at)}</td><td>{d.quantity}</td><td>{d.operator_label}</td></tr>)}</tbody></table>
        <Pagination page={historyPage} pageSize={PAGE} total={history.data?.count ?? 0} onPage={setHistoryPage} />
        {history.data?.count === 0 && <p className="py-3 text-sm text-muted">Sin entregas registradas.</p>}
      </Modal>}
    </div>
  )
}

function CompanyModal({ company, days, onClose, onSaved }: { company: Company | null; days: EventDay[]; onClose: () => void; onSaved: () => void }) {
  const [id, setId] = useState(company?.effi_id ?? ''), [name, setName] = useState(company?.name ?? '')
  const [email, setEmail] = useState(company?.email ?? ''), [count, setCount] = useState(String(company?.user_count ?? 1))
  const [active, setActive] = useState(company?.active ?? true), [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null)
  const assigned = useQuery({ queryKey: ['company-assigned-days', company?.id], enabled: !!company,
    queryFn: async () => (await query<{ event_day_id: string; eligible: boolean }[]>(supabase.from('company_drink_days').select('event_day_id,eligible').eq('company_id', company!.id))).data })
  useEffect(() => { if (assigned.data) setSelected(assigned.data.filter((p) => p.eligible).map((p) => p.event_day_id)) }, [assigned.data])
  const save = async () => {
    setBusy(true); setError(null)
    try { await rpc('upsert_drink_company', { p_data: { effi_id: id, name, email, user_count: count.trim() || '1', active }, p_event_day_ids: selected }); onSaved() }
    catch (err) { setError(err) } finally { setBusy(false) }
  }
  return <Modal open title={company ? 'Editar empresa y cupo diario' : 'Nueva empresa'} onClose={onClose} footer={<Button loading={busy} disabled={!id.trim() || !name.trim() || (!!company && !assigned.data)} onClick={() => void save()}>Guardar empresa</Button>}>
    <div className="space-y-3">
      <Field label="ID Effi de empresa"><Input value={id} disabled={!!company || busy} maxLength={64} onChange={(e) => setId(e.target.value)} /></Field>
      <Field label="Nombre fiscal"><Input value={name} disabled={busy} maxLength={200} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Correo de la empresa (opcional)"><Input type="email" value={email} disabled={busy} onChange={(e) => setEmail(e.target.value)} /></Field>
      <Field label="Cantidad de usuarios / bebidas por día" hint="Si se deja vacía, se asigna 1. No se permite bajar de lo ya entregado hoy."><Input type="number" min={1} max={100000} step={1} value={count} disabled={busy} onChange={(e) => setCount(e.target.value)} /></Field>
      <Checkbox label="Empresa activa" checked={active} onChange={setActive} />
      <fieldset disabled={busy}><legend className="mb-2 text-sm font-semibold">Días elegibles</legend>{days.map((d) => <Checkbox key={d.id} label={`${d.name} · ${d.date}`} checked={selected.includes(d.id)} onChange={(v) => setSelected((ids) => v ? [...ids, d.id] : ids.filter((x) => x !== d.id))} />)}</fieldset>
      {!selected.length && <p className="text-xs text-warn">Sin días asignados, la empresa no podrá reclamar bebidas.</p>}
      <ErrorBox error={error ?? assigned.error} />
    </div>
  </Modal>
}

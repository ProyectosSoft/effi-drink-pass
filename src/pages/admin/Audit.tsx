import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Fragment, useState } from 'react'
import { Badge, ErrorBox, Field, Input, PageHeader, Pagination, Select, Spinner } from '@/components/ui'
import { fmtDateTime } from '@/lib/format'
import { query, supabase } from '@/lib/supabase'

type Row = {
  id: number; occurred_at: string; actor_type: string; actor_label: string | null; action: string; resource_type: string | null
  resource_id: string | null; success: boolean; ip: string | null; user_agent: string | null; metadata: Record<string, unknown>
}
const PAGE = 50
const ACTIONS = [
  'LOGIN', 'LOGOUT', 'CREATE_ATTENDEE', 'UPDATE_ATTENDEE', 'IMPORT_ATTENDEES', 'SET_ELIGIBILITY', 'ASSIGN_DAY_BULK', 'VALIDATE_QR',
  'REDEEM_BENEFIT', 'FAILED_REDEEM', 'OVERRIDE_REDEEM', 'CANCEL_BENEFIT', 'RESTORE_BENEFIT', 'REGENERATE_TOKEN', 'GENERATE_BENEFITS',
  'EXPIRE_BENEFITS', 'CREATE_INTEGRATION', 'UPDATE_INTEGRATION', 'DISABLE_INTEGRATION', 'ENABLE_INTEGRATION', 'CREATE_API_KEY',
  'ROTATE_API_KEY', 'REVOKE_API_KEY', 'API_TOKEN_ISSUED', 'API_AUTH_FAILED', 'CHANGE_ROLE', 'CHANGE_ROLE_PERMISSIONS', 'CREATE_ROLE',
  'UPDATE_ROLE', 'CREATE_USER', 'UPDATE_USER', 'CREATE_EVENT_DAY', 'UPDATE_EVENT_DAY', 'UPDATE_SETTINGS', 'EXPORT_REPORT', 'SCANNER_OPENED',
]

export default function Audit() {
  const [action, setAction] = useState('')
  const [actor, setActor] = useState('')
  const [resource, setResource] = useState('')
  const [from, setFrom] = useState('')
  const [onlyFailed, setOnlyFailed] = useState(false)
  const [page, setPage] = useState(1)
  const [open, setOpen] = useState<number | null>(null)

  const list = useQuery({
    queryKey: ['audit', action, actor, resource, from, onlyFailed, page],
    placeholderData: keepPreviousData,
    queryFn: () => {
      let q = supabase.from('audit_logs').select('*', { count: 'exact' })
      if (action) q = q.eq('action', action)
      if (actor.trim()) q = q.ilike('actor_label', `%${actor.trim().replace(/[%_\\]/g, '')}%`)
      if (resource.trim()) q = q.eq('resource_id', resource.trim())
      if (from) q = q.gte('occurred_at', `${from}T05:00:00Z`)
      if (onlyFailed) q = q.eq('success', false)
      return query<Row[]>(q.order('occurred_at', { ascending: false }).range((page - 1) * PAGE, page * PAGE - 1))
    },
  })

  return (
    <div>
      <PageHeader title="Auditoría" subtitle="Registro inmutable de eventos del sistema (no se puede editar ni borrar)" />
      <div className="card mb-4 grid grid-cols-2 gap-3 p-4 lg:grid-cols-5">
        <Field label="Acción"><Select value={action} onChange={(e) => { setAction(e.target.value); setPage(1) }}>
          <option value="">Todas</option>
          {ACTIONS.map((a) => <option key={a}>{a}</option>)}
        </Select></Field>
        <Field label="Actor"><Input value={actor} onChange={(e) => { setActor(e.target.value); setPage(1) }} placeholder="Nombre o integración" /></Field>
        <Field label="ID de recurso"><Input value={resource} onChange={(e) => { setResource(e.target.value); setPage(1) }} /></Field>
        <Field label="Desde"><Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1) }} /></Field>
        <Field label="Resultado"><Select value={onlyFailed ? 'f' : ''} onChange={(e) => { setOnlyFailed(e.target.value === 'f'); setPage(1) }}>
          <option value="">Todos</option><option value="f">Solo fallidos</option>
        </Select></Field>
      </div>
      <ErrorBox error={list.error} />
      <div className="card overflow-x-auto p-2">
        {list.isLoading ? <Spinner /> : (
          <table className="table-base min-w-[860px]">
            <thead><tr><th>Fecha</th><th>Acción</th><th>Actor</th><th>Recurso</th><th>IP</th><th /></tr></thead>
            <tbody>
              {list.data?.data.map((r) => (
                <Fragment key={r.id}>
                  <tr className="cursor-pointer" onClick={() => setOpen(open === r.id ? null : r.id)}>
                    <td className="whitespace-nowrap tabular-nums">{fmtDateTime(r.occurred_at)}</td>
                    <td><Badge tone={r.success ? 'neutral' : 'bad'}>{r.action}</Badge></td>
                    <td>{r.actor_label ?? '—'} <span className="text-xs text-faint">({r.actor_type})</span></td>
                    <td className="max-w-[16rem] truncate font-mono text-xs text-muted">{r.resource_type}{r.resource_id ? ` · ${r.resource_id}` : ''}</td>
                    <td className="font-mono text-xs text-muted">{r.ip ?? '—'}</td>
                    <td className="text-xs text-brand">{open === r.id ? 'ocultar' : 'detalle'}</td>
                  </tr>
                  {open === r.id && (
                    <tr><td colSpan={6} className="bg-surface-2/50">
                      <pre className="max-h-80 overflow-auto text-xs whitespace-pre-wrap text-muted">{JSON.stringify({ ...r.metadata, user_agent: r.user_agent }, null, 2)}</pre>
                    </td></tr>
                  )}
                </Fragment>
              ))}
              {list.data?.data.length === 0 && <tr><td colSpan={6} className="py-8 text-center text-muted">Sin eventos</td></tr>}
            </tbody>
          </table>
        )}
        {list.data && <div className="px-2"><Pagination page={page} pageSize={PAGE} total={list.data.count} onPage={setPage} /></div>}
      </div>
    </div>
  )
}

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileSpreadsheet, Plus, Search, Users } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { AttendeeForm } from '@/components/AttendeeForm'
import { Badge, Button, EmptyState, ErrorBox, Input, Modal, PageHeader, Pagination, Select, Spinner } from '@/components/ui'
import { useAuth } from '@/lib/auth'
import { fullName } from '@/lib/format'
import { query, supabase } from '@/lib/supabase'
import { PERMISSIONS as P, type Attendee, type EventDay } from '@/lib/types'

/** Tamaño de página del listado. */
const PAGE = 25

/**
 * Escapa comodines de ILIKE y caracteres especiales del filtro or() de PostgREST.
 * Las comas y paréntesis se reemplazan por espacios porque romperían la sintaxis de or()
 * y permitirían inyectar condiciones adicionales en el filtro.
 */
function likeSafe(s: string) {
  return s.replace(/[%_\\]/g, (m) => `\\${m}`).replace(/[,()*]/g, ' ').trim()
}

/**
 * /admin/attendees — listado paginado de asistentes con búsqueda y filtros.
 * Requiere `attendeesRead`. Con `attendeesImport` muestra el acceso a Importar y con
 * `attendeesWrite` permite crear asistentes (modal con AttendeeForm).
 * Consulta la tabla `attendees` directamente (RLS en el servidor aplica los permisos).
 */
export default function Attendees() {
  const { can } = useAuth()
  const nav = useNavigate()
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [tipo, setTipo] = useState('')
  const [activo, setActivo] = useState('')
  const [page, setPage] = useState(1)
  const [creating, setCreating] = useState(false)

  // Debounce de 300 ms de la búsqueda; al cambiar el término se vuelve a la página 1.
  useEffect(() => {
    const t = setTimeout(() => { setDebounced(search); setPage(1) }, 300)
    return () => clearTimeout(t)
  }, [search])

  const list = useQuery({
    // Prefijo 'attendees' compartido: invalidarlo refresca todas las páginas/filtros cacheados.
    queryKey: ['attendees', debounced, tipo, activo, page],
    // Mantiene la página anterior visible mientras carga la siguiente (sin parpadeo).
    placeholderData: keepPreviousData,
    queryFn: async () => {
      let q = supabase.from('attendees').select('*', { count: 'exact' })
      const s = likeSafe(debounced)
      if (s) q = q.or(`nombres.ilike.%${s}%,apellidos.ilike.%${s}%,email.ilike.%${s}%,effi_id.ilike.%${s}%,effi_username.ilike.%${s}%,empresa.ilike.%${s}%`)
      if (tipo) q = q.eq('tipo_acceso', tipo)
      if (activo) q = q.eq('activo', activo === 'true')
      // range() es inclusivo en ambos extremos; count: 'exact' alimenta la paginación.
      return query<Attendee[]>(q.order('apellidos').order('nombres').range((page - 1) * PAGE, page * PAGE - 1))
    },
  })
  // Días del evento para el formulario de alta (comparte caché 'event-days' con otras pantallas).
  const days = useQuery({
    queryKey: ['event-days'],
    queryFn: async () => (await query<EventDay[]>(supabase.from('event_days').select('*').order('date'))).data,
  })

  return (
    <div>
      <PageHeader title="Asistentes" subtitle={list.data ? `${list.data.count} registros` : undefined} actions={<>
        {can(P.attendeesImport) && <Link to="/admin/import"><Button variant="secondary" icon={<FileSpreadsheet className="size-4" />}>Importar</Button></Link>}
        {can(P.attendeesWrite) && <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>Nuevo asistente</Button>}
      </>} />

      <div className="card mb-4 grid gap-3 p-4 sm:grid-cols-[1fr_180px_160px]">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
          <Input className="pl-9" placeholder="Buscar por nombre, email, ID Effi, usuario Effi o empresa" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Buscar" />
        </div>
        <Input placeholder="Tipo de acceso" value={tipo} onChange={(e) => { setTipo(e.target.value.toUpperCase()); setPage(1) }} aria-label="Tipo de acceso" />
        <Select value={activo} onChange={(e) => { setActivo(e.target.value); setPage(1) }} aria-label="Estado">
          <option value="">Activos e inactivos</option>
          <option value="true">Solo activos</option>
          <option value="false">Solo inactivos</option>
        </Select>
      </div>

      <ErrorBox error={list.error} />
      <div className="card overflow-x-auto p-2">
        {list.isLoading ? <Spinner /> : list.data?.data.length === 0 ? (
          <EmptyState title="Sin asistentes" icon={<Users className="size-10" />}>Importa un archivo o crea el primero.</EmptyState>
        ) : (
          <table className="table-base min-w-[760px]">
            <thead><tr><th>Nombre</th><th>Email</th><th>ID Effi</th><th>Usuario Effi</th><th>Acceso</th><th>Empresa</th><th>Estado</th></tr></thead>
            <tbody>
              {list.data?.data.map((a) => (
                <tr key={a.id} className="cursor-pointer" onClick={() => nav(`/admin/attendees/${a.id}`)}>
                  <td className="font-medium">
                    {/* stopPropagation evita navegar dos veces (Link + onClick de la fila). */}
                    <Link to={`/admin/attendees/${a.id}`} className="hover:text-brand" onClick={(e) => e.stopPropagation()}>{fullName(a)}</Link>
                    {a.is_demo && <Badge tone="accent" className="ml-2">DEMO</Badge>}
                  </td>
                  <td className="text-muted">{a.email ?? '—'}</td>
                  <td className="font-mono">{a.effi_id ?? '—'}</td>
                  <td>{a.effi_username ?? '—'}</td>
                  <td><Badge>{a.tipo_acceso}</Badge></td>
                  <td className="text-muted">{a.empresa ?? '—'}</td>
                  <td>{a.activo ? <Badge tone="ok">Activo</Badge> : <Badge tone="bad">Inactivo</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {list.data && <div className="px-2"><Pagination page={page} pageSize={PAGE} total={list.data.count} onPage={setPage} /></div>}
      </div>

      <Modal open={creating} onClose={() => setCreating(false)} title="Nuevo asistente" size="lg">
        <AttendeeForm eventDays={days.data} onCancel={() => setCreating(false)} onSaved={(id) => {
          setCreating(false)
          void qc.invalidateQueries({ queryKey: ['attendees'] })
          nav(`/admin/attendees/${id}`)
        }} />
      </Modal>
    </div>
  )
}

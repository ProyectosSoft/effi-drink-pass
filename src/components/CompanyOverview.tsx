import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { Card, ErrorBox, Stat } from './ui'
import { rpc } from '@/lib/supabase'
import { useAuth } from '@/lib/auth'
import { PERMISSIONS as P } from '@/lib/types'

export function CompanyOverview() {
  const { can } = useAuth()
  const q = useQuery({ queryKey: ['company-statistics'], queryFn: () => rpc<{ date: string; companies: number; quota: number; delivered: number; remaining: number }>('get_company_drink_statistics'), refetchInterval: 15_000 })
  return <div className="my-5"><Card title={`Bebidas de empresas de hoy${q.data ? ` · ${q.data.date}` : ''}`}>
    <ErrorBox error={q.error} />
    {q.data && <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Stat label="Empresas con día asignado" value={q.data.companies} />
      <Stat label="Cupos asignados" value={q.data.quota} />
      <Stat label="Bebidas entregadas" value={q.data.delivered} />
      <Stat label="Saldo de empresas habilitadas" value={q.data.remaining} />
    </div>}
    {can(P.attendeesRead) && <Link to="/admin/companies" className="mt-4 block text-sm text-brand underline">Ver empresas, cupos y entregas</Link>}
  </Card></div>
}

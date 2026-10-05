import { LayoutDashboard, QrCode, ScanLine, UserX } from 'lucide-react'
import { Link, Navigate } from 'react-router'
import { Button, EmptyState } from '@/components/ui'
import { useAuth } from '@/lib/auth'
import { PERMISSIONS as P } from '@/lib/types'

/**
 * /dashboard: distribuye según el tipo de cuenta (asistente, staff o ambos).
 * · Solo asistente → /my-benefits.
 * · Solo staff → /admin si puede ver estadísticas (`statisticsRead`); si no, directo al scanner.
 * · Ninguno de los dos → aviso de que el email no está registrado.
 * · Ambos → tarjetas para elegir entre beneficios propios y panel de administración.
 */
export default function Dashboard() {
  const { access, isStaff, isAttendee, can, session } = useAuth()

  // Redirecciones con `replace` para que "atrás" no vuelva a este distribuidor.
  if (isAttendee && !isStaff) return <Navigate to="/my-benefits" replace />
  if (isStaff && !isAttendee) return <Navigate to={can(P.statisticsRead) ? '/admin' : '/admin/scanner'} replace />

  if (!isStaff && !isAttendee) {
    return (
      <EmptyState title="No encontramos beneficios para tu cuenta" icon={<UserX className="size-10" />}>
        <p>
          Iniciaste sesión como <strong className="text-ink">{session?.user.email}</strong>, pero ese email no está registrado como asistente
          ni como staff. Verifica que sea el mismo email con el que te inscribiste en la feria o acércate al punto de información.
        </p>
      </EmptyState>
    )
  }

  return (
    <div className="mx-auto mt-8 grid max-w-2xl gap-4 sm:grid-cols-2">
      <div className="card p-6">
        <QrCode className="mb-3 size-7 text-brand" />
        <h2 className="font-semibold">Mis beneficios</h2>
        <p className="mt-1 text-sm text-muted">Hola {access?.attendee?.nombres}. Abre tu QR del día.</p>
        <Link to="/my-benefits" className="mt-4 block"><Button className="w-full">Ver beneficios</Button></Link>
      </div>
      <div className="card p-6">
        {can(P.statisticsRead) ? <LayoutDashboard className="mb-3 size-7 text-accent" /> : <ScanLine className="mb-3 size-7 text-accent" />}
        <h2 className="font-semibold">Administración</h2>
        <p className="mt-1 text-sm text-muted">Roles: {access?.roles.join(', ')}</p>
        <Link to="/admin" className="mt-4 block"><Button variant="secondary" className="w-full">Ir al panel</Button></Link>
      </div>
    </div>
  )
}

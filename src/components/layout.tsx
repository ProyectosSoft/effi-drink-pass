import { clsx } from 'clsx'
import {
  BarChart3, ClipboardList, Cog, FileSpreadsheet, GlassWater, KeyRound, LayoutDashboard, LogOut, Menu, QrCode, Receipt,
  ScanLine, Shield, Ticket, UserCog, Users, X,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, NavLink, Navigate, Outlet, useLocation } from 'react-router'
import { useAuth } from '@/lib/auth'
import { PERMISSIONS as P } from '@/lib/types'
import { Button, EmptyState, Spinner } from './ui'

export function Logo({ compact }: { compact?: boolean }) {
  return (
    <Link to="/" className="flex items-center gap-2.5 font-bold tracking-tight">
      <span className="brand-gradient grid size-9 place-items-center rounded-xl text-bg shadow-lg shadow-brand-2/30">
        <GlassWater className="size-5" strokeWidth={2.5} aria-hidden />
      </span>
      {!compact && (
        <span className="leading-tight">
          <span className="block text-sm">Effi Drink Pass</span>
          <span className="block text-[11px] font-medium text-muted">Feria Effix 2026</span>
        </span>
      )}
    </Link>
  )
}

export function PublicShell({ children }: { children: ReactNode }) {
  const { session, isStaff } = useAuth()
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-4">
        <Logo />
        <nav className="flex items-center gap-2 text-sm">
          {session ? (
            <>
              {isStaff && <Link className="rounded-lg px-3 py-2 text-muted hover:text-ink" to="/admin">Admin</Link>}
              <Link className="rounded-lg px-3 py-2 text-muted hover:text-ink" to="/dashboard">Mi cuenta</Link>
            </>
          ) : (
            <Link to="/login"><Button size="sm">Ingresar</Button></Link>
          )}
        </nav>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-12">{children}</main>
      <footer className="border-t border-line py-6 text-center text-xs text-faint">
        Effi Drink Pass · Sistema independiente de beneficios · Feria Effix 2026
      </footer>
    </div>
  )
}

/** Exige sesión iniciada. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { loading, session } = useAuth()
  const loc = useLocation()
  if (loading) return <Spinner />
  if (!session) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />
  return <>{children}</>
}

/** Exige uno de los permisos indicados. */
export function RequirePermission({ anyOf, children }: { anyOf: string[]; children: ReactNode }) {
  const { can } = useAuth()
  if (!anyOf.some(can)) {
    return (
      <EmptyState title="Sin acceso" icon={<Shield className="size-10" />}>
        Tu usuario no tiene permiso para ver esta sección. Si crees que es un error, contacta a un administrador.
      </EmptyState>
    )
  }
  return <>{children}</>
}

type NavItem = { to: string; label: string; icon: ReactNode; perms: string[]; end?: boolean }

const NAV: NavItem[] = [
  { to: '/admin', label: 'Dashboard', icon: <LayoutDashboard className="size-4" />, perms: [P.statisticsRead], end: true },
  { to: '/admin/scanner', label: 'Scanner', icon: <ScanLine className="size-4" />, perms: [P.benefitsValidate, P.benefitsRedeem] },
  { to: '/admin/attendees', label: 'Asistentes', icon: <Users className="size-4" />, perms: [P.attendeesRead] },
  { to: '/admin/benefits', label: 'Beneficios', icon: <Ticket className="size-4" />, perms: [P.benefitsRead] },
  { to: '/admin/consumptions', label: 'Consumos', icon: <Receipt className="size-4" />, perms: [P.consumptionsRead] },
  { to: '/admin/import', label: 'Importación', icon: <FileSpreadsheet className="size-4" />, perms: [P.attendeesImport] },
  { to: '/admin/reports', label: 'Reportes', icon: <BarChart3 className="size-4" />, perms: [P.reportsRead] },
  { to: '/admin/users', label: 'Usuarios', icon: <UserCog className="size-4" />, perms: [P.usersManage] },
  { to: '/admin/roles', label: 'Roles', icon: <Shield className="size-4" />, perms: [P.rolesManage, P.usersManage] },
  { to: '/admin/integrations', label: 'Integraciones', icon: <KeyRound className="size-4" />, perms: [P.integrationsManage] },
  { to: '/admin/audit', label: 'Auditoría', icon: <ClipboardList className="size-4" />, perms: [P.auditRead] },
  { to: '/admin/settings', label: 'Configuración', icon: <Cog className="size-4" />, perms: [P.settingsManage, P.eventDaysWrite] },
]

export function AdminShell() {
  const { access, can, signOut, isAttendee } = useAuth()
  const [open, setOpen] = useState(false)
  const loc = useLocation()
  const items = NAV.filter((n) => n.perms.some(can))
  const fullscreen = loc.pathname.startsWith('/admin/scanner')

  const nav = (
    <nav className="flex flex-col gap-1" aria-label="Administración">
      {items.map((n) => (
        <NavLink key={n.to} to={n.to} end={n.end} onClick={() => setOpen(false)}
          className={({ isActive }) => clsx('flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition',
            isActive ? 'bg-brand/10 font-semibold text-brand' : 'text-muted hover:bg-surface-2 hover:text-ink')}>
          {n.icon} {n.label}
        </NavLink>
      ))}
      <div className="my-2 border-t border-line" />
      {isAttendee && (
        <NavLink to="/my-benefits" className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-muted hover:bg-surface-2 hover:text-ink">
          <QrCode className="size-4" /> Mis beneficios
        </NavLink>
      )}
      <NavLink to="/account" className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-muted hover:bg-surface-2 hover:text-ink">
        <UserCog className="size-4" /> Mi cuenta
      </NavLink>
      <button onClick={signOut} className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-muted hover:bg-surface-2 hover:text-ink">
        <LogOut className="size-4" /> Cerrar sesión
      </button>
    </nav>
  )

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[260px_1fr]">
      <aside className="sticky top-0 hidden h-dvh flex-col gap-6 overflow-y-auto border-r border-line bg-surface/50 p-4 lg:flex">
        <Logo />
        <div className="rounded-xl bg-surface-2 px-3 py-2.5 text-xs">
          <p className="truncate font-semibold">{access?.profile ? `${access.profile.nombres} ${access.profile.apellidos}` : '—'}</p>
          <p className="truncate text-muted">{access?.roles.join(', ') || 'sin rol'}</p>
        </div>
        {nav}
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex items-center justify-between border-b border-line bg-bg/85 px-4 py-3 backdrop-blur lg:hidden">
          <Logo compact />
          <p className="truncate px-3 text-sm font-semibold">{items.find((i) => (i.end ? loc.pathname === i.to : loc.pathname.startsWith(i.to)))?.label ?? 'Admin'}</p>
          <button onClick={() => setOpen(true)} aria-label="Abrir menú" className="rounded-lg p-2 hover:bg-surface-2"><Menu className="size-5" /></button>
        </header>
        {open && (
          <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true">
            <div className="absolute inset-0 bg-black/70" onClick={() => setOpen(false)} />
            <div className="absolute inset-y-0 right-0 flex w-72 flex-col gap-4 overflow-y-auto border-l border-line bg-surface p-4">
              <div className="flex items-center justify-between">
                <Logo />
                <button onClick={() => setOpen(false)} aria-label="Cerrar menú" className="rounded-lg p-2 hover:bg-surface-2"><X className="size-5" /></button>
              </div>
              {nav}
            </div>
          </div>
        )}
        <main className={clsx('min-w-0 flex-1', fullscreen ? 'p-0 sm:p-4' : 'p-4 sm:p-6 lg:p-8')}>
          <Outlet />
        </main>
      </div>
    </div>
  )
}

/** Solo staff activo con algún permiso. */
export function RequireStaff({ children }: { children: ReactNode }) {
  const { isStaff, access } = useAuth()
  if (!isStaff) {
    return (
      <PublicShell>
        <EmptyState title="Área exclusiva del staff" icon={<Shield className="size-10" />}>
          {access?.attendee
            ? <>Tu cuenta es de asistente. <Link className="text-brand underline" to="/my-benefits">Ver mis beneficios</Link>.</>
            : 'Tu usuario no tiene un rol de staff asignado o está inactivo.'}
        </EmptyState>
      </PublicShell>
    )
  }
  return <>{children}</>
}

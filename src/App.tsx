import { lazy, Suspense, type ReactNode } from 'react'
import { Navigate, Route, Routes } from 'react-router'
import { AdminShell, PublicShell, RequireAuth, RequirePermission, RequireStaff } from './components/layout'
import { Spinner } from './components/ui'
import { useAuth } from './lib/auth'
import { PERMISSIONS as P } from './lib/types'
import { Landing } from './pages/Landing'
import { Login } from './pages/Login'
import { NotFound } from './pages/NotFound'

const Dashboard = lazy(() => import('./pages/Dashboard'))
const MyBenefits = lazy(() => import('./pages/MyBenefits'))
const QrLanding = lazy(() => import('./pages/QrLanding'))
const Account = lazy(() => import('./pages/Account'))
const ApiDocs = lazy(() => import('./pages/ApiDocs'))
const AdminHome = lazy(() => import('./pages/admin/AdminHome'))
const Scanner = lazy(() => import('./pages/admin/Scanner'))
const Attendees = lazy(() => import('./pages/admin/Attendees'))
const AttendeeDetail = lazy(() => import('./pages/admin/AttendeeDetail'))
const Import = lazy(() => import('./pages/admin/Import'))
const Benefits = lazy(() => import('./pages/admin/Benefits'))
const Consumptions = lazy(() => import('./pages/admin/Consumptions'))
const Users = lazy(() => import('./pages/admin/Users'))
const Roles = lazy(() => import('./pages/admin/Roles'))
const Integrations = lazy(() => import('./pages/admin/Integrations'))
const Audit = lazy(() => import('./pages/admin/Audit'))
const Reports = lazy(() => import('./pages/admin/Reports'))
const Settings = lazy(() => import('./pages/admin/Settings'))

const guard = (perms: string[], el: ReactNode) => <RequirePermission anyOf={perms}>{el}</RequirePermission>

export function App() {
  return (
    <Suspense fallback={<Spinner />}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<Login />} />
        <Route path="/qr/:token" element={<QrLanding />} />
        <Route path="/r/:token" element={<QrLanding />} />
        <Route path="/api-docs" element={<ApiDocs />} />
        <Route path="/dashboard" element={<RequireAuth><PublicShell><Dashboard /></PublicShell></RequireAuth>} />
        <Route path="/my-benefits" element={<RequireAuth><MyBenefits /></RequireAuth>} />
        <Route path="/account" element={<RequireAuth><PublicShell><Account /></PublicShell></RequireAuth>} />

        <Route path="/admin" element={<RequireAuth><RequireStaff><AdminShell /></RequireStaff></RequireAuth>}>
          <Route index element={<AdminIndex />} />
          <Route path="scanner" element={guard([P.benefitsValidate, P.benefitsRedeem], <Scanner />)} />
          <Route path="attendees" element={guard([P.attendeesRead], <Attendees />)} />
          <Route path="attendees/:id" element={guard([P.attendeesRead], <AttendeeDetail />)} />
          <Route path="import" element={guard([P.attendeesImport], <Import />)} />
          <Route path="benefits" element={guard([P.benefitsRead], <Benefits />)} />
          <Route path="consumptions" element={guard([P.consumptionsRead], <Consumptions />)} />
          <Route path="users" element={guard([P.usersManage], <Users />)} />
          <Route path="roles" element={guard([P.rolesManage, P.usersManage], <Roles />)} />
          <Route path="integrations" element={guard([P.integrationsManage], <Integrations />)} />
          <Route path="audit" element={guard([P.auditRead], <Audit />)} />
          <Route path="reports" element={guard([P.reportsRead], <Reports />)} />
          <Route path="settings" element={guard([P.settingsManage, P.eventDaysWrite], <Settings />)} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  )
}

/** Operadores sin estadísticas van directo al scanner. */
function AdminIndex() {
  return (
    <RequirePermission anyOf={[P.statisticsRead, P.benefitsRedeem, P.benefitsValidate]}>
      <AdminIndexInner />
    </RequirePermission>
  )
}

function AdminIndexInner() {
  const { can } = useAuth()
  if (!can(P.statisticsRead)) return <Navigate to="/admin/scanner" replace />
  return <AdminHome />
}

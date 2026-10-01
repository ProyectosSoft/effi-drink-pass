export type BenefitStatus = 'PENDING' | 'CONSUMED' | 'EXPIRED' | 'CANCELLED'

export type EventDay = {
  id: string
  date: string
  name: string
  active: boolean
  start_time: string
  end_time: string
}

export type Attendee = {
  id: string
  nombres: string
  apellidos: string
  email: string | null
  telefono: string | null
  effi_id: string | null
  effi_username: string | null
  tipo_acceso: string
  empresa: string | null
  activo: boolean
  metadata: Record<string, unknown>
  is_demo: boolean
  created_at: string
  updated_at: string
}

export type Access = {
  authenticated: boolean
  auth_user_id?: string
  profile: { id: string; nombres: string; apellidos: string; email: string; activo: boolean } | null
  attendee: { id: string; nombres: string; apellidos: string; activo: boolean } | null
  roles: string[]
  permissions: string[]
}

export type ScanCode =
  | 'APPROVED' | 'VALID' | 'ALREADY_CONSUMED' | 'INVALID_QR' | 'BENEFIT_NOT_FOUND' | 'NOT_TODAY' | 'NOT_STARTED'
  | 'NOT_ELIGIBLE' | 'ATTENDEE_INACTIVE' | 'EXPIRED' | 'CANCELLED' | 'DAY_INACTIVE' | 'RATE_LIMITED'
  | 'IDEMPOTENCY_KEY_REUSED'

export type ScanResult = {
  ok: boolean
  code: ScanCode
  message: string
  mode?: 'validate' | 'redeem'
  server_time: string
  today?: string
  idempotent_replay?: boolean
  retry_after?: number
  benefit: {
    id: string
    status: BenefitStatus
    consumed_at: string | null
    event_day: { id: string; date: string; name: string; start_time: string; end_time: string }
  } | null
  attendee: {
    id: string
    nombres: string
    apellidos: string
    effi_id: string | null
    effi_username: string | null
    tipo_acceso: string
    empresa: string | null
  } | null
  consumption: { id: string; consumed_at: string; operator: string | null; is_override: boolean } | null
}

export type MyBenefits = {
  today: string
  server_time: string
  attendee: {
    id: string
    nombres: string
    apellidos: string
    email: string | null
    effi_id: string | null
    effi_username: string | null
    tipo_acceso: string
    empresa: string | null
    activo: boolean
  } | null
  benefits: {
    event_day: EventDay
    benefit_id: string | null
    status: BenefitStatus | null
    consumed_at: string | null
    eligible: boolean
    display_status: 'AVAILABLE' | 'CONSUMED' | 'NOT_AVAILABLE' | 'EXPIRED' | 'UPCOMING'
  }[]
}

export type Statistics = {
  generated_at: string
  today: string
  totals: {
    attendees: number
    attendees_inactive: number
    eligible_attendees: number
    benefits: number
    consumed: number
    pending: number
    expired: number
    cancelled: number
    consumptions: number
    consumed_today: number
  }
  by_day: { event_day_id: string; date: string; name: string; benefits: number; consumed: number; pending: number; expired: number; cancelled: number }[]
  by_hour: { hour: number; count: number }[]
  by_operator: { operator_id: string | null; integration_id: string | null; operator: string; count: number }[]
  by_access_type: { tipo_acceso: string; count: number }[]
  by_date: { date: string; count: number }[]
}

export const PERMISSIONS = {
  attendeesRead: 'attendees:read',
  attendeesWrite: 'attendees:write',
  attendeesImport: 'attendees:import',
  eventDaysWrite: 'event-days:write',
  benefitsRead: 'benefits:read',
  benefitsWrite: 'benefits:write',
  benefitsValidate: 'benefits:validate',
  benefitsRedeem: 'benefits:redeem',
  benefitsOverride: 'benefits:override',
  consumptionsRead: 'consumptions:read',
  statisticsRead: 'statistics:read',
  reportsRead: 'reports:read',
  auditRead: 'audit:read',
  usersManage: 'users:manage',
  rolesManage: 'roles:manage',
  integrationsManage: 'integrations:manage',
  settingsManage: 'settings:manage',
} as const

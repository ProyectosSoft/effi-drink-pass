/**
 * Tipos compartidos del frontend. Reflejan las filas de las tablas y los JSON que devuelven
 * las funciones RPC de Postgres; si cambia el SQL, deben actualizarse aquí a mano.
 */

/** Estado de un beneficio (una bebida por asistente y día del evento). */
export type BenefitStatus = 'PENDING' | 'CONSUMED' | 'EXPIRED' | 'CANCELLED'

/** Día del evento con su ventana horaria de canje (horas locales 'HH:MM:SS', zona America/Bogota). */
export type EventDay = {
  id: string
  date: string
  name: string
  active: boolean
  start_time: string
  end_time: string
}

/** Fila de la tabla de asistentes. */
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
  /** Registro sembrado como dato de demostración. */
  is_demo: boolean
  created_at: string
  updated_at: string
}

/**
 * Respuesta de las RPC `my_access` / `on_login`: quién es el usuario y qué puede hacer.
 * Un mismo usuario puede ser staff (profile + roles/permisos) y asistente a la vez.
 */
export type Access = {
  authenticated: boolean
  auth_user_id?: string
  profile: { id: string; nombres: string; apellidos: string; email: string; activo: boolean } | null
  attendee: { id: string; nombres: string; apellidos: string; activo: boolean } | null
  roles: string[]
  permissions: string[]
}

/** Códigos de resultado del escaneo/canje de un QR (los define el servidor). */
export type ScanCode =
  | 'APPROVED' | 'VALID' | 'ALREADY_CONSUMED' | 'INVALID_QR' | 'BENEFIT_NOT_FOUND' | 'NOT_TODAY' | 'NOT_STARTED'
  | 'NOT_ELIGIBLE' | 'ATTENDEE_INACTIVE' | 'EXPIRED' | 'CANCELLED' | 'DAY_INACTIVE' | 'RATE_LIMITED'
  | 'IDEMPOTENCY_KEY_REUSED'

/**
 * Resultado de validar (`validate`, solo consulta) o canjear (`redeem`) un QR.
 * Las fechas/horas siempre vienen del servidor para no depender del reloj del dispositivo.
 */
export type ScanResult = {
  ok: boolean
  code: ScanCode
  message: string
  mode?: 'validate' | 'redeem'
  server_time: string
  today?: string
  /** true si la respuesta es la repetición de un canje previo con la misma clave de idempotencia. */
  idempotent_replay?: boolean
  /** Segundos a esperar cuando code = RATE_LIMITED. */
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
  /** is_override = canje excepcional con motivo obligatorio (permiso benefits:override). */
  consumption: { id: string; consumed_at: string; operator: string | null; is_override: boolean } | null
}

/** Vista del asistente autenticado: sus datos y un beneficio por cada día del evento. */
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
    /** Estado ya resuelto por el servidor para mostrar (combina status, elegibilidad y fecha). */
    display_status: 'AVAILABLE' | 'CONSUMED' | 'NOT_AVAILABLE' | 'EXPIRED' | 'UPCOMING'
  }[]
}

/** Agregados del tablero de estadísticas (RPC de estadísticas, permiso statistics:read). */
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
  /** Canjes por operador humano (operator_id) o por integración de API (integration_id). */
  by_operator: { operator_id: string | null; integration_id: string | null; operator: string; count: number }[]
  by_access_type: { tipo_acceso: string; count: number }[]
  by_date: { date: string; count: number }[]
}

/**
 * Catálogo de permisos (formato `recurso:acción`), idéntico a los sembrados en la base de datos.
 * En el frontend solo se usan para mostrar u ocultar UI; la autorización real se valida en
 * Postgres (RLS y verificaciones dentro de cada RPC).
 */
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

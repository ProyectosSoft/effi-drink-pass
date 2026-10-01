import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { config, isConfigured } from './config'

export const supabase: SupabaseClient = isConfigured
  ? createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
    })
  : (null as unknown as SupabaseClient)

/** Error de aplicación con mensaje amigable en español. */
export class AppError extends Error {
  constructor(
    message: string,
    public code: string,
    public network = false,
  ) {
    super(message)
  }
}

const FRIENDLY: Record<string, string> = {
  FORBIDDEN: 'No tienes permiso para realizar esta acción.',
  UNAUTHENTICATED: 'Tu sesión expiró. Inicia sesión nuevamente.',
  NOT_FOUND: 'El registro no existe.',
  NOT_FOUND_OR_ALREADY_REVOKED: 'La credencial no existe o ya fue revocada.',
  REASON_REQUIRED: 'Debes indicar un motivo.',
  INVALID_STATUS_TRANSITION: 'El beneficio no está en un estado que permita esta acción.',
  LAST_SUPER_ADMIN: 'No se puede dejar el sistema sin un Super Admin activo.',
  CANNOT_DEACTIVATE_SELF: 'No puedes desactivar tu propio usuario.',
  PRIVILEGE_ESCALATION: 'No puedes otorgar permisos que tú no tienes.',
  ONLY_SUPER_ADMIN_CAN_MANAGE_SUPER_ADMIN: 'Solo un Super Admin puede otorgar o retirar el rol super_admin.',
  SUPER_ADMIN_ROLE_IMMUTABLE: 'El rol super_admin no se puede modificar.',
  SYSTEM_ROLE_NAME_IMMUTABLE: 'No se puede renombrar un rol del sistema.',
  INVALID_SCOPE: 'Uno de los scopes no se puede asignar a integraciones.',
  SCOPE_NOT_ALLOWED_FOR_INTEGRATION: 'Un scope no está permitido para esta integración.',
  SCOPES_REQUIRED: 'Selecciona al menos un scope.',
  INVALID_EXPIRATION: 'La fecha de expiración debe ser futura.',
  UNKNOWN_EVENT_DAY: 'Uno de los días del evento no existe.',
  NOMBRES_REQUIRED: 'El nombre es obligatorio.',
  BATCH_TOO_LARGE: 'El lote excede 1000 filas.',
  INVALID_VALUE: 'Valor inválido.',
  UNKNOWN_PERMISSION: 'Permiso desconocido.',
  TOKEN_OR_ID_REQUIRED: 'Falta el código QR.',
}

type PgLikeError = { code?: string; message?: string; details?: string | null }

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err
  const e = (err ?? {}) as PgLikeError & { name?: string }
  const msg = e.message ?? String(err)
  if (/Failed to fetch|NetworkError|Load failed|fetch failed|network/i.test(msg) || e.name === 'TypeError') {
    return new AppError('Sin conexión con el servidor.', 'NETWORK', true)
  }
  if (e.code === '23505') {
    const field = e.details?.match(/Key \((?:lower\()?([a-z_]+)/)?.[1]
    const label = field === 'email' ? 'email' : field === 'effi_id' ? 'ID Effi' : field === 'effi_username' ? 'usuario Effi' : field ?? 'identificador'
    return new AppError(`Ya existe un registro con ese ${label}.`, 'CONFLICT')
  }
  if (e.code === '23514') return new AppError('Algún dato no cumple el formato requerido.', 'CHECK')
  if (e.code === 'PGRST301' || e.code === '401') return new AppError(FRIENDLY.UNAUTHENTICATED, 'UNAUTHENTICATED')
  if (e.code === '42501' && /permission denied/i.test(msg)) return new AppError(FRIENDLY.FORBIDDEN, 'FORBIDDEN')
  return new AppError(FRIENDLY[msg] ?? msg, msg)
}

/** Llama una función RPC y lanza AppError con mensaje amigable. */
export async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  let result
  try {
    result = await supabase.rpc(fn, args)
  } catch (e) {
    throw toAppError(e)
  }
  if (result.error) throw toAppError(result.error)
  return result.data as T
}

/** Ejecuta una consulta de supabase-js y devuelve data/count o lanza AppError. */
export async function query<T>(
  builder: PromiseLike<{ data: T | null; error: PgLikeError | null; count?: number | null }>,
): Promise<{ data: T; count: number }> {
  let r
  try {
    r = await builder
  } catch (e) {
    throw toAppError(e)
  }
  if (r.error) throw toAppError(r.error)
  return { data: (r.data ?? ([] as unknown)) as T, count: r.count ?? 0 }
}

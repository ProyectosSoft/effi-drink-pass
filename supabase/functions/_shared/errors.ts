/** Errores HTTP de la API y traducción de errores de PostgreSQL/PostgREST. */

/**
 * Error que se serializa tal cual como respuesta HTTP de la API.
 * Todo lo que contiene (code, message, details) es visible para el cliente: no incluir datos internos.
 */
export class ApiError extends Error {
  constructor(
    /** Estado HTTP de la respuesta. */
    public status: number,
    /** Código estable legible por máquina (p. ej. NOT_FOUND, INSUFFICIENT_SCOPE). */
    public code: string,
    message: string,
    public details?: unknown,
    /** Cabeceras extra de la respuesta (p. ej. Retry-After, WWW-Authenticate). */
    public headers: Record<string, string> = {},
  ) {
    super(message)
  }
}

/** Error devuelto por la capa de datos (forma de PostgrestError). */
export type DbErrorLike = { code?: string; message?: string; details?: string | null; hint?: string | null }

/**
 * Error crudo de la base de datos. Nunca se devuelve directamente al cliente: pasa por mapDbError.
 * `message` lleva el código de negocio lanzado por la RPC (`raise exception '<CODIGO>'`)
 * y `code` el SQLSTATE de PostgreSQL.
 */
export class DbError extends Error {
  code: string
  details: string | null
  constructor(e: DbErrorLike) {
    super(e.message ?? 'DB_ERROR')
    this.code = e.code ?? ''
    this.details = e.details ?? null
  }
}

/** Mensajes genéricos por código de error de la API. */
const MESSAGES: Record<string, string> = {
  FORBIDDEN: 'No tiene permiso para esta operación',
  INSUFFICIENT_SCOPE: 'La credencial no tiene el scope requerido',
  NOT_FOUND: 'Recurso no encontrado',
  CONFLICT: 'El recurso entra en conflicto con uno existente',
  VALIDATION_ERROR: 'Los datos enviados no son válidos',
  INTERNAL_ERROR: 'Error interno. Si persiste, contacte al administrador con el request_id',
}

/** Mensaje para un código; si no hay traducción se devuelve el propio código. */
export function messageFor(code: string): string {
  return MESSAGES[code] ?? code
}

/**
 * Convierte un error de base de datos en un ApiError sin filtrar detalles internos.
 * Seguridad: lista blanca por SQLSTATE; cualquier código no previsto (o un error que no es DbError,
 * p. ej. de red o programación) se convierte en un 500 genérico, sin mensaje ni stack de Postgres.
 */
export function mapDbError(err: unknown): ApiError {
  if (err instanceof ApiError) return err
  if (!(err instanceof DbError)) {
    return new ApiError(500, 'INTERNAL_ERROR', messageFor('INTERNAL_ERROR'))
  }
  const code = err.message
  switch (err.code) {
    // insufficient_privilege: las RPC lo usan para permisos/scopes; details trae el scope requerido.
    case '42501':
      return new ApiError(403, code === 'INSUFFICIENT_SCOPE' ? 'INSUFFICIENT_SCOPE' : 'FORBIDDEN',
        messageFor(code === 'INSUFFICIENT_SCOPE' ? 'INSUFFICIENT_SCOPE' : 'FORBIDDEN'),
        err.details ? { required: err.details } : undefined)
    // no_data_found
    case 'P0002':
      return new ApiError(404, 'NOT_FOUND', messageFor('NOT_FOUND'))
    // unique_violation: solo se expone el nombre de la columna, no el valor duplicado que trae details.
    case '23505': {
      const field = err.details?.match(/Key \((?:lower\()?([a-z_]+)\)?\)=/)?.[1]
      return new ApiError(409, 'CONFLICT', field ? `Ya existe un registro con ese ${field}` : messageFor('CONFLICT'),
        field ? { field } : undefined)
    }
    // invalid_parameter_value: código de negocio de validación lanzado a propósito por la RPC (seguro de exponer).
    case '22023':
      return new ApiError(422, code, code, err.details ? { detail: err.details } : undefined)
    // check_violation (message = nombre del CHECK) y foreign_key_violation.
    case '23514':
      return new ApiError(422, 'CONSTRAINT_VIOLATION', 'Un valor no cumple las reglas de validación', { constraint: code })
    case '23503':
      return new ApiError(422, 'INVALID_REFERENCE', 'Referencia a un recurso inexistente')
    // Conversión de tipos fallida: texto inválido (uuid, número…), fecha/hora inválida, fuera de rango.
    case '22P02':
    case '22007':
    case '22008':
    case '22003':
      return new ApiError(400, 'INVALID_PARAMETER', 'Parámetro con formato inválido')
    default:
      return new ApiError(500, 'INTERNAL_ERROR', messageFor('INTERNAL_ERROR'))
  }
}

/**
 * Código de resultado de validación/consumo → estado HTTP para POST …/redeem.
 * 409 permite al cliente distinguir "ya consumido" de otros rechazos de negocio (422).
 */
export function redeemStatus(code: string): number {
  switch (code) {
    case 'APPROVED':
      return 200
    case 'ALREADY_CONSUMED':
      return 409
    case 'INVALID_QR':
    case 'BENEFIT_NOT_FOUND':
      return 404
    case 'RATE_LIMITED':
      return 429
    default:
      return 422
  }
}

/** Errores HTTP de la API y traducción de errores de PostgreSQL/PostgREST. */

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
    public headers: Record<string, string> = {},
  ) {
    super(message)
  }
}

/** Error devuelto por la capa de datos (forma de PostgrestError). */
export type DbErrorLike = { code?: string; message?: string; details?: string | null; hint?: string | null }

export class DbError extends Error {
  code: string
  details: string | null
  constructor(e: DbErrorLike) {
    super(e.message ?? 'DB_ERROR')
    this.code = e.code ?? ''
    this.details = e.details ?? null
  }
}

const MESSAGES: Record<string, string> = {
  FORBIDDEN: 'No tiene permiso para esta operación',
  INSUFFICIENT_SCOPE: 'La credencial no tiene el scope requerido',
  NOT_FOUND: 'Recurso no encontrado',
  CONFLICT: 'El recurso entra en conflicto con uno existente',
  VALIDATION_ERROR: 'Los datos enviados no son válidos',
  INTERNAL_ERROR: 'Error interno. Si persiste, contacte al administrador con el request_id',
}

export function messageFor(code: string): string {
  return MESSAGES[code] ?? code
}

/** Convierte un error de base de datos en un ApiError sin filtrar detalles internos. */
export function mapDbError(err: unknown): ApiError {
  if (err instanceof ApiError) return err
  if (!(err instanceof DbError)) {
    return new ApiError(500, 'INTERNAL_ERROR', messageFor('INTERNAL_ERROR'))
  }
  const code = err.message
  switch (err.code) {
    case '42501':
      return new ApiError(403, code === 'INSUFFICIENT_SCOPE' ? 'INSUFFICIENT_SCOPE' : 'FORBIDDEN',
        messageFor(code === 'INSUFFICIENT_SCOPE' ? 'INSUFFICIENT_SCOPE' : 'FORBIDDEN'),
        err.details ? { required: err.details } : undefined)
    case 'P0002':
      return new ApiError(404, 'NOT_FOUND', messageFor('NOT_FOUND'))
    case '23505': {
      const field = err.details?.match(/Key \((?:lower\()?([a-z_]+)\)?\)=/)?.[1]
      return new ApiError(409, 'CONFLICT', field ? `Ya existe un registro con ese ${field}` : messageFor('CONFLICT'),
        field ? { field } : undefined)
    }
    case '22023':
      return new ApiError(422, code, code, err.details ? { detail: err.details } : undefined)
    case '23514':
      return new ApiError(422, 'CONSTRAINT_VIOLATION', 'Un valor no cumple las reglas de validación', { constraint: code })
    case '23503':
      return new ApiError(422, 'INVALID_REFERENCE', 'Referencia a un recurso inexistente')
    case '22P02':
    case '22007':
    case '22008':
    case '22003':
      return new ApiError(400, 'INVALID_PARAMETER', 'Parámetro con formato inválido')
    default:
      return new ApiError(500, 'INTERNAL_ERROR', messageFor('INTERNAL_ERROR'))
  }
}

/** Código de resultado de validación/consumo → estado HTTP para POST …/redeem. */
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

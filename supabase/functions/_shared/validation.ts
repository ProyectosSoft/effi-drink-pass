/** Esquemas de validación de entrada de la API (zod v4). */
import { z } from 'zod'
import { ApiError } from './errors.ts'

/** Texto recortado con longitud máxima. */
const trimmed = (max: number) => z.string().trim().max(max)
/** Texto opcional que también acepta null (para borrar el valor). */
const nullableTrimmed = (max: number) => trimmed(max).nullable().optional()

/**
 * Escapa los comodines de LIKE (`\`, `%`, `_`) para que una búsqueda por texto sea literal.
 * PostgreSQL usa `\` como carácter de escape por defecto en LIKE.
 */
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)
/** Texto de búsqueda parcial (en BD se usa dentro de LIKE '%…%'). */
const likeText = (min: number, max: number) => z.string().trim().min(min).max(max).transform(escapeLike)

export const uuidSchema = z.uuid()

const attendeeFields = {
  nombres: trimmed(120).min(1),
  apellidos: nullableTrimmed(120),
  email: z.email().max(254).nullable().optional(),
  telefono: nullableTrimmed(40),
  effi_id: nullableTrimmed(64),
  effi_username: nullableTrimmed(120),
  tipo_acceso: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/).nullable().optional(),
  empresa: nullableTrimmed(200),
  activo: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}

const eventDayIds = z.array(z.uuid()).max(31).optional()

export const createAttendeeSchema = z.strictObject({ ...attendeeFields, event_day_ids: eventDayIds })
export const replaceAttendeeSchema = createAttendeeSchema
export const patchAttendeeSchema = z
  .strictObject({ ...attendeeFields, nombres: attendeeFields.nombres.optional(), event_day_ids: eventDayIds })
  .refine((v) => Object.keys(v).length > 0, { message: 'El cuerpo no puede estar vacío' })

export const setEventDaysSchema = z.strictObject({ event_day_ids: z.array(z.uuid()).max(31) })

/**
 * Metadatos libres que una integración adjunta a un consumo (p. ej. punto de venta).
 * Acotados en número de claves y tamaño porque se guardan en tablas inmutables (consumos y auditoría).
 */
const actionMetadata = z
  .record(z.string().min(1).max(64), z.union([z.string().max(200), z.number(), z.boolean(), z.null()]))
  .refine((m) => Object.keys(m).length <= 20, { message: 'Máximo 20 claves en metadata' })

export const benefitActionSchema = z.strictObject({
  token: z.string().trim().min(1).max(500).optional(),
  metadata: actionMetadata.optional(),
})

export const tokenActionSchema = benefitActionSchema.extend({ token: z.string().trim().min(1).max(500) })

export const generateBenefitsSchema = z.strictObject({ attendee_ids: z.array(z.uuid()).max(1000).optional() })

export const createIntegrationSchema = z.strictObject({
  name: trimmed(100).min(2),
  description: nullableTrimmed(500),
  contact_email: z.email().nullable().optional(),
  allowed_scopes: z.array(z.string().regex(/^[a-z-]+:[a-z-]+$/)).max(30),
})

export const createCredentialSchema = z.strictObject({
  scopes: z.array(z.string().regex(/^[a-z-]+:[a-z-]+$/)).min(1).max(30),
  expires_at: z.iso.datetime({ offset: true }).nullable().optional(),
})

export const revokeSchema = z.strictObject({ reason: nullableTrimmed(300) })

export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_\-:.]{8,255}$/)

const pageParams = {
  page: z.coerce.number().int().min(1).max(100000).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
}
const shortText = z.string().trim().min(1).max(200)

export const attendeeQuerySchema = z.strictObject({
  ...pageParams,
  effi_id: shortText.optional(),
  effi_username: shortText.optional(),
  email: shortText.optional(),
  q: likeText(2, 100).optional(),
  tipo_acceso: shortText.optional(),
  empresa: likeText(1, 200).optional(),
  activo: z.enum(['true', 'false']).optional(),
  event_day_id: z.uuid().optional(),
  updated_since: z.iso.datetime({ offset: true }).optional(),
})

export const benefitQuerySchema = z.strictObject({
  ...pageParams,
  attendee_id: z.uuid().optional(),
  event_day_id: z.uuid().optional(),
  date: z.iso.date().optional(),
  status: z.enum(['PENDING', 'CONSUMED', 'EXPIRED', 'CANCELLED', 'pending', 'consumed', 'expired', 'cancelled']).optional(),
  effi_id: shortText.optional(),
})

export const consumptionQuerySchema = z.strictObject({
  ...pageParams,
  attendee_id: z.uuid().optional(),
  event_day_id: z.uuid().optional(),
  operator_id: z.uuid().optional(),
  integration_id: z.uuid().optional(),
  effi_id: shortText.optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
})

export const statisticsQuerySchema = z.strictObject({
  event_day_id: z.uuid().optional(),
  date_from: z.iso.date().optional(),
  date_to: z.iso.date().optional(),
  operator_id: z.uuid().optional(),
  status: z.enum(['PENDING', 'CONSUMED', 'EXPIRED', 'CANCELLED']).optional(),
  effi_id: shortText.optional(),
  effi_username: shortText.optional(),
  empresa: likeText(1, 200).optional(),
  tipo_acceso: shortText.optional(),
})

/** Valida y lanza 400 (query/params) o 422 (cuerpo) con el detalle de cada campo. */
export function parse<T>(schema: z.ZodType<T>, input: unknown, where: 'query' | 'body' | 'path'): T {
  const r = schema.safeParse(input)
  if (r.success) return r.data
  const fields = r.error.issues.map((i) => ({ field: i.path.join('.') || '(root)', message: i.message }))
  throw new ApiError(where === 'body' ? 422 : 400, 'VALIDATION_ERROR', 'Los datos enviados no son válidos', { fields })
}

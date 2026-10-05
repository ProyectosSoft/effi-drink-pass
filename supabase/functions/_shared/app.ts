/**
 * EFFI DRINK PASS — API REST pública v1.
 * Independiente del runtime: recibe un Request y devuelve un Response. La capa de datos
 * se inyecta (DbPort) para poder probarla sin Supabase. Ver docs/openapi.yaml.
 */
import { ApiError, DbError, mapDbError, messageFor, redeemStatus } from './errors.ts'
import { TOKEN_AUDIENCE, TOKEN_ISSUER, peekJwtPayload, signJwt, verifyJwt } from './jwt.ts'
import { extractToken } from './qr.ts'
import * as v from './validation.ts'

const API_VERSION = '1.0.0'
const MAX_BODY_BYTES = 64 * 1024

// ───────────────────────────── Puertos ──────────────────────────────────────
export interface DbPort {
  /** RPC con service_role. Lanza DbError. */
  rpc<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T>
  /** RPC con el JWT del usuario (RLS y permisos propios). Lanza DbError. */
  rpcAsUser<T = unknown>(jwt: string, fn: string, args?: Record<string, unknown>): Promise<T>
  /** Valida un JWT de Supabase Auth y devuelve el id del usuario, o null. */
  getAuthUserId(jwt: string): Promise<string | null>
}

export interface AppConfig {
  jwtSecret: string
  allowedOrigins: string[]
  tokenTtlSeconds?: number
  now?: () => Date
  log?: (entry: Record<string, unknown>) => void
}

export type Principal = {
  type: 'integration' | 'user' | 'anonymous'
  channel: 'api'
  label?: string
  integration_id?: string
  credential_id?: string
  client_id?: string
  profile_id?: string
  auth_user_id?: string
  scopes: string[]
  ip?: string | null
  user_agent?: string | null
  request_id?: string
}

type RateSpec = { name: string; limit: number; window: number }
type RateInfo = { allowed: boolean; limit: number; remaining: number; reset_at: string; retry_after: number }

type Ctx = {
  req: Request
  url: URL
  params: Record<string, string>
  query: Record<string, string>
  principal: Principal
  jwt?: string
  requestId: string
  ip: string | null
  body: () => Promise<unknown>
  db: DbPort
  config: AppConfig
}

type Handler = (ctx: Ctx) => Promise<Response>

type Route = {
  method: string
  pattern: RegExp
  keys: string[]
  scope?: string
  auth: 'none' | 'principal' | 'staff'
  rate?: RateSpec
  handler: Handler
}

const RATE = {
  read: { name: 'read', limit: 240, window: 60 },
  search: { name: 'search', limit: 120, window: 60 },
  write: { name: 'write', limit: 60, window: 60 },
  scan: { name: 'scan', limit: 180, window: 60 },
  stats: { name: 'stats', limit: 30, window: 60 },
  admin: { name: 'admin', limit: 30, window: 60 },
  token: { name: 'token', limit: 20, window: 60 },
} satisfies Record<string, RateSpec>

// ───────────────────────────── Utilidades HTTP ──────────────────────────────
/** Respuesta JSON (204 sin cuerpo). */
function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  })
}

/** Formato de error uniforme de la API: { error: { code, message, details?, request_id } }. */
function errorBody(err: ApiError, requestId: string) {
  return { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}), request_id: requestId } }
}

/** Convierte '/v1/x/:id' en una RegExp y la lista de parámetros de ruta. */
function compile(path: string): { pattern: RegExp; keys: string[] } {
  const keys: string[] = []
  const src = path.replace(/:([a-zA-Z_]+)/g, (_, k) => {
    keys.push(k)
    return '([^/]+)'
  })
  return { pattern: new RegExp(`^${src}/?$`), keys }
}

/** Normaliza /functions/v1/api/v1/x, /api/v1/x o /v1/x → /v1/x */
export function normalizePath(pathname: string): string {
  let p = pathname.replace(/^\/functions\/v1(?=\/)/, '')
  p = p.replace(/^\/api(?=\/|$)/, '')
  return p === '' ? '/' : p
}

/**
 * IP del cliente para rate limiting, bloqueo por fallos y auditoría.
 *
 * Orden de confianza: Supabase está detrás de Cloudflare, que SOBRESCRIBE `cf-connecting-ip`
 * con la IP real (el cliente no puede falsificarla). `x-real-ip` la fija el gateway.
 * El primer valor de `x-forwarded-for` lo controla el cliente, por eso es solo el último recurso.
 */
export function clientIp(req: Request): string | null {
  const ip = req.headers.get('cf-connecting-ip')?.trim()
    || req.headers.get('x-real-ip')?.trim()
    || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  return ip ? ip.slice(0, 64) : null
}

/** Reutiliza el X-Request-Id del cliente solo si tiene un formato seguro; si no, genera uno. */
function safeRequestId(req: Request): string {
  const incoming = req.headers.get('x-request-id')
  if (incoming && /^[A-Za-z0-9_\-.:]{8,100}$/.test(incoming)) return incoming
  return crypto.randomUUID()
}

/** Cabeceras estándar X-RateLimit-* (y Retry-After si se excedió el límite). */
function rateHeaders(rate?: RateInfo | null): Record<string, string> {
  if (!rate) return {}
  const h: Record<string, string> = {
    'X-RateLimit-Limit': String(rate.limit),
    'X-RateLimit-Remaining': String(rate.remaining),
    'X-RateLimit-Reset': String(Math.ceil(new Date(rate.reset_at).getTime() / 1000)),
  }
  if (!rate.allowed) h['Retry-After'] = String(rate.retry_after)
  return h
}

/**
 * CORS por lista blanca (API_ALLOWED_ORIGINS). Nunca envía Allow-Credentials:
 * la autenticación va en cabeceras explícitas, no en cookies.
 */
function corsHeaders(req: Request, allowed: string[]): Record<string, string> {
  const origin = req.headers.get('origin')
  if (!origin || !(allowed.includes(origin) || allowed.includes('*'))) return {}
  return {
    'Access-Control-Allow-Origin': allowed.includes('*') ? '*' : origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, X-API-Key, Content-Type, Idempotency-Key, X-Request-Id, apikey, x-client-info',
    'Access-Control-Expose-Headers': 'X-Request-Id, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After, Idempotent-Replayed',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  }
}

/**
 * Lee el cuerpo como texto cortando en MAX_BODY_BYTES mientras llega el stream.
 * Así un envío `Transfer-Encoding: chunked` (sin Content-Length) no puede obligar a
 * cargar en memoria un cuerpo arbitrariamente grande antes de rechazarlo.
 */
async function readLimitedText(req: Request): Promise<string> {
  const tooLarge = () => new ApiError(413, 'PAYLOAD_TOO_LARGE', 'El cuerpo excede 64 KB')
  const len = Number(req.headers.get('content-length') ?? '0')
  if (len > MAX_BODY_BYTES) throw tooLarge()
  if (!req.body) return ''
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {})
      throw tooLarge()
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    bytes.set(c, offset)
    offset += c.byteLength
  }
  return new TextDecoder().decode(bytes)
}

/** Lee y parsea el cuerpo: JSON (por defecto) o form-urlencoded (solo /oauth/token). */
async function readBody(req: Request, form = false): Promise<unknown> {
  const text = await readLimitedText(req)
  const ctype = (req.headers.get('content-type') ?? '').toLowerCase()
  if (form && ctype.startsWith('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(text))
  }
  if (text.trim() === '') return {}
  if (!ctype.startsWith('application/json')) {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use Content-Type: application/json')
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'El cuerpo no es JSON válido')
  }
}

// Limitador en memoria por isolate para endpoints sin autenticación (primera línea; el real está en BD).
const memBuckets = new Map<string, { start: number; hits: number }>()
function memoryLimit(key: string, limit: number, windowMs: number, now: number): boolean {
  const b = memBuckets.get(key)
  if (!b || now - b.start >= windowMs) {
    memBuckets.set(key, { start: now, hits: 1 })
    if (memBuckets.size > 5000) memBuckets.clear()
    return true
  }
  b.hits++
  return b.hits <= limit
}

// ───────────────────────────── Autenticación ────────────────────────────────
type AuthInput =
  | { type: 'client_secret'; client_id: string; client_secret: string }
  | { type: 'credential'; credential_id: string; tokenScopes: string[] }
  | { type: 'user'; auth_user_id: string; jwt: string }
  | { type: 'none' }

/**
 * Identifica al llamante sin consultar permisos todavía:
 *  - X-API-Key: client_id.client_secret (se valida en BD contra el hash).
 *  - Bearer con iss propio: access token OAuth2 firmado por esta API (HS256).
 *  - Cualquier otro Bearer: JWT de Supabase Auth (staff), validado por el servidor de Auth.
 */
async function resolveAuth(req: Request, db: DbPort, config: AppConfig): Promise<AuthInput> {
  const apiKey = req.headers.get('x-api-key')
  if (apiKey) {
    const dot = apiKey.indexOf('.')
    if (dot < 1) throw new ApiError(401, 'INVALID_API_KEY', 'Formato de X-API-Key inválido (client_id.client_secret)')
    return { type: 'client_secret', client_id: apiKey.slice(0, dot).trim(), client_secret: apiKey.slice(dot + 1).trim() }
  }
  const authz = req.headers.get('authorization')
  if (!authz) return { type: 'none' }
  const [scheme, token] = authz.split(/\s+/, 2)
  if (!/^bearer$/i.test(scheme) || !token) throw new ApiError(401, 'INVALID_AUTHORIZATION', 'Use Authorization: Bearer <token>')

  const payload = peekJwtPayload(token)
  if (!payload) throw new ApiError(401, 'INVALID_TOKEN', 'Token inválido')
  if (payload.iss === TOKEN_ISSUER) {
    const r = await verifyJwt(token, config.jwtSecret, Math.floor((config.now?.() ?? new Date()).getTime() / 1000))
    if (!r.ok) {
      throw new ApiError(401, r.reason === 'expired' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN',
        r.reason === 'expired' ? 'El access token expiró; solicite uno nuevo' : 'Token inválido')
    }
    return { type: 'credential', credential_id: r.claims.sub, tokenScopes: r.claims.scope.split(' ').filter(Boolean) }
  }
  // JWT de Supabase Auth (staff).
  const uid = await db.getAuthUserId(token)
  if (!uid) throw new ApiError(401, 'INVALID_TOKEN', 'Token inválido o expirado')
  return { type: 'user', auth_user_id: uid, jwt: token }
}

type BeginResult = { ok: boolean; error?: string; principal?: Principal; rate?: RateInfo | null }

/**
 * Una sola RPC que valida la credencial/usuario (revocación, expiración, integración activa),
 * aplica el rate limit en BD y devuelve el principal con sus scopes vigentes.
 */
async function beginRequest(db: DbPort, auth: AuthInput, rate: RateSpec | undefined, meta: {
  ip: string | null; ua: string | null; requestId: string; issuingToken?: boolean
}): Promise<BeginResult> {
  const authPayload = auth.type === 'credential' ? { type: 'credential', credential_id: auth.credential_id }
    : auth.type === 'user' ? { type: 'user', auth_user_id: auth.auth_user_id }
    : auth
  return db.rpc<BeginResult>('api_begin_request', {
    p: {
      auth: authPayload,
      rate,
      ip: meta.ip,
      user_agent: meta.ua?.slice(0, 400) ?? null,
      request_id: meta.requestId,
      issuing_token: meta.issuingToken ?? false,
    },
  })
}

/** Traduce el motivo de rechazo de api_begin_request a un error HTTP sin filtrar detalles internos. */
function authFailure(error: string | undefined): ApiError {
  switch (error) {
    case 'USER_NOT_AUTHORIZED':
      return new ApiError(403, 'FORBIDDEN', 'El usuario no pertenece al staff o está inactivo')
    case 'CREDENTIAL_REVOKED':
      return new ApiError(401, 'CREDENTIAL_REVOKED', 'La credencial fue revocada')
    case 'CREDENTIAL_EXPIRED':
      return new ApiError(401, 'CREDENTIAL_EXPIRED', 'La credencial expiró')
    case 'INTEGRATION_DISABLED':
      return new ApiError(403, 'INTEGRATION_DISABLED', 'La integración está desactivada')
    default:
      return new ApiError(401, 'INVALID_CREDENTIALS', 'Credenciales inválidas')
  }
}

// ───────────────────────────── Rutas ────────────────────────────────────────
function actor(ctx: Ctx): Principal {
  return ctx.principal
}

/** Separa la paginación del resto de filtros de búsqueda. */
function paged(q: Record<string, unknown>) {
  const { page, page_size, ...filters } = q
  return { page: page as number, page_size: page_size as number, filters }
}

/** Parámetro de ruta validado como UUID (400 si no lo es). */
function uuidParam(ctx: Ctx, key = 'id'): string {
  return v.parse(v.uuidSchema, ctx.params[key], 'path')
}

/**
 * Validar o consumir un beneficio, identificado por id (ruta) o por el token del QR (cuerpo).
 * El consumo es atómico en BD y admite Idempotency-Key para reintentos seguros.
 */
async function benefitAction(ctx: Ctx, mode: 'validate' | 'redeem', benefitId: string | null): Promise<Response> {
  const body = v.parse(benefitId ? v.benefitActionSchema : v.tokenActionSchema, await ctx.body(), 'body')
  let token: string | null = null
  if (body.token !== undefined) {
    token = extractToken(body.token) ?? body.token.slice(0, 100)
  }
  let idemKey: string | null = null
  if (mode === 'redeem') {
    const raw = ctx.req.headers.get('idempotency-key')
    if (raw !== null) idemKey = v.parse(v.idempotencyKeySchema, raw, 'query')
  }
  const result = await ctx.db.rpc<{ ok: boolean; code: string; message: string; idempotent_replay?: boolean }>(
    'api_benefit_process',
    {
      p_actor: actor(ctx),
      p_mode: mode,
      p_token: token,
      p_benefit_id: benefitId,
      p_idempotency_key: idemKey,
      p_metadata: body.metadata ?? {},
    },
  )
  const headers: Record<string, string> = result.idempotent_replay ? { 'Idempotent-Replayed': 'true' } : {}
  if (mode === 'validate') {
    if (benefitId && result.code === 'BENEFIT_NOT_FOUND') {
      throw new ApiError(404, 'NOT_FOUND', messageFor('NOT_FOUND'))
    }
    return json(200, { data: result }, headers)
  }
  const status = redeemStatus(result.code)
  if (status === 200) return json(200, { data: result }, headers)
  return json(status, {
    error: { code: result.code, message: result.message, request_id: ctx.requestId },
    data: result,
  }, headers)
}

/** Tras escribir: representación completa solo si la credencial también puede leer. */
async function readBack(ctx: Ctx, id: string): Promise<unknown> {
  if (!ctx.principal.scopes.includes('attendees:read')) return { data: { id } }
  return ctx.db.rpc('api_get_attendee', { p_actor: actor(ctx), p_id: id })
}

/** Exige un usuario del staff (JWT de Supabase Auth) y devuelve su JWT para ejecutar RPC con sus permisos. */
function staffOnly(ctx: Ctx): string {
  if (ctx.principal.type !== 'user' || !ctx.jwt) {
    throw new ApiError(403, 'STAFF_ONLY', 'Este endpoint requiere un usuario del staff (JWT de Supabase Auth)')
  }
  return ctx.jwt
}

/** Tabla de rutas: método, patrón, autenticación requerida, scope y límite de tasa de cada endpoint. */
function buildRoutes(): Route[] {
  const routes: Route[] = []
  const add = (method: string, path: string, opts: Omit<Route, 'method' | 'pattern' | 'keys' | 'handler'>, handler: Handler) =>
    routes.push({ method, ...compile(path), ...opts, handler })

  add('GET', '/v1/health', { auth: 'none' }, async (ctx) => {
    let database = 'ok'
    try {
      await ctx.db.rpc('server_time')
    } catch {
      database = 'unavailable'
    }
    const now = (ctx.config.now?.() ?? new Date()).toISOString()
    return json(database === 'ok' ? 200 : 503, {
      status: database === 'ok' ? 'ok' : 'degraded',
      service: 'effi-drink-pass-api',
      version: API_VERSION,
      time: now,
      checks: { database },
    })
  })

  add('GET', '/v1/me', { auth: 'principal', rate: RATE.read }, async (ctx) => {
    const p = ctx.principal
    return json(200, {
      data: {
        type: p.type, label: p.label, scopes: [...p.scopes].sort(),
        integration_id: p.integration_id ?? null, client_id: p.client_id ?? null, profile_id: p.profile_id ?? null,
      },
    })
  })

  // Event days
  add('GET', '/v1/event-days', { auth: 'principal', scope: 'event-days:read', rate: RATE.read }, async (ctx) =>
    json(200, await ctx.db.rpc('api_list_event_days', { p_actor: actor(ctx) })))
  add('GET', '/v1/event-days/:id', { auth: 'principal', scope: 'event-days:read', rate: RATE.read }, async (ctx) =>
    json(200, await ctx.db.rpc('api_get_event_day', { p_actor: actor(ctx), p_id: uuidParam(ctx) })))

  // Attendees
  add('GET', '/v1/attendees', { auth: 'principal', scope: 'attendees:read', rate: RATE.search }, async (ctx) => {
    const { page, page_size, filters } = paged(v.parse(v.attendeeQuerySchema, ctx.query, 'query'))
    return json(200, await ctx.db.rpc('api_list_attendees', { p_actor: actor(ctx), p_filters: filters, p_page: page, p_page_size: page_size }))
  })
  add('GET', '/v1/attendees/:id', { auth: 'principal', scope: 'attendees:read', rate: RATE.read }, async (ctx) =>
    json(200, await ctx.db.rpc('api_get_attendee', { p_actor: actor(ctx), p_id: uuidParam(ctx) })))
  add('POST', '/v1/attendees', { auth: 'principal', scope: 'attendees:write', rate: RATE.write }, async (ctx) => {
    const { event_day_ids, ...data } = v.parse(v.createAttendeeSchema, await ctx.body(), 'body')
    const id = await ctx.db.rpc<string>('api_upsert_attendee', {
      p_actor: actor(ctx), p_id: null, p_data: data, p_partial: false, p_event_day_ids: event_day_ids ?? null })
    const created = await readBack(ctx, id)
    return json(201, created, { Location: `/api/v1/attendees/${id}` })
  })
  const updateAttendee = (partial: boolean): Handler => async (ctx) => {
    const id = uuidParam(ctx)
    const { event_day_ids, ...data } = v.parse(partial ? v.patchAttendeeSchema : v.replaceAttendeeSchema, await ctx.body(), 'body')
    await ctx.db.rpc('api_upsert_attendee', {
      p_actor: actor(ctx), p_id: id, p_data: data, p_partial: partial, p_event_day_ids: event_day_ids ?? null })
    return json(200, await readBack(ctx, id))
  }
  add('PATCH', '/v1/attendees/:id', { auth: 'principal', scope: 'attendees:write', rate: RATE.write }, updateAttendee(true))
  add('PUT', '/v1/attendees/:id', { auth: 'principal', scope: 'attendees:write', rate: RATE.write }, updateAttendee(false))
  add('PUT', '/v1/attendees/:id/event-days', { auth: 'principal', scope: 'attendees:write', rate: RATE.write }, async (ctx) => {
    const id = uuidParam(ctx)
    const body = v.parse(v.setEventDaysSchema, await ctx.body(), 'body')
    await ctx.db.rpc('api_set_attendee_days', { p_actor: actor(ctx), p_attendee_id: id, p_event_day_ids: body.event_day_ids })
    return json(200, await readBack(ctx, id))
  })
  add('GET', '/v1/attendees/:id/benefits', { auth: 'principal', scope: 'benefits:read', rate: RATE.read }, async (ctx) =>
    json(200, await ctx.db.rpc('api_attendee_benefits', { p_actor: actor(ctx), p_attendee_id: uuidParam(ctx) })))

  // Benefits
  add('GET', '/v1/benefits', { auth: 'principal', scope: 'benefits:read', rate: RATE.search }, async (ctx) => {
    const { page, page_size, filters } = paged(v.parse(v.benefitQuerySchema, ctx.query, 'query'))
    return json(200, await ctx.db.rpc('api_list_benefits', { p_actor: actor(ctx), p_filters: filters, p_page: page, p_page_size: page_size }))
  })
  add('POST', '/v1/benefits/generate', { auth: 'principal', scope: 'benefits:write', rate: RATE.write }, async (ctx) => {
    const body = v.parse(v.generateBenefitsSchema, await ctx.body(), 'body')
    const created = await ctx.db.rpc<number>('api_generate_benefits', { p_actor: actor(ctx), p_attendee_ids: body.attendee_ids ?? null })
    return json(200, { data: { created } })
  })
  add('POST', '/v1/benefits/validate', { auth: 'principal', scope: 'benefits:validate', rate: RATE.scan }, (ctx) => benefitAction(ctx, 'validate', null))
  add('POST', '/v1/benefits/redeem', { auth: 'principal', scope: 'benefits:redeem', rate: RATE.scan }, (ctx) => benefitAction(ctx, 'redeem', null))
  add('GET', '/v1/benefits/:id', { auth: 'principal', scope: 'benefits:read', rate: RATE.read }, async (ctx) =>
    json(200, await ctx.db.rpc('api_get_benefit', { p_actor: actor(ctx), p_id: uuidParam(ctx) })))
  add('POST', '/v1/benefits/:id/validate', { auth: 'principal', scope: 'benefits:validate', rate: RATE.scan }, (ctx) =>
    benefitAction(ctx, 'validate', uuidParam(ctx)))
  add('POST', '/v1/benefits/:id/redeem', { auth: 'principal', scope: 'benefits:redeem', rate: RATE.scan }, (ctx) =>
    benefitAction(ctx, 'redeem', uuidParam(ctx)))

  // Consumptions
  add('GET', '/v1/consumptions', { auth: 'principal', scope: 'consumptions:read', rate: RATE.search }, async (ctx) => {
    const { page, page_size, filters } = paged(v.parse(v.consumptionQuerySchema, ctx.query, 'query'))
    return json(200, await ctx.db.rpc('api_list_consumptions', { p_actor: actor(ctx), p_filters: filters, p_page: page, p_page_size: page_size }))
  })
  add('GET', '/v1/consumptions/:id', { auth: 'principal', scope: 'consumptions:read', rate: RATE.read }, async (ctx) =>
    json(200, await ctx.db.rpc('api_get_consumption', { p_actor: actor(ctx), p_id: uuidParam(ctx) })))

  // Statistics
  add('GET', '/v1/statistics', { auth: 'principal', scope: 'statistics:read', rate: RATE.stats }, async (ctx) => {
    const filters = v.parse(v.statisticsQuerySchema, ctx.query, 'query')
    return json(200, { data: await ctx.db.rpc('api_statistics', { p_actor: actor(ctx), p_filters: filters }) })
  })

  // Administración de integraciones (solo staff con integrations:manage; se ejecuta con el JWT del usuario)
  add('POST', '/v1/admin/integrations', { auth: 'staff', scope: 'integrations:manage', rate: RATE.admin }, async (ctx) => {
    const jwt = staffOnly(ctx)
    const b = v.parse(v.createIntegrationSchema, await ctx.body(), 'body')
    const id = await ctx.db.rpcAsUser<string>(jwt, 'create_integration', {
      p_name: b.name, p_description: b.description ?? null, p_allowed_scopes: b.allowed_scopes, p_contact_email: b.contact_email ?? null })
    return json(201, { data: { id, name: b.name, allowed_scopes: b.allowed_scopes } }, { Location: `/api/v1/admin/integrations/${id}` })
  })
  add('POST', '/v1/admin/integrations/:id/credentials', { auth: 'staff', scope: 'integrations:manage', rate: RATE.admin }, async (ctx) => {
    const jwt = staffOnly(ctx)
    const b = v.parse(v.createCredentialSchema, await ctx.body(), 'body')
    const cred = await ctx.db.rpcAsUser(jwt, 'create_api_credential', {
      p_integration_id: uuidParam(ctx), p_scopes: b.scopes, p_expires_at: b.expires_at ?? null })
    return json(201, { data: cred }, { 'Cache-Control': 'no-store' })
  })
  add('POST', '/v1/admin/credentials/:id/revoke', { auth: 'staff', scope: 'integrations:manage', rate: RATE.admin }, async (ctx) => {
    const jwt = staffOnly(ctx)
    const b = v.parse(v.revokeSchema, await ctx.body(), 'body')
    await ctx.db.rpcAsUser(jwt, 'revoke_api_credential', { p_credential_id: uuidParam(ctx), p_reason: b.reason ?? null })
    return json(200, { data: { id: ctx.params.id, revoked: true } })
  })
  add('POST', '/v1/admin/credentials/:id/rotate', { auth: 'staff', scope: 'integrations:manage', rate: RATE.admin }, async (ctx) => {
    const jwt = staffOnly(ctx)
    const cred = await ctx.db.rpcAsUser(jwt, 'rotate_api_credential', { p_credential_id: uuidParam(ctx) })
    return json(201, { data: cred }, { 'Cache-Control': 'no-store' })
  })

  return routes
}

// ───────────────────────────── OAuth2 client_credentials ────────────────────
/**
 * POST /v1/oauth/token (grant_type=client_credentials). Admite credenciales en el cuerpo o en
 * Authorization: Basic. Los fallos se cuentan por IP y bloquean temporalmente (api_auth_blocked).
 */
async function tokenEndpoint(req: Request, db: DbPort, config: AppConfig, ip: string | null, requestId: string): Promise<Response> {
  const oauthError = (status: number, error: string, description: string, headers: Record<string, string> = {}) =>
    json(status, { error, error_description: description, request_id: requestId }, { 'Cache-Control': 'no-store', ...headers })

  if (await db.rpc<boolean>('api_auth_blocked', { p_ip: ip })) {
    return oauthError(429, 'slow_down', 'Demasiados intentos fallidos. Intente más tarde.', { 'Retry-After': '300' })
  }
  let body: Record<string, string>
  try {
    body = (await readBody(req, true)) as Record<string, string>
  } catch (e) {
    const err = e as ApiError
    return oauthError(err.status ?? 400, 'invalid_request', err.message)
  }
  if (body.grant_type !== 'client_credentials') {
    return oauthError(400, 'unsupported_grant_type', 'Solo se admite grant_type=client_credentials')
  }
  let clientId = body.client_id
  let clientSecret = body.client_secret
  const basic = req.headers.get('authorization')
  if (basic && /^basic\s+/i.test(basic)) {
    try {
      const decoded = atob(basic.replace(/^basic\s+/i, ''))
      const i = decoded.indexOf(':')
      clientId = decodeURIComponent(decoded.slice(0, i))
      clientSecret = decodeURIComponent(decoded.slice(i + 1))
    } catch {
      return oauthError(401, 'invalid_client', 'Cabecera Basic inválida')
    }
  }
  if (!clientId || !clientSecret || clientId.length > 100 || clientSecret.length > 200) {
    return oauthError(401, 'invalid_client', 'client_id y client_secret son obligatorios')
  }

  const begin = await beginRequest(db, { type: 'client_secret', client_id: clientId, client_secret: clientSecret }, RATE.token,
    { ip, ua: req.headers.get('user-agent'), requestId, issuingToken: true })
  if (!begin.ok || !begin.principal) {
    return oauthError(401, 'invalid_client', 'Credenciales inválidas, revocadas o expiradas')
  }
  if (begin.rate && !begin.rate.allowed) {
    return oauthError(429, 'slow_down', 'Límite de emisión de tokens excedido', rateHeaders(begin.rate))
  }

  const granted = begin.principal.scopes
  let scopes = granted
  if (body.scope) {
    const requested = body.scope.split(/\s+/).filter(Boolean)
    const invalid = requested.filter((s) => !granted.includes(s))
    if (invalid.length) return oauthError(400, 'invalid_scope', `Scopes no autorizados: ${invalid.join(' ')}`)
    scopes = requested
  }
  const ttl = config.tokenTtlSeconds ?? 3600
  const iat = Math.floor((config.now?.() ?? new Date()).getTime() / 1000)
  const token = await signJwt({
    iss: TOKEN_ISSUER, aud: TOKEN_AUDIENCE,
    sub: begin.principal.credential_id!, cid: begin.principal.client_id!, int: begin.principal.integration_id!,
    scope: scopes.join(' '), iat, exp: iat + ttl, jti: crypto.randomUUID(),
  }, config.jwtSecret)
  return json(200, { access_token: token, token_type: 'Bearer', expires_in: ttl, scope: scopes.join(' ') },
    { 'Cache-Control': 'no-store', Pragma: 'no-cache', ...rateHeaders(begin.rate) })
}

// ───────────────────────────── Aplicación ───────────────────────────────────
/**
 * Crea el manejador HTTP de la API. Flujo por solicitud: CORS → enrutado → autenticación →
 * rate limit → scope → handler. Todos los errores salen con el mismo formato y X-Request-Id.
 */
export function createApi(db: DbPort, config: AppConfig) {
  const routes = buildRoutes()
  const log = config.log ?? ((e) => console.log(JSON.stringify(e)))

  return async function handle(req: Request): Promise<Response> {
    const started = Date.now()
    const url = new URL(req.url)
    const path = normalizePath(url.pathname)
    const requestId = safeRequestId(req)
    const ip = clientIp(req)
    const cors = corsHeaders(req, config.allowedOrigins)
    const base: Record<string, string> = {
      'X-Request-Id': requestId,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...cors,
    }
    let principalType = 'anonymous'
    let rate: RateInfo | null | undefined

    const finish = (res: Response): Response => {
      const headers = new Headers(res.headers)
      for (const [k, val] of Object.entries({ ...base, ...rateHeaders(rate) })) {
        if (!headers.has(k)) headers.set(k, val)
      }
      log({ level: 'info', request_id: requestId, method: req.method, path, status: res.status, ms: Date.now() - started, principal: principalType })
      return new Response(res.body, { status: res.status, headers })
    }

    try {
      if (req.method === 'OPTIONS') return finish(new Response(null, { status: 204 }))

      if (path === '/v1/oauth/token') {
        if (req.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use POST')
        if (!memoryLimit(`token:${ip}`, 60, 60_000, started)) {
          return finish(json(429, { error: 'slow_down', error_description: 'Demasiadas solicitudes' }, { 'Retry-After': '60' }))
        }
        return finish(await tokenEndpoint(req, db, config, ip, requestId))
      }

      const candidates = routes.filter((r) => r.pattern.test(path))
      if (candidates.length === 0) throw new ApiError(404, 'ROUTE_NOT_FOUND', `No existe ${req.method} ${path}`)
      const route = candidates.find((r) => r.method === req.method)
      if (!route) {
        throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Método no permitido', undefined,
          { Allow: [...new Set(candidates.map((r) => r.method))].join(', ') })
      }
      const m = path.match(route.pattern)!
      const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]))

      let principal: Principal = { type: 'anonymous', channel: 'api', scopes: [], ip, request_id: requestId }
      let jwt: string | undefined
      if (route.auth === 'none') {
        if (!memoryLimit(`anon:${ip}`, 120, 60_000, started)) {
          throw new ApiError(429, 'RATE_LIMITED', 'Demasiadas solicitudes', undefined, { 'Retry-After': '60' })
        }
      } else {
        const auth = await resolveAuth(req, db, config)
        if (auth.type === 'none') {
          throw new ApiError(401, 'UNAUTHENTICATED', 'Falta autenticación (Authorization: Bearer <token> o X-API-Key)', undefined,
            { 'WWW-Authenticate': 'Bearer realm="effi-drink-pass"' })
        }
        if (auth.type === 'user') jwt = auth.jwt
        const begin = await beginRequest(db, auth, route.rate, { ip, ua: req.headers.get('user-agent'), requestId })
        rate = begin.rate
        if (!begin.ok || !begin.principal) throw authFailure(begin.error)
        principal = begin.principal
        if (auth.type === 'credential') {
          // Scopes efectivos = scopes del token ∩ scopes vigentes de la credencial.
          principal = { ...principal, scopes: principal.scopes.filter((s) => auth.tokenScopes.includes(s)) }
        }
        principalType = principal.type
        if (rate && !rate.allowed) throw new ApiError(429, 'RATE_LIMITED', 'Límite de solicitudes excedido')
        if (route.scope && !principal.scopes.includes(route.scope)) {
          throw new ApiError(403, 'INSUFFICIENT_SCOPE', messageFor('INSUFFICIENT_SCOPE'), { required: route.scope })
        }
      }

      let bodyCache: unknown
      let bodyRead = false
      const ctx: Ctx = {
        req, url, params, principal, jwt, requestId, ip, db, config,
        query: Object.fromEntries(url.searchParams),
        body: async () => {
          if (!bodyRead) {
            bodyCache = await readBody(req)
            bodyRead = true
          }
          return bodyCache
        },
      }
      return finish(await route.handler(ctx))
    } catch (e) {
      const err = e instanceof ApiError ? e : mapDbError(e)
      if (err.status >= 500) {
        log({ level: 'error', request_id: requestId, path, error: e instanceof Error ? e.message : String(e),
              db_code: e instanceof DbError ? e.code : undefined })
      }
      return finish(json(err.status, errorBody(err, requestId), err.headers))
    }
  }
}

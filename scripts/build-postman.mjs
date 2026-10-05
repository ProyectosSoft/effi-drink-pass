// Genera docs/postman/Effi-Drink-Pass.postman_collection.json y el environment.
// Uso: npm run postman   (editar este archivo, no el JSON generado)
import { mkdirSync, writeFileSync } from 'node:fs'

/** JSON con sangría de 2 espacios (diffs legibles del archivo generado). */
const J = (o) => JSON.stringify(o, null, 2)
/** Postman guarda los scripts como arreglo de líneas (`exec`). */
const lines = (s) => s.trim().split('\n')

/**
 * Request helper: construye un item de Postman (colección v2.1).
 * @param path ruta relativa a {{base_url}} (con query opcional) o URL absoluta ({{supabase_url}}/…)
 * @param opts.body cuerpo JSON (objeto o string con variables {{…}} que no serían JSON válido)
 * @param opts.form cuerpo x-www-form-urlencoded; opts.rawText cuerpo crudo sin Content-Type JSON
 * @param opts.auth sobrescribe la auth de la colección (Bearer {{access_token}} por defecto)
 * @param opts.pre / opts.tests scripts pre-request y de pruebas del request
 */
function req(name, method, path, { body, headers = [], auth, tests = '', pre = '', description = '', form, rawText } = {}) {
  const item = {
    name,
    event: [],
    request: {
      method,
      header: headers,
      url: {
        raw: `{{base_url}}${path}`,
        host: ['{{base_url}}'],
        path: path.split('?')[0].split('/').filter(Boolean),
        ...(path.includes('?') ? { query: path.split('?')[1].split('&').map((kv) => { const [key, value] = kv.split('='); return { key, value } }) } : {}),
      },
      description,
    },
  }
  // URLs absolutas (p. ej. Supabase Auth) no cuelgan de base_url: se usan como string tal cual.
  if (path.startsWith('http') || path.startsWith('{{supabase_url}}')) {
    item.request.url = path
  }
  if (auth) item.request.auth = auth
  if (body !== undefined) {
    item.request.header = [...headers, { key: 'Content-Type', value: 'application/json' }]
    item.request.body = { mode: 'raw', raw: typeof body === 'string' ? body : J(body), options: { raw: { language: 'json' } } }
  }
  if (rawText !== undefined) item.request.body = { mode: 'raw', raw: rawText }
  if (form) item.request.body = { mode: 'urlencoded', urlencoded: Object.entries(form).map(([key, value]) => ({ key, value })) }
  if (pre) item.event.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: lines(pre) } })
  if (tests) item.event.push({ listen: 'test', script: { type: 'text/javascript', exec: lines(tests) } })
  return item
}
/** Carpeta de la colección. */
const folder = (name, description, item) => ({ name, description, item })
// Variantes de autenticación por request (la colección usa Bearer {{access_token}} por defecto).
const noauth = { type: 'noauth' }
/** JWT de Supabase Auth de un usuario staff (endpoints /v1/admin/*). */
const staffAuth = { type: 'bearer', bearer: [{ key: 'token', value: '{{staff_jwt}}', type: 'string' }] }
const apiKeyAuth = (v) => ({ type: 'apikey', apikey: [{ key: 'key', value: 'X-API-Key', type: 'string' }, { key: 'value', value: v, type: 'string' }, { key: 'in', value: 'header', type: 'string' }] })
// Generadores de aserciones pm.test reutilizables (devuelven código JS como string).
const status = (code) => `pm.test('HTTP ${code}', () => pm.response.to.have.status(${code}));`
const errCode = (code) => `pm.test('error.code = ${code}', () => pm.expect(pm.response.json().error.code).to.eql('${code}'));`

// ───────────────────────────── Scripts de colección ─────────────────────────
// Ojo: el contenido de estos template strings es JavaScript que ejecuta Postman, no este script.
/** Pre-request global: renueva el access token 60 s antes de expirar (excepto en las llamadas de login). */
const collectionPre = `
// Obtiene/renueva automáticamente el access token OAuth2 (client_credentials) si hay client_id/secret.
const base = pm.collectionVariables.get('base_url') || pm.environment.get('base_url');
const cid = pm.environment.get('client_id') || pm.collectionVariables.get('client_id');
const secret = pm.environment.get('client_secret') || pm.collectionVariables.get('client_secret');
const exp = Number(pm.environment.get('access_token_expires_at') || 0);
const url = pm.request.url.toString();
if (cid && secret && base && !url.includes('/oauth/token') && !url.includes('/auth/v1/') && Date.now() > exp - 60000) {
  pm.sendRequest({
    url: base + '/v1/oauth/token', method: 'POST',
    header: { 'Content-Type': 'application/json' },
    body: { mode: 'raw', raw: JSON.stringify({ grant_type: 'client_credentials', client_id: cid, client_secret: secret }) }
  }, (err, res) => {
    if (!err && res.code === 200) {
      const j = res.json();
      pm.environment.set('access_token', j.access_token);
      pm.environment.set('access_token_expires_at', String(Date.now() + j.expires_in * 1000));
    }
  });
}`

/** Tests globales: request id, no-store, formato de error y que un 500 no filtre detalles de SQL/stack. */
const collectionTests = `
// Contratos comunes a toda la API.
if (!pm.request.url.toString().includes('/auth/v1/')) {
  pm.test('[común] X-Request-Id presente', () => pm.expect(pm.response.headers.get('X-Request-Id')).to.be.a('string'));
  pm.test('[común] Cache-Control no-store', () => pm.expect(pm.response.headers.get('Cache-Control') || '').to.include('no-store'));
  if (pm.response.code >= 400 && !pm.request.url.toString().includes('/oauth/token')) {
    pm.test('[común] Error con formato { error: { code, message, request_id } }', () => {
      const e = pm.response.json().error;
      pm.expect(e).to.have.property('code');
      pm.expect(e).to.have.property('message');
      pm.expect(e).to.have.property('request_id');
    });
  }
  if (pm.response.code === 500) {
    pm.test('[común] 500 no filtra detalles internos', () => pm.expect(pm.response.text()).to.not.match(/relation|column|stack|at \\w+ \\(/i));
  }
}`

// ───────────────────────────── Items ────────────────────────────────────────
// Las carpetas se ejecutan en orden con el Runner y se encadenan vía variables de environment
// (integration_id, attendee_id, benefit_id…), por lo que el orden de los requests importa.
const items = [
  folder('00 · Health', 'Endpoint público de estado.', [
    req('Health check', 'GET', '/v1/health', { auth: noauth, tests: `${status(200)}\npm.test('status ok y base de datos ok', () => { const j = pm.response.json(); pm.expect(j.status).to.eql('ok'); pm.expect(j.checks.database).to.eql('ok'); });` }),
  ]),

  folder('01 · Autenticación', 'Staff: login con Supabase Auth (email+password) → staff_jwt. Integraciones: OAuth2 client_credentials → access_token (automático por el pre-request de la colección).', [
    req('Staff · Login Supabase Auth (password)', 'POST', '{{supabase_url}}/auth/v1/token?grant_type=password', {
      auth: noauth,
      headers: [{ key: 'apikey', value: '{{supabase_anon_key}}' }],
      body: { email: '{{staff_email}}', password: '{{staff_password}}' },
      description: 'Requiere un usuario del staff con contraseña definida (Mi cuenta → contraseña). Guarda staff_jwt.',
      tests: `${status(200)}\nconst j = pm.response.json();\npm.environment.set('staff_jwt', j.access_token);\npm.test('staff_jwt guardado', () => pm.expect(j.access_token).to.be.a('string'));`,
    }),
    req('OAuth2 · Token (client_credentials, form)', 'POST', '/v1/oauth/token', {
      auth: noauth,
      form: { grant_type: 'client_credentials', client_id: '{{client_id}}', client_secret: '{{client_secret}}' },
      tests: `${status(200)}\nconst j = pm.response.json();\npm.test('token Bearer', () => { pm.expect(j.token_type).to.eql('Bearer'); pm.expect(j.expires_in).to.be.above(0); });\npm.environment.set('access_token', j.access_token);\npm.environment.set('access_token_expires_at', String(Date.now() + j.expires_in * 1000));`,
    }),
    req('OAuth2 · Credenciales inválidas → 401 invalid_client', 'POST', '/v1/oauth/token', {
      auth: noauth,
      body: { grant_type: 'client_credentials', client_id: '{{client_id}}', client_secret: 'edp_sk_incorrecto' },
      tests: `${status(401)}\npm.test('error invalid_client (RFC 6749)', () => pm.expect(pm.response.json().error).to.eql('invalid_client'));`,
    }),
    req('OAuth2 · grant_type no soportado → 400', 'POST', '/v1/oauth/token', {
      auth: noauth, body: { grant_type: 'password' },
      tests: `${status(400)}\npm.test('unsupported_grant_type', () => pm.expect(pm.response.json().error).to.eql('unsupported_grant_type'));`,
    }),
    req('Identidad de la credencial (GET /v1/me)', 'GET', '/v1/me', {
      tests: `${status(200)}\npm.test('principal de integración con scopes', () => { const d = pm.response.json().data; pm.expect(d.type).to.eql('integration'); pm.expect(d.scopes).to.be.an('array').that.is.not.empty; });`,
    }),
    req('API key (X-API-Key) · GET /v1/me', 'GET', '/v1/me', {
      auth: apiKeyAuth('{{api_key}}'),
      tests: `${status(200)}`,
    }),
  ]),

  folder('02 · Administración de integraciones (staff)', 'Requiere staff_jwt de un usuario con integrations:manage. Crea una integración y credenciales de prueba y las guarda en el environment.', [
    req('Crear integración', 'POST', '/v1/admin/integrations', {
      auth: staffAuth,
      pre: `pm.variables.set('integration_name', 'Postman ' + new Date().toISOString());`,
      body: { name: '{{integration_name}}', description: 'Integración de prueba creada desde Postman', allowed_scopes: ['attendees:read', 'attendees:write', 'event-days:read', 'benefits:read', 'benefits:write', 'benefits:validate', 'benefits:redeem', 'consumptions:read', 'statistics:read'] },
      tests: `${status(201)}\npm.environment.set('integration_id', pm.response.json().data.id);`,
    }),
    req('Generar credencial completa', 'POST', '/v1/admin/integrations/{{integration_id}}/credentials', {
      auth: staffAuth,
      body: { scopes: ['attendees:read', 'attendees:write', 'event-days:read', 'benefits:read', 'benefits:write', 'benefits:validate', 'benefits:redeem', 'consumptions:read', 'statistics:read'] },
      tests: `${status(201)}\nconst d = pm.response.json().data;\npm.test('secreto con formato fuerte', () => pm.expect(d.client_secret).to.match(/^edp_sk_[A-Za-z0-9_-]{43}$/));\npm.environment.set('client_id', d.client_id);\npm.environment.set('client_secret', d.client_secret);\npm.environment.set('api_key', d.api_key);\npm.environment.set('credential_id', d.id);\npm.environment.unset('access_token');\npm.environment.set('access_token_expires_at', '0');`,
    }),
    req('Generar credencial solo lectura (para probar 403)', 'POST', '/v1/admin/integrations/{{integration_id}}/credentials', {
      auth: staffAuth,
      body: { scopes: ['attendees:read'] },
      tests: `${status(201)}\nconst d = pm.response.json().data;\npm.environment.set('readonly_api_key', d.api_key);\npm.environment.set('readonly_credential_id', d.id);`,
    }),
    req('Integración NO puede administrar → 403', 'POST', '/v1/admin/integrations', {
      body: { name: 'Intento no autorizado', allowed_scopes: [] },
      tests: `${status(403)}`,
    }),
  ]),

  folder('03 · Días del evento', '', [
    req('Listar días', 'GET', '/v1/event-days', {
      tests: `${status(200)}\nconst days = pm.response.json().data;\npm.test('hay días configurados', () => pm.expect(days).to.be.an('array').that.is.not.empty);\nconst today = days.find(d => d.is_today);\npm.environment.set('event_day_id', (today || days[0]).id);\nconst other = days.find(d => !d.is_today);\nif (other) pm.environment.set('event_day_id_other', other.id);\nif (!today) console.warn('No hay un día del evento con fecha de HOY: los consumos devolverán NOT_TODAY. Cree un día de prueba con la fecha actual (ver docs/POSTMAN.md).');`,
    }),
    req('Obtener día', 'GET', '/v1/event-days/{{event_day_id}}', { tests: `${status(200)}` }),
  ]),

  folder('04 · Asistentes', 'CRUD y búsqueda por identificadores externos (effi_id / effi_username).', [
    req('Crear asistente (con días → genera beneficios)', 'POST', '/v1/attendees', {
      pre: `pm.variables.set('rnd', String(Date.now()));`,
      body: '{\n  "nombres": "Postman",\n  "apellidos": "Prueba {{rnd}}",\n  "email": "postman.{{rnd}}@example.invalid",\n  "effi_id": "PM-{{rnd}}",\n  "effi_username": "postman.{{rnd}}",\n  "tipo_acceso": "VIP",\n  "empresa": "QA",\n  "event_day_ids": ["{{event_day_id}}"]\n}',
      tests: `${status(201)}\nconst d = pm.response.json().data;\npm.environment.set('attendee_id', d.id);\npm.environment.set('effi_id', d.effi_id);\npm.test('Location', () => pm.expect(pm.response.headers.get('Location')).to.include(d.id));`,
    }),
    req('Listar asistentes (paginado)', 'GET', '/v1/attendees?page=1&page_size=20', {
      tests: `${status(200)}\npm.test('meta de paginación', () => pm.expect(pm.response.json().meta).to.include.keys('page', 'page_size', 'total', 'total_pages'));`,
    }),
    req('Buscar por effi_id', 'GET', '/v1/attendees?effi_id={{effi_id}}', {
      tests: `${status(200)}\npm.test('encuentra exactamente 1', () => pm.expect(pm.response.json().meta.total).to.eql(1));`,
    }),
    req('Obtener asistente', 'GET', '/v1/attendees/{{attendee_id}}', { tests: `${status(200)}\npm.test('incluye event_days', () => pm.expect(pm.response.json().data.event_days).to.be.an('array'));` }),
    req('Actualizar asistente (PATCH)', 'PATCH', '/v1/attendees/{{attendee_id}}', {
      body: { empresa: 'QA Actualizada' },
      tests: `${status(200)}\npm.test('empresa actualizada', () => pm.expect(pm.response.json().data.empresa).to.eql('QA Actualizada'));`,
    }),
    req('Definir días elegibles (todos)', 'PUT', '/v1/attendees/{{attendee_id}}/event-days', {
      pre: `const ids = [pm.environment.get('event_day_id'), pm.environment.get('event_day_id_other')].filter(Boolean);\npm.variables.set('day_ids', JSON.stringify(ids));`,
      body: '{ "event_day_ids": {{day_ids}} }',
      tests: `${status(200)}`,
    }),
    req('Beneficios del asistente', 'GET', '/v1/attendees/{{attendee_id}}/benefits', {
      tests: `${status(200)}\nconst list = pm.response.json().data;\nconst today = list.find(b => b.event_day.id === pm.environment.get('event_day_id'));\nconst other = list.find(b => b.event_day.id !== pm.environment.get('event_day_id'));\npm.environment.set('benefit_id', today.id);\nif (other) pm.environment.set('benefit_id_other_day', other.id);\npm.test('un beneficio por día, sin token expuesto', () => { pm.expect(list.length).to.be.at.least(1); pm.expect(pm.response.text()).to.not.include('token'); });`,
    }),
  ]),

  folder('05 · Beneficios: validar y consumir', 'Requiere que event_day_id sea un día con la fecha de HOY en el servidor (America/Bogota).', [
    req('Listar beneficios pendientes', 'GET', '/v1/benefits?status=PENDING&page_size=10', { tests: `${status(200)}` }),
    req('Estado del beneficio', 'GET', '/v1/benefits/{{benefit_id}}', { tests: `${status(200)}\npm.test('PENDING', () => pm.expect(pm.response.json().data.effective_status).to.eql('PENDING'));` }),
    req('Validar beneficio (no consume)', 'POST', '/v1/benefits/{{benefit_id}}/validate', {
      body: {},
      tests: `${status(200)}\npm.test('VALID', () => pm.expect(pm.response.json().data.code).to.eql('VALID'));`,
    }),
    req('Consumir beneficio (Idempotency-Key)', 'POST', '/v1/benefits/{{benefit_id}}/redeem', {
      pre: `pm.environment.set('idempotency_key', 'postman-' + pm.variables.replaceIn('{{$guid}}'));`,
      headers: [{ key: 'Idempotency-Key', value: '{{idempotency_key}}' }],
      body: { metadata: { pos: 'postman' } },
      tests: `${status(200)}\npm.test('BENEFICIO APROBADO', () => { const d = pm.response.json().data; pm.expect(d.code).to.eql('APPROVED'); pm.expect(d.message).to.eql('BENEFICIO APROBADO'); });`,
    }),
    req('Reintento con la MISMA Idempotency-Key → misma respuesta', 'POST', '/v1/benefits/{{benefit_id}}/redeem', {
      headers: [{ key: 'Idempotency-Key', value: '{{idempotency_key}}' }],
      body: { metadata: { pos: 'postman' } },
      tests: `${status(200)}\npm.test('Idempotent-Replayed: true', () => pm.expect(pm.response.headers.get('Idempotent-Replayed')).to.eql('true'));`,
    }),
    req('Intentar consumir nuevamente → 409 BENEFICIO YA CONSUMIDO', 'POST', '/v1/benefits/{{benefit_id}}/redeem', {
      body: {},
      tests: `${status(409)}\n${errCode('ALREADY_CONSUMED')}\npm.test('informa quién y cuándo', () => pm.expect(pm.response.json().data.consumption).to.have.property('consumed_at'));`,
    }),
    req('QR inválido → 404 INVALID_QR (sin datos)', 'POST', '/v1/benefits/redeem', {
      body: { token: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      tests: `${status(404)}\n${errCode('INVALID_QR')}\npm.test('no revela asistente', () => pm.expect(pm.response.json().data.attendee).to.eql(null));`,
    }),
    req('QR de otro día → 422 (NOT_TODAY o EXPIRED)', 'POST', '/v1/benefits/{{benefit_id_other_day}}/redeem', {
      body: {},
      description: 'Si el otro día es futuro → NOT_TODAY (QR NO VÁLIDO PARA HOY); si es pasado → EXPIRED (BENEFICIO EXPIRADO).',
      tests: `${status(422)}\npm.test('NOT_TODAY o EXPIRED', () => pm.expect(['NOT_TODAY', 'EXPIRED']).to.include(pm.response.json().error.code));`,
    }),
    req('QR expirado → 422 EXPIRED (requiere benefit_id_expired)', 'POST', '/v1/benefits/{{benefit_id_expired}}/redeem', {
      body: {},
      description: 'Configure benefit_id_expired con un beneficio de un día ya terminado (ver docs/POSTMAN.md). Si está vacío, la prueba se omite.',
      pre: `if (!pm.environment.get('benefit_id_expired')) { pm.execution.skipRequest(); }`,
      tests: `${status(422)}\n${errCode('EXPIRED')}`,
    }),
    req('Validar por token del QR (qr_token, opcional)', 'POST', '/v1/benefits/validate', {
      body: { token: '{{qr_token}}' },
      pre: `if (!pm.environment.get('qr_token')) { pm.execution.skipRequest(); }`,
      tests: `${status(200)}`,
    }),
  ]),

  folder('06 · Consumos', '', [
    req('Listar consumos por effi_id', 'GET', '/v1/consumptions?effi_id={{effi_id}}', {
      tests: `${status(200)}\nconst d = pm.response.json().data;\npm.test('1 consumo', () => pm.expect(d.length).to.eql(1));\nif (d[0]) pm.environment.set('consumption_id', d[0].id);`,
    }),
    req('Obtener consumo', 'GET', '/v1/consumptions/{{consumption_id}}', {
      tests: `${status(200)}\npm.test('operador = integración', () => pm.expect(pm.response.json().data.operator.type).to.eql('integration'));`,
    }),
  ]),

  folder('07 · Estadísticas', '', [
    req('Estadísticas globales', 'GET', '/v1/statistics', {
      tests: `${status(200)}\npm.test('totales y series', () => { const d = pm.response.json().data; pm.expect(d).to.have.property('totals'); pm.expect(d.by_hour).to.have.lengthOf(24); });`,
    }),
    req('Estadísticas por día', 'GET', '/v1/statistics?event_day_id={{event_day_id}}', { tests: `${status(200)}` }),
  ]),

  folder('08 · Errores (400 · 401 · 403 · 404 · 409 · 413 · 415 · 422 · 429 · 500)', 'Casos negativos del contrato. 500 no es reproducible a propósito (no existe un endpoint de fallo inducido en producción); el test común de la colección valida su formato si ocurre.', [
    req('400 · id con formato inválido', 'GET', '/v1/attendees/no-es-uuid', { tests: `${status(400)}\n${errCode('VALIDATION_ERROR')}` }),
    req('400 · parámetro de consulta desconocido', 'GET', '/v1/attendees?inventado=1', { tests: `${status(400)}` }),
    req('400 · JSON mal formado', 'POST', '/v1/attendees', { body: '{ "nombres": ', tests: `${status(400)}\n${errCode('INVALID_JSON')}` }),
    req('401 · sin autenticación', 'GET', '/v1/attendees', { auth: noauth, tests: `${status(401)}\n${errCode('UNAUTHENTICATED')}` }),
    req('401 · token inválido', 'GET', '/v1/attendees', {
      auth: { type: 'bearer', bearer: [{ key: 'token', value: 'eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJlZmZpLWRyaW5rLXBhc3MifQ.invalida', type: 'string' }] },
      tests: `${status(401)}`,
    }),
    req('403 · scope insuficiente (credencial solo lectura)', 'GET', '/v1/consumptions', {
      auth: apiKeyAuth('{{readonly_api_key}}'),
      tests: `${status(403)}\n${errCode('INSUFFICIENT_SCOPE')}`,
    }),
    req('404 · recurso inexistente', 'GET', '/v1/attendees/00000000-0000-4000-8000-000000000000', { tests: `${status(404)}\n${errCode('NOT_FOUND')}` }),
    req('404 · ruta inexistente', 'GET', '/v1/no-existe', { tests: `${status(404)}\n${errCode('ROUTE_NOT_FOUND')}` }),
    req('409 · effi_id duplicado', 'POST', '/v1/attendees', { body: { nombres: 'Duplicado', effi_id: '{{effi_id}}' }, tests: `${status(409)}\n${errCode('CONFLICT')}` }),
    req('413 · cuerpo mayor a 64 KB', 'POST', '/v1/attendees', {
      pre: `pm.variables.set('big', 'x'.repeat(70000));`,
      body: '{ "nombres": "Grande", "metadata": { "blob": "{{big}}" } }',
      tests: `${status(413)}`,
    }),
    req('415 · Content-Type incorrecto', 'POST', '/v1/attendees', {
      headers: [{ key: 'Content-Type', value: 'text/plain' }],
      rawText: 'nombres=Texto plano',
      tests: `${status(415)}`,
    }),
    req('422 · validación de campos', 'POST', '/v1/attendees', {
      body: { apellidos: 'Sin nombre', email: 'no-es-email', campo_inventado: true },
      tests: `${status(422)}\n${errCode('VALIDATION_ERROR')}\npm.test('detalle por campo', () => pm.expect(pm.response.json().error.details.fields).to.be.an('array').that.is.not.empty);`,
    }),
    req('429 · rate limit de estadísticas (ejecutar en el Runner)', 'GET', '/v1/statistics', {
      description: 'Se repite a sí mismo hasta 35 veces con setNextRequest; el límite es 30/min por credencial.',
      tests: `const n = Number(pm.environment.get('rl_count') || 0) + 1;\npm.environment.set('rl_count', String(n));\nif (pm.response.code === 429) {\n  pm.test('429 con Retry-After y X-RateLimit-*', () => { pm.expect(pm.response.headers.get('Retry-After')).to.be.ok; pm.expect(pm.response.headers.get('X-RateLimit-Remaining')).to.eql('0'); });\n  pm.environment.unset('rl_count');\n} else if (n < 35) {\n  pm.execution.setNextRequest(pm.info.requestName);\n} else {\n  pm.test('se esperaba 429 antes de 35 intentos', () => pm.expect.fail());\n  pm.environment.unset('rl_count');\n}`,
    }),
  ]),

  folder('09 · Rotación y revocación (staff)', '', [
    req('Rotar credencial solo lectura', 'POST', '/v1/admin/credentials/{{readonly_credential_id}}/rotate', {
      auth: staffAuth,
      tests: `${status(201)}\nconst d = pm.response.json().data;\npm.environment.set('readonly_credential_id', d.id);\npm.environment.set('readonly_api_key_old', pm.environment.get('readonly_api_key'));\npm.environment.set('readonly_api_key', d.api_key);`,
    }),
    req('La credencial rotada ya no funciona → 401 CREDENTIAL_REVOKED', 'GET', '/v1/me', {
      auth: apiKeyAuth('{{readonly_api_key_old}}'),
      tests: `${status(401)}\n${errCode('CREDENTIAL_REVOKED')}`,
    }),
    req('Revocar credencial solo lectura', 'POST', '/v1/admin/credentials/{{readonly_credential_id}}/revoke', {
      auth: staffAuth, body: { reason: 'Fin de prueba Postman' }, tests: `${status(200)}`,
    }),
  ]),
]


// Orden de ejecución: primero el staff crea integración y credenciales; luego se usan.
// Se mueve el login de staff a la carpeta de administración y se intercambian las carpetas 01/02.
{
  const auth = items[1]
  const admin = items[2]
  const staffLogin = auth.item.shift()
  admin.item.unshift(staffLogin)
  admin.name = '01 · Staff: login y credenciales de integración'
  auth.name = '02 · Integraciones: OAuth2 y API key'
  items[1] = admin
  items[2] = auth
}

/** Colección final: auth Bearer {{access_token}} heredada por todos los requests salvo que la sobrescriban. */
const collection = {
  info: {
    name: 'Effi Drink Pass API v1',
    _postman_id: 'b7a2f1f0-3c1e-4d9a-9a55-effi0drinkpass',
    description: 'Colección completa de la API pública de Effi Drink Pass (Feria Effix 2026). Ver docs/POSTMAN.md.\n\nOrden recomendado: ejecutar la colección completa con el Runner. El pre-request de la colección obtiene y renueva el access token OAuth2 automáticamente.',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{access_token}}', type: 'string' }] },
  event: [
    { listen: 'prerequest', script: { type: 'text/javascript', exec: lines(collectionPre) } },
    { listen: 'test', script: { type: 'text/javascript', exec: lines(collectionTests) } },
  ],
  variable: [
    { key: 'collection_version', value: '1.0.0' },
  ],
  item: items,
}

/**
 * Variables del environment: [clave, valor inicial, tipo]. Las de tipo 'secret' se enmascaran en Postman;
 * el archivo generado nunca contiene secretos reales (se completan localmente).
 */
const envVars = [
  ['base_url', 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/api', 'default'],
  ['supabase_url', 'https://YOUR-PROJECT-REF.supabase.co', 'default'],
  ['supabase_anon_key', '', 'default'],
  ['staff_email', '', 'default'],
  ['staff_password', '', 'secret'],
  ['staff_jwt', '', 'secret'],
  ['client_id', '', 'default'],
  ['client_secret', '', 'secret'],
  ['api_key', '', 'secret'],
  ['access_token', '', 'secret'],
  ['access_token_expires_at', '0', 'default'],
  ['readonly_api_key', '', 'secret'],
  ['readonly_api_key_old', '', 'secret'],
  ['readonly_credential_id', '', 'default'],
  ['integration_id', '', 'default'],
  ['credential_id', '', 'default'],
  ['event_day_id', '', 'default'],
  ['event_day_id_other', '', 'default'],
  ['attendee_id', '', 'default'],
  ['effi_id', '', 'default'],
  ['benefit_id', '', 'default'],
  ['benefit_id_other_day', '', 'default'],
  ['benefit_id_expired', '', 'default'],
  ['consumption_id', '', 'default'],
  ['qr_token', '', 'secret'],
  ['idempotency_key', '', 'default'],
]
const environment = {
  id: 'e1f0d7a2-5b4c-4a3e-9f21-effidrinkpass',
  name: 'Effi Drink Pass — (completar)',
  values: envVars.map(([key, value, type]) => ({ key, value, type, enabled: true })),
  _postman_variable_scope: 'environment',
}

// Rutas relativas al directorio actual: ejecutar desde la raíz del repo (npm run postman).
mkdirSync('docs/postman', { recursive: true })
writeFileSync('docs/postman/Effi-Drink-Pass.postman_collection.json', J(collection) + '\n')
writeFileSync('docs/postman/Effi-Drink-Pass.postman_environment.json', J(environment) + '\n')
const count = items.reduce((n, f) => n + f.item.length, 0)
console.log(`Postman: ${items.length} carpetas, ${count} requests`)

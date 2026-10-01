/**
 * Ejecuta la colección Postman COMPLETA con Newman contra un servidor HTTP local que sirve
 * la API real (mismo código de la Edge Function) sobre PostgreSQL embebido con las migraciones.
 * Supabase Auth se simula solo para el login del staff (POST /auth/v1/token).
 *
 *   npm run test:postman      (descarga newman con npx; requiere red la primera vez)
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApi } from '../../supabase/functions/_shared/app.ts'
import { createDb, createStaff, one, type Db } from '../db/harness'
import { fakeSupabaseJwt, pglitePort } from '../api/pglite-port'

describe('colección Postman (Newman)', () => {
  let db: Db
  let server: Server
  let port = 0
  let staffJwt = ''
  let expiredBenefitId = ''
  const dir = mkdtempSync(join(tmpdir(), 'edp-postman-'))

  beforeAll(async () => {
    db = await createDb()
    // Reloj real del servidor (sin override): un día del evento HOY, otro mañana y otro ayer (Bogotá).
    const today = await one<{ d: string }>(db, `select (now() at time zone 'America/Bogota')::date::text d`)
    await db.query(`insert into public.event_days (date, name, start_time, end_time) values
      ($1::date, 'Hoy (prueba)', '00:00', '23:59:59'),
      ($1::date + 1, 'Mañana (prueba)', '08:00', '20:00'),
      ($1::date - 1, 'Ayer (prueba)', '08:00', '20:00')`, [today.d])
    const staff = await createStaff(db, 'admin@postman.test', ['admin'])
    staffJwt = fakeSupabaseJwt(staff.authId)
    // Beneficio de un día ya terminado para el caso "QR expirado".
    const a = await one<{ id: string }>(db, `insert into public.attendees (nombres, email) values ('Expirado', 'exp@postman.test') returning id`)
    await db.query(`insert into public.attendee_event_days (attendee_id, event_day_id) select $1, id from public.event_days where name = 'Ayer (prueba)'`, [a.id])
    expiredBenefitId = (await one<{ id: string }>(db, `select id from public.benefits where attendee_id = $1`, [a.id])).id

    const handle = createApi(pglitePort(db), { jwtSecret: 'postman-secret-at-least-32-characters!!', allowedOrigins: [], log: () => {} })
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const body = Buffer.concat(chunks)
      if (req.url?.startsWith('/auth/v1/token')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ access_token: staffJwt, token_type: 'bearer', expires_in: 3600 }))
        return
      }
      const request = new Request(`http://127.0.0.1:${port}${req.url}`, {
        method: req.method,
        headers: Object.entries(req.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : v ? [[k, v]] : [])) as [string, string][],
        body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : body,
      })
      const response = await handle(request)
      res.writeHead(response.status, Object.fromEntries(response.headers))
      res.end(Buffer.from(await response.arrayBuffer()))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    port = (server.address() as { port: number }).port
  }, 180_000)

  afterAll(() => server?.close())

  // Asíncrono: el servidor HTTP corre en este mismo proceso (un exec síncrono bloquearía el event loop).
  it('todas las aserciones de la colección pasan', async () => {
    const env = JSON.parse(readFileSync('docs/postman/Effi-Drink-Pass.postman_environment.json', 'utf8'))
    const set = (k: string, v: string) => { env.values.find((x: { key: string }) => x.key === k).value = v }
    set('base_url', `http://127.0.0.1:${port}/api`)
    set('supabase_url', `http://127.0.0.1:${port}`)
    set('supabase_anon_key', 'anon')
    set('staff_email', 'admin@postman.test')
    set('staff_password', 'irrelevante-en-prueba')
    set('benefit_id_expired', expiredBenefitId)
    const envPath = join(dir, 'env.json')
    const reportPath = join(dir, 'report.json')
    writeFileSync(envPath, JSON.stringify(env))

    let output = ''
    try {
      const r = await promisify(execFile)('npx', ['--yes', 'newman@6', 'run', 'docs/postman/Effi-Drink-Pass.postman_collection.json',
        '-e', envPath, '--reporters', 'cli,json', '--reporter-json-export', reportPath, '--disable-unicode', '--color', 'off'],
      { encoding: 'utf8', shell: process.platform === 'win32', timeout: 240_000 })
      output = r.stdout
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string }
      output = `${err.stdout ?? ''}
${err.stderr ?? String(e)}`
    }
    if (!existsSync(reportPath)) throw new Error(`Newman no generó reporte:
${output.slice(-4000)}`)
    const report = JSON.parse(readFileSync(reportPath, 'utf8'))
    const failures = report.run.failures.map((f: { source?: { name?: string }; error: { test?: string; message: string } }) =>
      `${f.source?.name}: ${f.error.test ?? ''} — ${f.error.message}`)
    if (failures.length) console.log(output.slice(-6000))
    expect(failures).toEqual([])
    expect(report.run.stats.requests.total).toBeGreaterThanOrEqual(50)
    expect(report.run.stats.assertions.failed).toBe(0)
  }, 300_000)
})

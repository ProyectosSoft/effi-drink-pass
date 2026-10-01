import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const migrationsDir = join(root, 'supabase', 'migrations')

export type Db = PGlite

/** Crea una base PostgreSQL en memoria con el shim de Supabase y TODAS las migraciones del repo. */
export async function createDb(): Promise<Db> {
  const db = new PGlite({ extensions: { pgcrypto } })
  await db.exec(readFileSync(join(here, 'supabase-shim.sql'), 'utf8'))
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    try {
      await db.exec(readFileSync(join(migrationsDir, file), 'utf8'))
    } catch (err) {
      throw new Error(`Migración ${file} falló: ${(err as Error).message}`)
    }
  }
  // Solo en pruebas: permitir simular la hora del servidor.
  await db.exec(`update private.config set value = 'true' where key = 'allow_clock_override'`)
  return db
}

/** Fija la hora "actual" del servidor (solo efectiva con allow_clock_override=true). */
export async function setNow(db: Db, iso: string | null) {
  await db.query(`select set_config('app.now_override', $1, false)`, [iso ?? ''])
}

export async function createAuthUser(db: Db, email: string, confirmed = true): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into auth.users (email, email_confirmed_at) values ($1, $2) returning id`,
    [email, confirmed ? new Date().toISOString() : null],
  )
  return r.rows[0].id
}

/** Crea un usuario de staff enlazado a Auth con los roles indicados (como superusuario). */
export async function createStaff(db: Db, email: string, roles: string[]): Promise<{ authId: string; profileId: string }> {
  const authId = await createAuthUser(db, email)
  const p = await db.query<{ id: string }>(
    `insert into public.profiles (auth_user_id, email, nombres, apellidos) values ($1, $2, $3, 'Test') returning id`,
    [authId, email, email.split('@')[0]],
  )
  const profileId = p.rows[0].id
  for (const role of roles) {
    await db.query(
      `insert into public.user_roles (user_id, role_id) select $1, id from public.roles where name = $2`,
      [profileId, role],
    )
  }
  return { authId, profileId }
}

/**
 * Ejecuta una consulta como un rol de PostgREST.
 * sub = auth user id → rol authenticated;  sub = null → rol anon.
 */
export async function as<T = Record<string, unknown>>(
  db: Db,
  sub: string | null,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const claims = sub ? JSON.stringify({ sub, role: 'authenticated' }) : ''
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [claims])
  await db.exec(sub ? 'set role authenticated' : 'set role anon')
  try {
    const r = await db.query<T>(sql, params)
    return r.rows
  } finally {
    await db.exec('reset role')
    await db.query(`select set_config('request.jwt.claims', '', false)`)
  }
}

/** Ejecuta como service_role (Edge Function). */
export async function asService<T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  await db.exec('set role service_role')
  try {
    return (await db.query<T>(sql, params)).rows
  } finally {
    await db.exec('reset role')
  }
}

export async function rpc<T = unknown>(db: Db, sub: string | null, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const names = Object.keys(args)
  const placeholders = names.map((n, i) => `${n} => $${i + 1}`).join(', ')
  const rows = await as<{ result: T }>(db, sub, `select public.${fn}(${placeholders}) as result`, names.map((n) => args[n]))
  return rows[0].result
}

/** Obtiene el token de un beneficio como lo haría su dueño (superusuario; solo pruebas). */
export async function tokenFor(db: Db, benefitId: string): Promise<string> {
  const r = await db.query<{ t: string }>(
    `select private.benefit_token(id, token_salt) as t from public.benefits where id = $1`,
    [benefitId],
  )
  return r.rows[0].t
}

export async function one<T>(db: Db, sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<T>(sql, params)
  return r.rows[0]
}

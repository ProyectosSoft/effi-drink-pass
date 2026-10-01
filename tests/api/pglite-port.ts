/**
 * DbPort de pruebas: ejecuta las RPC contra PGlite (mismas migraciones que producción),
 * imitando a PostgREST (service_role / authenticated con claims).
 */
import type { DbPort } from '../../supabase/functions/_shared/app.ts'
import { DbError } from '../../supabase/functions/_shared/errors.ts'
import { peekJwtPayload } from '../../supabase/functions/_shared/jwt.ts'
import type { Db } from '../db/harness'

type PgErr = { code?: string; message?: string; detail?: string }

export function pglitePort(db: Db): DbPort {
  const argTypes = new Map<string, Map<string, string>>()

  async function types(fn: string): Promise<Map<string, string>> {
    if (argTypes.has(fn)) return argTypes.get(fn)!
    const r = await db.query<{ names: string[] | null; types: string[] }>(
      `select p.proargnames as names, array(select format_type(t, null) from unnest(p.proargtypes) t) as types
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1`, [fn])
    const m = new Map<string, string>()
    const row = r.rows[0]
    row?.names?.forEach((n, i) => m.set(n, row.types[i]))
    argTypes.set(fn, m)
    return m
  }

  // Serializa todas las llamadas: PGlite es una sola conexión y el rol/claims son de sesión.
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn)
    queue = next.catch(() => undefined)
    return next
  }

  async function call<T>(role: 'service_role' | 'authenticated', sub: string | null, fn: string, args: Record<string, unknown> = {}) {
    return serial(async () => {
      const t = await types(fn)
      const names = Object.keys(args)
      const values = names.map((n) => {
        const v = args[n]
        const ty = t.get(n) ?? ''
        if (v !== null && v !== undefined && (ty === 'jsonb' || ty === 'json')) return JSON.stringify(v)
        return v ?? null
      })
      const sql = `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}::${t.get(n) ?? 'text'}`).join(', ')}) as r`
      await db.query(`select set_config('request.jwt.claims', $1, false)`, [sub ? JSON.stringify({ sub, role }) : ''])
      await db.exec(`set role ${role}`)
      try {
        const r = await db.query<{ r: T }>(sql, values)
        return r.rows[0].r
      } catch (e) {
        const pe = e as PgErr
        throw new DbError({ code: pe.code, message: pe.message, details: pe.detail ?? null })
      } finally {
        await db.exec('reset role')
        await db.query(`select set_config('request.jwt.claims', '', false)`)
      }
    })
  }

  return {
    rpc: (fn, args) => call('service_role', null, fn, args),
    rpcAsUser: (jwt, fn, args) => call('authenticated', String(peekJwtPayload(jwt)?.sub ?? ''), fn, args),
    async getAuthUserId(jwt) {
      const sub = peekJwtPayload(jwt)?.sub
      if (typeof sub !== 'string') return null
      const r = await serial(() => db.query<{ id: string }>(`select id from auth.users where id::text = $1`, [sub]))
      return r.rows[0]?.id ?? null
    },
  }
}

/** JWT de "Supabase Auth" falso para pruebas (el puerto de prueba solo lee el sub). */
export function fakeSupabaseJwt(sub: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, iss: 'https://test.supabase.co/auth/v1', role: 'authenticated' })}.sig`
}

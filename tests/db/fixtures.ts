import { createDb, createStaff, createAuthUser, setNow, one, type Db } from './harness'

/** Escenario estándar: 3 días (15, 16, 17 oct 2026), staff con cada rol y un asistente con cuenta. */
export async function scenario() {
  const db: Db = await createDb()
  // Reloj fijo: 16/10/2026 10:00 hora Bogotá (UTC-5).
  await setNow(db, '2026-10-16T15:00:00Z')

  const days: Record<string, string> = {}
  for (const [date, name] of [['2026-10-15', 'Día 1'], ['2026-10-16', 'Día 2'], ['2026-10-17', 'Día 3']]) {
    const r = await one<{ id: string }>(db,
      `insert into public.event_days (date, name, start_time, end_time) values ($1, $2, '08:00', '20:00') returning id`,
      [date, name])
    days[date] = r.id
  }

  const superAdmin = await createStaff(db, 'root@test.local', ['super_admin'])
  const admin = await createStaff(db, 'admin@test.local', ['admin'])
  const operator = await createStaff(db, 'op1@test.local', ['operator'])
  const operator2 = await createStaff(db, 'op2@test.local', ['operator'])
  const viewer = await createStaff(db, 'viewer@test.local', ['viewer'])

  const attendeeAuth = await createAuthUser(db, 'juan.perez@test.local')
  const att = await one<{ id: string }>(db,
    `insert into public.attendees (nombres, apellidos, email, effi_id, effi_username, tipo_acceso, empresa, auth_user_id)
     values ('Juan', 'Pérez', 'juan.perez@test.local', '123456', 'juan.perez', 'vip', 'ACME', $1) returning id`,
    [attendeeAuth])
  await db.query(
    `insert into public.attendee_event_days (attendee_id, event_day_id) select $1, unnest($2::uuid[])`,
    [att.id, Object.values(days)])

  const benefits: Record<string, string> = {}
  const rows = await db.query<{ id: string; date: string }>(
    `select b.id, d.date::text as date from public.benefits b join public.event_days d on d.id = b.event_day_id where b.attendee_id = $1`,
    [att.id])
  for (const r of rows.rows) benefits[r.date] = r.id

  return { db, days, superAdmin, admin, operator, operator2, viewer, attendeeAuth, attendeeId: att.id, benefits }
}

export type Scenario = Awaited<ReturnType<typeof scenario>>

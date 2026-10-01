import { useQuery, useQueryClient } from '@tanstack/react-query'
import { clsx } from 'clsx'
import { CheckCircle2, ChevronLeft, Clock, GlassWater, LogOut, QrCode as QrIcon, WifiOff } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { extractToken, qrPayload } from '@shared/qr.ts'
import { Logo } from '@/components/layout'
import { QrCode } from '@/components/QrCode'
import { Badge, Button, EmptyState, ErrorBox, Spinner, StatusBadge } from '@/components/ui'
import { useAuth } from '@/lib/auth'
import { config } from '@/lib/config'
import { fmtDateTime, fmtEventDate, fullName, hhmm } from '@/lib/format'
import { rpc } from '@/lib/supabase'
import type { MyBenefits as MyBenefitsData } from '@/lib/types'

type Row = MyBenefitsData['benefits'][number]
const cacheKey = (id: string) => `edp:qr:${id}`

function readCachedToken(id: string): string | null {
  try {
    return extractToken(localStorage.getItem(cacheKey(id)))
  } catch {
    return null
  }
}

export default function MyBenefits() {
  const { signOut, isStaff } = useAuth()
  const [selected, setSelected] = useState<string | null>(null)
  const q = useQuery({
    queryKey: ['my-benefits'],
    queryFn: () => rpc<MyBenefitsData>('get_my_benefits'),
    refetchInterval: selected ? 5_000 : 30_000,
  })

  const data = q.data
  const current = data?.benefits.find((b) => b.benefit_id === selected) ?? null

  return (
    <div className="mx-auto min-h-dvh max-w-lg px-4 pb-10">
      <header className="flex items-center justify-between py-4">
        <Logo />
        <div className="flex items-center gap-1">
          {isStaff && <Link to="/admin" className="rounded-lg px-3 py-2 text-sm text-muted hover:text-ink">Admin</Link>}
          <button onClick={signOut} className="rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-ink" aria-label="Cerrar sesión"><LogOut className="size-5" /></button>
        </div>
      </header>

      {q.isLoading && <Spinner />}
      {q.isError && !data && (
        <div className="space-y-3">
          <ErrorBox error={q.error} />
          <p className="text-sm text-muted">Si ya habías abierto tu QR en este dispositivo, sigue siendo válido: el operador lo valida en línea.</p>
        </div>
      )}

      {data && !data.attendee && (
        <EmptyState title="Tu email no está registrado como asistente" icon={<QrIcon className="size-10" />}>
          Verifica que ingresaste con el mismo email de tu inscripción en la Feria Effix, o acércate al punto de información.
        </EmptyState>
      )}

      {data?.attendee && !current && (
        <>
          <section className="card glow mb-5 p-5">
            <p className="text-xs tracking-wide text-muted uppercase">Asistente</p>
            <h1 className="mt-1 text-2xl font-bold">{fullName(data.attendee)}</h1>
            <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
              <div><dt className="text-xs text-faint">ID Effi</dt><dd className="font-mono">{data.attendee.effi_id ?? '—'}</dd></div>
              <div><dt className="text-xs text-faint">Usuario Effi</dt><dd className="truncate">{data.attendee.effi_username ?? '—'}</dd></div>
              <div><dt className="text-xs text-faint">Tipo de acceso</dt><dd><Badge tone="accent">{data.attendee.tipo_acceso}</Badge></dd></div>
              <div><dt className="text-xs text-faint">Empresa</dt><dd className="truncate">{data.attendee.empresa ?? '—'}</dd></div>
            </dl>
            {!data.attendee.activo && <p className="mt-4 rounded-lg bg-bad/10 p-3 text-sm text-bad">Tu registro está inactivo. Acércate al punto de información.</p>}
          </section>

          <h2 className="mb-3 text-sm font-semibold tracking-wide text-muted uppercase">Beneficios por día</h2>
          {data.benefits.length === 0 ? (
            <EmptyState title="Aún no tienes días asignados" icon={<GlassWater className="size-10" />}>
              Cuando la organización asigne tus días de beneficio aparecerán aquí.
            </EmptyState>
          ) : (
            <ul className="space-y-3">
              {data.benefits.map((b) => (
                <DayCard key={b.event_day.id} row={b} isToday={b.event_day.date === data.today} onOpen={() => b.benefit_id && setSelected(b.benefit_id)} />
              ))}
            </ul>
          )}
          <p className="mt-6 text-center text-xs text-faint">Hora oficial del servidor: {fmtDateTime(data.server_time)} (Colombia)</p>
        </>
      )}

      {data?.attendee && current && (
        <QrView row={current} attendeeName={fullName(data.attendee)} effiId={data.attendee.effi_id} offline={q.isError} onBack={() => setSelected(null)} />
      )}
    </div>
  )
}

function DayCard({ row, isToday, onOpen }: { row: Row; isToday: boolean; onOpen: () => void }) {
  const canOpen = row.benefit_id && (row.display_status === 'AVAILABLE' || row.display_status === 'UPCOMING')
  return (
    <li className={clsx('card flex items-center gap-4 p-4', isToday && 'border-brand/60')}>
      <div className={clsx('grid size-12 shrink-0 place-items-center rounded-xl text-lg font-bold', isToday ? 'brand-gradient text-white' : 'bg-surface-2')}>
        {row.event_day.date.slice(8, 10)}
      </div>
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{row.event_day.name} {isToday && <span className="text-xs text-brand">· HOY</span>}</p>
        <p className="truncate text-xs text-muted">{fmtEventDate(row.event_day.date)} · {hhmm(row.event_day.start_time)}–{hhmm(row.event_day.end_time)}</p>
        <div className="mt-1.5"><StatusBadge status={row.display_status} /></div>
        {row.display_status === 'CONSUMED' && <p className="mt-1 text-xs text-faint">Entregada {fmtDateTime(row.consumed_at)}</p>}
      </div>
      {canOpen && (
        <Button size={isToday ? 'md' : 'sm'} variant={isToday ? 'primary' : 'secondary'} onClick={onOpen} icon={<QrIcon className="size-4" />}>
          {isToday ? 'Mostrar QR' : 'Ver QR'}
        </Button>
      )}
    </li>
  )
}

function QrView({ row, attendeeName, effiId, offline, onBack }: {
  row: Row; attendeeName: string; effiId: string | null; offline: boolean; onBack: () => void
}) {
  const qc = useQueryClient()
  const benefitId = row.benefit_id!
  const [token, setToken] = useState<string | null>(() => readCachedToken(benefitId))
  const [error, setError] = useState<unknown>(null)
  const consumed = row.display_status === 'CONSUMED'

  useEffect(() => {
    let alive = true
    rpc<{ available: boolean; token?: string }>('get_my_benefit_token', { p_benefit_id: benefitId })
      .then((r) => {
        if (!alive) return
        if (r.available && r.token) {
          setToken(r.token)
          try { localStorage.setItem(cacheKey(benefitId), r.token) } catch { /* sin almacenamiento */ }
        } else {
          setToken(null)
          try { localStorage.removeItem(cacheKey(benefitId)) } catch { /* ignorar */ }
        }
      })
      .catch((e) => alive && setError(e))
    return () => { alive = false }
  }, [benefitId])

  // Mantener la pantalla encendida mientras se muestra el QR.
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }
    nav.wakeLock?.request('screen').then((l) => { lock = l }).catch(() => {})
    return () => { void lock?.release().catch(() => {}) }
  }, [])

  useEffect(() => {
    if (consumed) void qc.invalidateQueries({ queryKey: ['my-benefits'] })
  }, [consumed, qc])

  return (
    <section className="flex flex-col items-center text-center">
      <button onClick={onBack} className="mb-4 flex items-center gap-1 self-start text-sm text-muted hover:text-ink"><ChevronLeft className="size-4" /> Volver</button>
      {consumed ? (
        <div className="animate-pop flex flex-col items-center gap-3 py-10">
          <CheckCircle2 className="size-24 text-ok" />
          <h1 className="text-3xl font-extrabold text-ok">BEBIDA ENTREGADA</h1>
          <p className="text-muted">{row.event_day.name} · {fmtDateTime(row.consumed_at)}</p>
          <p className="text-sm text-faint">¡Disfrútala! Tu próximo beneficio estará disponible en su día.</p>
        </div>
      ) : (
        <>
          <p className="text-xs tracking-wide text-muted uppercase">{row.event_day.name}</p>
          <h1 className="text-xl font-bold">{fmtEventDate(row.event_day.date)}</h1>
          <p className="mb-5 text-sm text-muted">Válido de {hhmm(row.event_day.start_time)} a {hhmm(row.event_day.end_time)}</p>
          {token ? (
            <QrCode value={qrPayload(config.publicAppUrl, token)} size={300} label={`Código QR del beneficio del ${row.event_day.date}`} />
          ) : error ? (
            <ErrorBox error={error} />
          ) : (
            <Spinner label="Generando QR…" />
          )}
          <div className="mt-5 space-y-1">
            <p className="text-lg font-semibold">{attendeeName}</p>
            {effiId && <p className="font-mono text-sm text-muted">ID Effi {effiId}</p>}
          </div>
          {row.display_status === 'UPCOMING' && (
            <p className="mt-4 flex items-center gap-2 rounded-xl bg-warn/10 px-4 py-2 text-sm text-warn"><Clock className="size-4" /> Este QR solo funcionará el {fmtEventDate(row.event_day.date)}.</p>
          )}
          {offline && (
            <p className="mt-4 flex items-center gap-2 rounded-xl bg-info/10 px-4 py-2 text-sm text-info"><WifiOff className="size-4" /> Sin conexión: el QR sigue siendo válido; el operador lo valida en línea.</p>
          )}
          <p className="mt-6 max-w-xs text-xs text-faint">Sube el brillo de tu pantalla. No compartas capturas: el QR es de un solo uso y queda asociado a tu registro.</p>
        </>
      )}
    </section>
  )
}

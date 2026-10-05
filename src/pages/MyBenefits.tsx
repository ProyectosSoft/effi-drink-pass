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
/** Clave de localStorage donde se guarda el último token QR de cada beneficio. */
const cacheKey = (id: string) => `edp:qr:${id}`

/**
 * Lee el token cacheado de un beneficio para poder mostrar el QR sin conexión.
 * Se revalida con `extractToken` por si el valor guardado fue manipulado o es de un formato
 * antiguo; si localStorage no está disponible (modo privado, bloqueado) devuelve null.
 */
function readCachedToken(id: string): string | null {
  try {
    return extractToken(localStorage.getItem(cacheKey(id)))
  } catch {
    return null
  }
}

/**
 * /my-benefits — pantalla del asistente autenticado (vinculado por email).
 * Lista sus beneficios por día del evento (RPC `get_my_benefits`) y permite abrir el QR de
 * cada día disponible o próximo. La fecha "hoy" y el estado de cada beneficio los decide
 * el servidor (hora de Colombia), no el reloj del dispositivo.
 */
export default function MyBenefits() {
  const { signOut, isStaff } = useAuth()
  // benefit_id del QR abierto; null = vista de lista.
  const [selected, setSelected] = useState<string | null>(null)
  const q = useQuery({
    queryKey: ['my-benefits'],
    queryFn: () => rpc<MyBenefitsData>('get_my_benefits'),
    // Con un QR abierto se consulta más seguido para pasar a "BEBIDA ENTREGADA" poco
    // después de que el operador lo canjee en la barra.
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
      {/* Solo se muestra el error si no hay datos previos; con datos en caché se sigue mostrando la última versión. */}
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

      {/* `offline` = la última consulta falló: el QR (posiblemente cacheado) sigue sirviendo. */}
      {data?.attendee && current && (
        <QrView row={current} attendeeName={fullName(data.attendee)} effiId={data.attendee.effi_id} offline={q.isError} onBack={() => setSelected(null)} />
      )}
    </div>
  )
}

/**
 * Tarjeta de un día de beneficio con su estado. El QR solo se puede abrir si está disponible
 * hoy o es de un día futuro (para tenerlo cacheado de antemano); consumidos/vencidos no.
 */
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

/**
 * Vista a pantalla completa del QR de un beneficio.
 * Muestra primero el token cacheado (si existe) y en paralelo pide uno fresco con
 * `get_my_benefit_token`; si el servidor indica que ya no está disponible, se borra el caché.
 * Mantiene la pantalla encendida (Wake Lock) y cambia a "BEBIDA ENTREGADA" al consumirse.
 */
function QrView({ row, attendeeName, effiId, offline, onBack }: {
  row: Row; attendeeName: string; effiId: string | null; offline: boolean; onBack: () => void
}) {
  const qc = useQueryClient()
  // Seguro: el padre solo abre esta vista para filas con benefit_id.
  const benefitId = row.benefit_id!
  const [token, setToken] = useState<string | null>(() => readCachedToken(benefitId))
  const [error, setError] = useState<unknown>(null)
  const consumed = row.display_status === 'CONSUMED'

  // `alive` evita actualizar estado si el usuario sale de la vista antes de que responda la RPC.
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

  // Mantener la pantalla encendida mientras se muestra el QR. API opcional (no todos los
  // navegadores la soportan); los fallos se ignoran y el lock se libera al desmontar.
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }
    nav.wakeLock?.request('screen').then((l) => { lock = l }).catch(() => {})
    return () => { void lock?.release().catch(() => {}) }
  }, [])

  // Al detectar el canje, refrescar la lista para que el resto de días muestre el estado actualizado.
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

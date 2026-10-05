import { useQuery } from '@tanstack/react-query'
import { clsx } from 'clsx'
import {
  AlertTriangle, Ban, CalendarX, Camera, CheckCircle2, Clock, Flashlight, Keyboard, RefreshCcw, ScanLine, SwitchCamera,
  UserX, WifiOff, XCircle,
} from 'lucide-react'
import QrScanner from 'qr-scanner'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import { extractToken } from '@shared/qr.ts'
import { Button, Input } from '@/components/ui'
import { useAuth } from '@/lib/auth'
import { feedbackError, feedbackSuccess, feedbackWarning, unlockAudio } from '@/lib/feedback'
import { fmtEventDate, fmtTime, fullName } from '@/lib/format'
import { query, rpc, supabase, toAppError } from '@/lib/supabase'
import { PERMISSIONS as P, type ScanResult } from '@/lib/types'

/**
 * Modo de operación: 'auto' canjea en cuanto lee un QR válido; 'confirm' valida primero,
 * muestra los datos del asistente y espera a que el operador confirme la entrega.
 */
type Mode = 'auto' | 'confirm'
/**
 * Máquina de estados de la pantalla:
 * scanning → (working) → confirm | result | offline | error → scanning.
 * La cámara solo decodifica en 'scanning'; cualquier otra fase muestra un panel encima.
 */
type Phase =
  | { kind: 'scanning' }
  | { kind: 'working'; label: string }
  | { kind: 'confirm'; token: string; result: ScanResult }
  | { kind: 'result'; result: ScanResult }
  | { kind: 'offline'; retry: () => void }
  | { kind: 'error'; message: string }

/** Preferencia de modo por dispositivo (localStorage). */
const MODE_KEY = 'edp:scanner-mode'

/** Presentación de cada resultado del servidor. */
function present(code: ScanResult['code']): { title: string; tone: 'ok' | 'warn' | 'bad' | 'info'; icon: ReactNode } {
  switch (code) {
    case 'APPROVED': return { title: 'BENEFICIO APROBADO', tone: 'ok', icon: <CheckCircle2 className="size-20" /> }
    case 'VALID': return { title: 'QR VÁLIDO', tone: 'info', icon: <ScanLine className="size-20" /> }
    case 'ALREADY_CONSUMED': return { title: 'BENEFICIO YA CONSUMIDO', tone: 'warn', icon: <Ban className="size-20" /> }
    case 'NOT_TODAY': return { title: 'QR NO VÁLIDO PARA HOY', tone: 'bad', icon: <CalendarX className="size-20" /> }
    case 'NOT_STARTED': return { title: 'FUERA DE HORARIO', tone: 'bad', icon: <Clock className="size-20" /> }
    case 'NOT_ELIGIBLE': return { title: 'USUARIO NO ELEGIBLE', tone: 'bad', icon: <UserX className="size-20" /> }
    case 'ATTENDEE_INACTIVE': return { title: 'USUARIO INACTIVO', tone: 'bad', icon: <UserX className="size-20" /> }
    case 'EXPIRED': return { title: 'BENEFICIO EXPIRADO', tone: 'bad', icon: <Clock className="size-20" /> }
    case 'CANCELLED': return { title: 'BENEFICIO CANCELADO', tone: 'bad', icon: <Ban className="size-20" /> }
    case 'DAY_INACTIVE': return { title: 'DÍA NO HABILITADO', tone: 'bad', icon: <CalendarX className="size-20" /> }
    case 'RATE_LIMITED': return { title: 'DEMASIADOS INTENTOS', tone: 'warn', icon: <AlertTriangle className="size-20" /> }
    default: return { title: 'QR INVÁLIDO', tone: 'bad', icon: <XCircle className="size-20" /> }
  }
}

/** Fondo de pantalla completa por tono, para que el resultado se lea de un vistazo en la barra. */
const toneBg = {
  ok: 'bg-ok text-bg',
  info: 'bg-info text-bg',
  warn: 'bg-warn text-bg',
  bad: 'bg-bad text-white',
}

/**
 * Idempotency-Key nueva por cada intento de canje. Los reintentos del mismo intento
 * reutilizan la misma clave para que el servidor devuelva la respuesta original.
 */
function newKey() {
  return `scan-${crypto.randomUUID()}`
}

/**
 * /admin/scanner — escáner de QR para la barra. Requiere `benefitsValidate` o `benefitsRedeem`.
 * · Con solo `benefitsValidate` funciona en modo consulta: valida (`benefit_validate`) y
 *   muestra el resultado, pero no puede canjear ni usar el modo automático.
 * · Con `benefitsRedeem` canjea vía `benefit_redeem` con Idempotency-Key, en modo
 *   confirmación o automático.
 * · Sin conexión nunca da un consumo por confirmado: muestra un bloqueo con reintento seguro.
 * · Un token recibido por URL (?token=, desde /qr/:token) siempre pasa por confirmación,
 *   para que abrir un enlace no canjee un beneficio sin intervención del operador.
 * · Registra SCANNER_OPENED en auditoría y da feedback sonoro/háptico por resultado.
 */
export default function Scanner() {
  const { can, access } = useAuth()
  const [params, setParams] = useSearchParams()
  const canRedeem = can(P.benefitsRedeem)

  // Comparte la key 'app-settings' con Configuración: al guardar allí se invalida también aquí.
  const settings = useQuery({
    queryKey: ['app-settings'],
    queryFn: async () => {
      const { data } = await query<{ key: string; value: unknown }[]>(supabase.from('app_settings').select('key,value'))
      return Object.fromEntries(data.map((r) => [r.key, r.value])) as Record<string, unknown>
    },
    staleTime: 5 * 60_000,
  })
  // Segundos que el resultado queda en pantalla antes de volver a escanear.
  const autoReturn = Number(settings.data?.scanner_auto_return_seconds ?? 4)

  // Precedencia del modo: elección del operador en este dispositivo > valor por defecto
  // global (`scanner_default_mode`) > 'confirm'. `modeTouched` indica si hubo elección local.
  const [mode, setModeState] = useState<Mode>(() => {
    try { return (localStorage.getItem(MODE_KEY) as Mode) || 'confirm' } catch { return 'confirm' }
  })
  const [modeTouched, setModeTouched] = useState(() => {
    try { return Boolean(localStorage.getItem(MODE_KEY)) } catch { return false }
  })
  useEffect(() => {
    const def = settings.data?.scanner_default_mode
    if (!modeTouched && (def === 'auto' || def === 'confirm')) setModeState(def)
  }, [settings.data, modeTouched])
  const setMode = (m: Mode) => {
    setModeState(m)
    setModeTouched(true)
    try { localStorage.setItem(MODE_KEY, m) } catch { /* ignorar */ }
  }
  // Sin permiso de canje el modo automático no aplica, aunque esté guardado.
  const effectiveMode: Mode = canRedeem ? mode : 'confirm'

  const [phase, setPhase] = useState<Phase>({ kind: 'scanning' })
  // Ref con la fase actual para el callback de la cámara, que se crea una sola vez y
  // de otro modo leería un valor obsoleto.
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const [online, setOnline] = useState(navigator.onLine)
  // Contador local de bebidas entregadas en esta sesión de pantalla (no persiste).
  const [served, setServed] = useState(0)
  const [manual, setManual] = useState('')
  const [showManual, setShowManual] = useState(false)

  // Seguimiento del estado de red (con cleanup de listeners) y registro de apertura del
  // scanner en auditoría (best-effort: un fallo no bloquea la pantalla).
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    void rpc('log_client_event', { p_action: 'SCANNER_OPENED', p_metadata: { ua: navigator.userAgent.slice(0, 120) } }).catch(() => {})
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])

  /** Muestra el resultado con su feedback (éxito, advertencia o error) y cuenta las entregas. */
  const showResult = useCallback((r: ScanResult) => {
    if (r.code === 'APPROVED') { feedbackSuccess(); setServed((n) => n + 1) }
    else if (r.code === 'VALID') feedbackSuccess()
    else if (r.code === 'ALREADY_CONSUMED' || r.code === 'RATE_LIMITED') feedbackWarning()
    else feedbackError()
    setPhase({ kind: 'result', result: r })
  }, [])

  // Consumo con Idempotency-Key: un reintento tras un corte de red nunca duplica el consumo.
  // El `retry` de la fase offline reutiliza la misma `key` a propósito.
  const redeem = useCallback(async (token: string, key: string) => {
    if (!navigator.onLine) {
      feedbackError()
      setPhase({ kind: 'offline', retry: () => void redeem(token, key) })
      return
    }
    setPhase({ kind: 'working', label: 'Registrando consumo…' })
    try {
      const r = await rpc<ScanResult>('benefit_redeem', {
        p_token: token, p_idempotency_key: key, p_metadata: { source: 'scanner', mode: effectiveMode },
      })
      showResult(r)
    } catch (e) {
      const err = toAppError(e)
      // Error de red: el canje pudo o no aplicarse en el servidor; reintentar con la misma
      // clave es seguro. Cualquier otro error se muestra tal cual.
      if (err.network) {
        feedbackError()
        setPhase({ kind: 'offline', retry: () => void redeem(token, key) })
      } else {
        feedbackError()
        setPhase({ kind: 'error', message: err.message })
      }
    }
  }, [effectiveMode, showResult])

  /**
   * Procesa una lectura (cámara, ingreso manual o URL). Acepta el token solo o la URL
   * completa del QR. `forceConfirm` obliga a validar y pedir confirmación aunque el
   * modo sea automático.
   */
  const process = useCallback(async (raw: string, forceConfirm = false) => {
    const token = extractToken(raw)
    // Formato inválido: se rechaza localmente sin consultar al servidor.
    if (!token) {
      feedbackError()
      setPhase({ kind: 'result', result: { ok: false, code: 'INVALID_QR', message: 'QR INVÁLIDO', server_time: new Date().toISOString(), benefit: null, attendee: null, consumption: null } })
      return
    }
    if (!navigator.onLine) {
      feedbackError()
      setPhase({ kind: 'offline', retry: () => void process(raw, forceConfirm) })
      return
    }
    if (effectiveMode === 'auto' && !forceConfirm) {
      await redeem(token, newKey())
      return
    }
    setPhase({ kind: 'working', label: 'Validando…' })
    try {
      const r = await rpc<ScanResult>('benefit_validate', { p_token: token })
      // Solo se ofrece "Confirmar entrega" si el QR es válido y el operador puede canjear;
      // en otro caso se muestra el resultado de la validación.
      if (r.code === 'VALID' && canRedeem) {
        feedbackSuccess()
        setPhase({ kind: 'confirm', token, result: r })
      } else {
        showResult(r)
      }
    } catch (e) {
      const err = toAppError(e)
      feedbackError()
      setPhase(err.network ? { kind: 'offline', retry: () => void process(raw, forceConfirm) } : { kind: 'error', message: err.message })
    }
  }, [effectiveMode, canRedeem, redeem, showResult])

  // Token recibido desde /qr/:token (cámara nativa): siempre en modo confirmación.
  // Se quita de la URL antes de procesarlo para que recargar o volver atrás no lo reenvíe.
  useEffect(() => {
    const t = params.get('token')
    if (t) {
      setParams({}, { replace: true })
      void process(t, true)
    }
  }, [params, setParams, process])

  const backToScan = useCallback(() => setPhase({ kind: 'scanning' }), [])

  // Retorno automático tras un resultado; los rechazos quedan 3 s más para que el operador
  // alcance a leerlos. El cleanup cancela el timer si se vuelve antes manualmente.
  useEffect(() => {
    if (phase.kind !== 'result') return
    const secs = phase.result.ok ? autoReturn : autoReturn + 3
    const t = setTimeout(backToScan, secs * 1000)
    return () => clearTimeout(t)
  }, [phase, autoReturn, backToScan])

  const operator = fullName(access?.profile)

  return (
    <div className="mx-auto flex min-h-[calc(100dvh-57px)] max-w-2xl flex-col lg:min-h-[calc(100dvh-2rem)]">
      {/* Barra superior */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
        <div className="grid grid-cols-2 gap-1 rounded-xl bg-surface-2 p-1 text-xs font-semibold" role="radiogroup" aria-label="Modo del scanner">
          {(['confirm', 'auto'] as const).map((m) => (
            <button key={m} role="radio" aria-checked={effectiveMode === m} disabled={!canRedeem && m === 'auto'}
              // unlockAudio en un gesto del usuario: iOS/Safari bloquea el audio hasta entonces.
              onClick={() => { unlockAudio(); setMode(m) }}
              className={clsx('rounded-lg px-3 py-2 transition disabled:opacity-40', effectiveMode === m ? 'brand-gradient text-white' : 'text-muted')}>
              {m === 'confirm' ? 'Confirmación' : 'Automático'}
            </button>
          ))}
        </div>
        <div className="text-right text-xs text-muted">
          <p className="font-semibold text-ink">{operator}</p>
          <p>Entregadas en esta sesión: <span className="font-bold text-brand tabular-nums">{served}</span></p>
        </div>
      </div>

      {!online && (
        <div role="alert" className="mx-4 mb-2 flex items-center gap-2 rounded-xl bg-bad px-4 py-3 text-sm font-bold text-white">
          <WifiOff className="size-5 shrink-0" /> SIN CONEXIÓN — NO ES POSIBLE CONFIRMAR EL CONSUMO
        </div>
      )}

      <div className="relative flex-1 px-4">
        {/* La cámara se pausa fuera de 'scanning' o sin red; el guard con phaseRef descarta lecturas tardías. */}
        <CameraView active={phase.kind === 'scanning' && online} onDecode={(data) => { if (phaseRef.current.kind === 'scanning') void process(data) }} />

        {phase.kind !== 'scanning' && (
          <div className="absolute inset-0 z-10 mx-4 flex flex-col overflow-hidden rounded-3xl" aria-live="assertive">
            {phase.kind === 'working' && (
              <div className="flex flex-1 flex-col items-center justify-center gap-4 bg-surface">
                <RefreshCcw className="size-12 animate-spin text-brand" />
                <p className="text-lg font-semibold">{phase.label}</p>
              </div>
            )}

            {phase.kind === 'offline' && (
              <div className="flex flex-1 flex-col items-center justify-center gap-5 bg-bad p-6 text-center text-white">
                <WifiOff className="size-20" />
                <p className="text-2xl font-extrabold">SIN CONEXIÓN — NO ES POSIBLE CONFIRMAR EL CONSUMO</p>
                <p className="text-sm opacity-90">No entregue la bebida. Reintentar es seguro: el mismo intento nunca se registra dos veces.</p>
                <div className="flex flex-wrap justify-center gap-2">
                  <Button variant="secondary" size="lg" onClick={phase.retry}>Reintentar</Button>
                  <Button variant="ghost" size="lg" className="text-white" onClick={backToScan}>Cancelar</Button>
                </div>
              </div>
            )}

            {phase.kind === 'error' && (
              <div className="flex flex-1 flex-col items-center justify-center gap-4 bg-surface p-6 text-center">
                <AlertTriangle className="size-16 text-bad" />
                <p className="text-lg font-semibold">{phase.message}</p>
                <Button size="lg" onClick={backToScan}>Volver al scanner</Button>
              </div>
            )}

            {phase.kind === 'confirm' && (
              <ResultPanel result={phase.result} operator={operator}>
                <div className="grid grid-cols-2 gap-3">
                  <Button variant="secondary" size="xl" onClick={backToScan}>Cancelar</Button>
                  {/* Cada confirmación es un intento nuevo, con su propia Idempotency-Key. */}
                  <Button variant="success" size="xl" onClick={() => { unlockAudio(); void redeem(phase.token, newKey()) }}>Confirmar entrega</Button>
                </div>
              </ResultPanel>
            )}

            {phase.kind === 'result' && (
              <ResultPanel result={phase.result} operator={operator} onTap={backToScan} countdown={phase.result.ok ? autoReturn : autoReturn + 3}>
                <Button variant="secondary" size="xl" className="w-full" onClick={backToScan}>Escanear siguiente</Button>
              </ResultPanel>
            )}
          </div>
        )}
      </div>

      <div className="px-4 py-4">
        {showManual ? (
          // Ingreso manual (pegar código o URL) como alternativa si la cámara no funciona.
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); unlockAudio(); const v = manual; setManual(''); void process(v) }}>
            <Input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="Pegar código o URL del QR" autoFocus aria-label="Código manual" />
            <Button type="submit" disabled={!manual.trim() || phase.kind !== 'scanning'}>Validar</Button>
          </form>
        ) : (
          <button className="flex w-full items-center justify-center gap-2 text-sm text-muted hover:text-ink" onClick={() => setShowManual(true)}>
            <Keyboard className="size-4" /> Ingresar código manualmente
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * Panel a pantalla completa con el resultado (o la confirmación pendiente): título y color
 * según el código, datos del asistente/beneficio/consumo y las acciones en `children`.
 * Con `onTap`, tocar el panel vuelve al scanner; `countdown` dibuja la barra de retorno.
 */
function ResultPanel({ result, operator, children, onTap, countdown }: {
  result: ScanResult; operator: string; children: ReactNode; onTap?: () => void; countdown?: number
}) {
  const p = present(result.code)
  const a = result.attendee
  const b = result.benefit
  const c = result.consumption
  return (
    <div className={clsx('animate-pop flex flex-1 flex-col', toneBg[p.tone])}>
      <button type="button" onClick={onTap} disabled={!onTap} className="flex flex-1 flex-col items-center justify-center gap-3 p-5 text-center">
        {p.icon}
        <p className="text-3xl leading-tight font-extrabold tracking-tight sm:text-4xl">{p.title}</p>
        {result.code === 'APPROVED' && <p className="text-lg font-bold opacity-90">BEBIDA ENTREGADA</p>}
        {/* Reintento con la misma Idempotency-Key: el servidor devolvió el resultado original sin volver a canjear. */}
        {result.idempotent_replay && <p className="text-xs opacity-80">(respuesta confirmada de un intento anterior)</p>}
      </button>
      {(a || b) && (
        <dl className="mx-4 mb-4 grid grid-cols-2 gap-x-4 gap-y-2 rounded-2xl bg-black/20 p-4 text-left text-sm">
          {a && <div className="col-span-2"><dt className="text-xs opacity-75">Usuario</dt><dd className="text-lg font-bold">{fullName(a)}</dd></div>}
          {a && <div><dt className="text-xs opacity-75">ID Effi</dt><dd className="font-mono font-semibold">{a.effi_id ?? '—'}</dd></div>}
          {a && <div><dt className="text-xs opacity-75">Acceso</dt><dd className="font-semibold">{a.tipo_acceso}</dd></div>}
          {b && <div><dt className="text-xs opacity-75">Día del beneficio</dt><dd className="font-semibold">{fmtEventDate(b.event_day.date)}</dd></div>}
          <div><dt className="text-xs opacity-75">Hora</dt><dd className="font-semibold tabular-nums">{fmtTime(c?.consumed_at ?? result.server_time)}</dd></div>
          {c && <div className="col-span-2"><dt className="text-xs opacity-75">{result.code === 'APPROVED' ? 'Operador' : 'Consumido por'}</dt><dd className="font-semibold">{c.operator ?? operator}{c.is_override ? ' (excepción)' : ''}</dd></div>}
        </dl>
      )}
      <div className="p-4 pt-0">{children}</div>
      {countdown && (
        <div className="h-1.5 bg-black/20">
          <div className="h-full bg-white/70" style={{ animation: `shrink ${countdown}s linear forwards` }} />
          <style>{'@keyframes shrink { from { width: 100% } to { width: 0% } }'}</style>
        </div>
      )}
    </div>
  )
}

/** Cámara con qr-scanner (BarcodeDetector nativo cuando existe; worker como alternativa). Compatible iOS/Android. */
function CameraView({ active, onDecode }: { active: boolean; onDecode: (data: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const scannerRef = useRef<QrScanner | null>(null)
  // Ref al callback más reciente: el scanner se crea una sola vez y llamaría a uno obsoleto.
  const onDecodeRef = useRef(onDecode)
  onDecodeRef.current = onDecode
  // Última lectura, para descartar repeticiones del mismo QR.
  const last = useRef<{ data: string; at: number }>({ data: '', at: 0 })
  const [error, setError] = useState<string | null>(null)
  const [hasFlash, setHasFlash] = useState(false)
  const [flashOn, setFlashOn] = useState(false)
  const [cameras, setCameras] = useState<QrScanner.Camera[]>([])
  const [camIndex, setCamIndex] = useState(0)

  // Crea la instancia de qr-scanner al montar y la destruye al desmontar (libera la cámara).
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const scanner = new QrScanner(video, (res) => {
      const now = Date.now()
      // Ignorar la misma lectura durante 3 s (el QR sigue frente a la cámara).
      if (res.data === last.current.data && now - last.current.at < 3000) return
      last.current = { data: res.data, at: now }
      onDecodeRef.current(res.data)
    }, { preferredCamera: 'environment', highlightScanRegion: true, highlightCodeOutline: true, maxScansPerSecond: 8, returnDetailedScanResult: true })
    scannerRef.current = scanner
    return () => {
      scanner.destroy()
      scannerRef.current = null
    }
  }, [])

  // Inicia o pausa la cámara según `active`. Tras el primer arranque (ya con permiso)
  // detecta linterna y lista las cámaras disponibles; los errores se traducen a mensajes útiles.
  useEffect(() => {
    const scanner = scannerRef.current
    if (!scanner) return
    if (active) {
      scanner.start()
        .then(async () => {
          setError(null)
          setHasFlash(await scanner.hasFlash().catch(() => false))
          if (cameras.length === 0) setCameras(await QrScanner.listCameras(true).catch(() => []))
        })
        .catch((e: unknown) => {
          const msg = String(e)
          setError(/NotAllowed|Permission|denied/i.test(msg)
            ? 'Permiso de cámara denegado. Habilítelo en la configuración del navegador y recargue.'
            : /NotFound|no camera/i.test(msg) ? 'No se encontró una cámara. Use el ingreso manual.'
            : 'No se pudo iniciar la cámara. Se requiere HTTPS y un navegador compatible.')
        })
    } else {
      scanner.pause()
    }
  }, [active, cameras.length])

  /** Rota entre las cámaras disponibles; la linterna se reevalúa porque depende de la cámara. */
  const switchCamera = async () => {
    if (!scannerRef.current || cameras.length < 2) return
    const next = (camIndex + 1) % cameras.length
    setCamIndex(next)
    await scannerRef.current.setCamera(cameras[next].id)
    setHasFlash(await scannerRef.current.hasFlash().catch(() => false))
    setFlashOn(false)
  }

  return (
    <div className="relative mx-auto aspect-[3/4] w-full max-w-md overflow-hidden rounded-3xl border border-line bg-black sm:aspect-square">
      <video ref={videoRef} className="size-full object-cover" muted playsInline />
      {error ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-sm">
          <Camera className="size-10 text-faint" />
          <p>{error}</p>
        </div>
      ) : (
        <p className="absolute inset-x-0 bottom-4 text-center text-sm font-medium text-white/90 drop-shadow">Apunte al QR del asistente</p>
      )}
      <div className="absolute top-3 right-3 flex gap-2">
        {hasFlash && (
          <button aria-label="Linterna" aria-pressed={flashOn} onClick={async () => { await scannerRef.current?.toggleFlash(); setFlashOn(scannerRef.current?.isFlashOn() ?? false) }}
            className={clsx('rounded-full p-3 backdrop-blur', flashOn ? 'bg-accent text-bg' : 'bg-black/50 text-white')}>
            <Flashlight className="size-5" />
          </button>
        )}
        {cameras.length > 1 && (
          <button aria-label="Cambiar cámara" onClick={switchCamera} className="rounded-full bg-black/50 p-3 text-white backdrop-blur">
            <SwitchCamera className="size-5" />
          </button>
        )}
      </div>
    </div>
  )
}

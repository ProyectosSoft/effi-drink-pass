import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { PublicShell } from '@/components/layout'
import { QrCode } from '@/components/QrCode'
import { Button, ErrorBox, Field, Input } from '@/components/ui'
import { config } from '@/lib/config'
import { fmtEventDate, hhmm } from '@/lib/format'
import { rpc } from '@/lib/supabase'
import { qrPayload } from '@shared/qr.ts'

type Lookup = {
  available: boolean
  code: string
  retry_after?: number
  token?: string
  event_day?: { name: string; date: string; start_time: string; end_time: string }
}

const messages: Record<string, string> = {
  ALREADY_CONSUMED: 'El beneficio de hoy ya fue reclamado.',
  CANCELLED: 'El beneficio no está disponible. Acércate al punto de información.',
  ATTENDEE_INACTIVE: 'El beneficio no está disponible. Acércate al punto de información.',
  NOT_ELIGIBLE: 'No tienes un beneficio habilitado para hoy.',
  DAY_INACTIVE: 'El día de hoy no está habilitado para reclamar bebidas.',
  NOT_STARTED: 'Aún no ha comenzado el horario para reclamar tu bebida.',
  EXPIRED: 'El horario para reclamar la bebida de hoy ya terminó.',
  RATE_LIMITED: 'Hay demasiadas consultas. Espera un momento y vuelve a intentarlo.',
}

/** Entrada del QR general: consulta pública, independiente del login del staff. */
export default function Claim() {
  const [kind, setKind] = useState<'email' | 'effi_id'>('email')
  const [identifier, setIdentifier] = useState('')
  const [result, setResult] = useState<Lookup | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const lookup = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setResult(null)
    setError(null)
    try {
      setResult(await rpc<Lookup>('lookup_drink_benefit', { p_kind: kind, p_identifier: identifier.trim() }))
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const reset = () => { setResult(null); setIdentifier(''); setError(null) }

  return (
    <PublicShell>
      <section className="card glow mx-auto mt-6 max-w-md p-6 sm:mt-14 sm:p-8">
        <h1 className="text-2xl font-bold">Reclama tu bebida</h1>
        <p className="mt-2 text-sm text-muted">Consulta el beneficio de hoy con el correo o ID Effi de tu inscripción.</p>

        {result?.available && result.token && result.event_day ? (
          <div className="mt-6 flex flex-col items-center gap-4 text-center" aria-live="polite">
            <p className="font-semibold text-ok">Tienes un beneficio disponible</p>
            <p className="text-sm">{result.event_day.name} · {fmtEventDate(result.event_day.date)}</p>
            <QrCode value={qrPayload(config.publicAppUrl, result.token)} size={300} label="QR personal para reclamar la bebida de hoy" />
            <p className="font-semibold">Muestra este QR al personal de la barra.</p>
            <p className="text-xs text-muted">Horario: {hhmm(result.event_day.start_time)}–{hhmm(result.event_day.end_time)}. El personal confirma la entrega. Mostrar este código no consume tu beneficio.</p>
            <p className="text-xs text-faint">No compartas este QR. Solo se puede reclamar una vez.</p>
            <Button variant="secondary" onClick={reset}>Finalizar consulta</Button>
          </div>
        ) : (
          <form onSubmit={lookup} className="mt-6 space-y-4">
            <fieldset disabled={busy} className="space-y-4">
              <legend className="mb-2 text-sm font-semibold">Consultar por</legend>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <label className="flex items-center gap-2"><input type="radio" name="identifier-kind" checked={kind === 'email'} onChange={() => { setKind('email'); reset() }} />Correo</label>
                <label className="flex items-center gap-2"><input type="radio" name="identifier-kind" checked={kind === 'effi_id'} onChange={() => { setKind('effi_id'); reset() }} />ID Effi</label>
              </div>
              <Field label={kind === 'email' ? 'Correo registrado' : 'ID Effi registrado'}>
                <Input type={kind === 'email' ? 'email' : 'text'} autoComplete={kind === 'email' ? 'email' : 'off'}
                  maxLength={kind === 'email' ? 254 : 64} required value={identifier}
                  onChange={(e) => { setIdentifier(e.target.value); setResult(null); setError(null) }} placeholder={kind === 'email' ? 'tu@email.com' : 'Tu ID Effi'} />
              </Field>
            </fieldset>
            <Button type="submit" className="w-full" size="lg" loading={busy} disabled={!identifier.trim()}>Consultar beneficio</Button>
            {result && <p role="status" className="rounded-xl border border-line bg-surface-2 p-4 text-sm">
              {messages[result.code] ?? 'No encontramos un beneficio disponible para hoy con ese dato. Revisa tu inscripción o acércate al punto de información.'}
            </p>}
            <ErrorBox error={error} />
            <p className="text-xs text-faint">No necesitas contraseña ni código por correo. Usa únicamente tus propios datos.</p>
          </form>
        )}
        <Link to="/login?staff=1" className="mt-6 block text-center text-xs text-muted underline">Acceso del personal</Link>
      </section>
    </PublicShell>
  )
}

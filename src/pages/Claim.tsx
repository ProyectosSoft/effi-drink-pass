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
  company?: { name: string; effi_id: string; quota: number; delivered: number; remaining: number }
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
  AMBIGUOUS_COMPANY: 'Hay varias empresas con ese dato. Consulta por identificación o ID Effi.',
  COMPANY_INACTIVE: 'La empresa está inactiva. Acércate al punto de información.',
  QUOTA_EXHAUSTED: 'La empresa ya reclamó todas sus bebidas de hoy.',
}

/** Entrada del QR general: consulta pública, independiente del login del staff. */
export default function Claim() {
  const [kind, setKind] = useState<'name' | 'identification' | 'effi_id'>('name')
  const [identifier, setIdentifier] = useState('')
  const [result, setResult] = useState<Lookup | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const lookup = async (e?: FormEvent) => {
    e?.preventDefault()
    if (busy) return
    setBusy(true)
    setResult(null)
    setError(null)
    try {
      setResult(await rpc<Lookup>('lookup_company_drink_pass', { p_kind: kind, p_identifier: identifier.trim() }))
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
        <h1 className="text-2xl font-bold">Bebidas de tu empresa</h1>
        <p className="mt-2 text-sm text-muted">Consulta el cupo de hoy con el nombre fiscal, identificación o ID Effi de tu empresa.</p>

        {result?.available && result.token && result.event_day ? (
          <div className="mt-6 flex flex-col items-center gap-4 text-center" aria-live="polite">
            <p className="font-semibold text-ok">{result.company?.name}</p>
            {result.company && <dl className="grid w-full grid-cols-3 gap-2 rounded-xl bg-surface-2 p-3 text-sm">
              <div><dt>Cupo diario</dt><dd className="text-xl font-bold">{result.company.quota}</dd></div>
              <div><dt>Entregadas</dt><dd className="text-xl font-bold">{result.company.delivered}</dd></div>
              <div><dt>Disponibles</dt><dd className="text-xl font-bold text-ok">{result.company.remaining}</dd></div>
            </dl>}
            <p className="text-sm">{result.event_day.name} · {fmtEventDate(result.event_day.date)}</p>
            <QrCode value={qrPayload(config.publicAppUrl, result.token)} size={300} label="QR de la empresa para reclamar bebidas de hoy" />
            <p className="font-semibold">Muestra este QR al personal de la barra.</p>
            <p className="text-xs text-muted">Horario: {hhmm(result.event_day.start_time)}–{hhmm(result.event_day.end_time)}. El operador indica cuántas bebidas entrega y el sistema las descuenta del saldo de hoy.</p>
            <p className="text-xs text-faint">Puedes hacer entregas parciales hasta agotar el cupo. El saldo se vuelve a comprobar en la barra. No compartas este QR fuera de tu empresa.</p>
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="secondary" onClick={() => void lookup()}>Actualizar saldo</Button>
              <Button variant="ghost" onClick={reset}>Finalizar consulta</Button>
            </div>
          </div>
        ) : (
          <form onSubmit={lookup} className="mt-6 space-y-4">
            <fieldset disabled={busy} className="space-y-4">
              <legend className="mb-2 text-sm font-semibold">Consultar por</legend>
              <div className="flex flex-wrap gap-3 text-sm">
                {([['name', 'Nombre fiscal'], ['identification', 'Identificación'], ['effi_id', 'ID Effi']] as const).map(([value, label]) => (
                  <label key={value} className="flex items-center gap-2"><input type="radio" name="identifier-kind" checked={kind === value} onChange={() => { setKind(value); reset() }} />{label}</label>
                ))}
              </div>
              <Field label={kind === 'name' ? 'Nombre fiscal' : kind === 'identification' ? 'Identificación' : 'ID Effi'}>
                <Input type="text" autoComplete="off" maxLength={kind === 'name' ? 200 : 64} required value={identifier}
                  onChange={(e) => { setIdentifier(e.target.value); setResult(null); setError(null) }} placeholder={kind === 'name' ? 'Nombre fiscal completo de la empresa' : kind === 'identification' ? 'Ej. 901173460-5' : 'Tu ID Effi'} />
              </Field>
            </fieldset>
            <Button type="submit" className="w-full" size="lg" loading={busy} disabled={!identifier.trim()}>Consultar beneficio</Button>
            {result && <p role="status" className="rounded-xl border border-line bg-surface-2 p-4 text-sm">
              {messages[result.code] ?? 'No encontramos un cupo habilitado para hoy con ese dato. Revisa el registro de la empresa o acércate al punto de información.'}
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

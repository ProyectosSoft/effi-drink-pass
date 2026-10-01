import { KeyRound, Mail } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { Navigate, useSearchParams } from 'react-router'
import { PublicShell } from '@/components/layout'
import { Button, ErrorBox, Field, Input } from '@/components/ui'
import { useAuth } from '@/lib/auth'
import { config } from '@/lib/config'
import { supabase, toAppError } from '@/lib/supabase'

type Mode = 'otp' | 'password'

function safeNext(next: string | null): string {
  // Solo rutas internas (evita open redirect).
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard'
}

export function Login() {
  const { session, loading } = useAuth()
  const [params] = useSearchParams()
  const next = safeNext(params.get('next'))
  const [mode, setMode] = useState<Mode>(params.get('staff') ? 'password' : 'otp')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState(false)
  const [cooldown, setCooldown] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    if (cooldown <= 0) return
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000)
    return () => clearTimeout(t)
  }, [cooldown])

  if (!loading && session) return <Navigate to={next} replace />

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(toAppError(e))
    } finally {
      setBusy(false)
    }
  }

  const sendCode = (e?: FormEvent) => {
    e?.preventDefault()
    void run(async () => {
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim().toLowerCase(),
        options: { shouldCreateUser: true, emailRedirectTo: `${config.publicAppUrl}/login?next=${encodeURIComponent(next)}` },
      })
      if (error) throw error
      setSent(true)
      setCooldown(60)
    })
  }

  const verify = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      const { error } = await supabase.auth.verifyOtp({ email: email.trim().toLowerCase(), token: code.trim(), type: 'email' })
      if (error) throw new Error('Código inválido o expirado. Solicita uno nuevo.')
    })
  }

  const passwordLogin = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password })
      if (error) throw new Error('Email o contraseña incorrectos.')
    })
  }

  return (
    <PublicShell>
      <div className="mx-auto mt-6 max-w-md sm:mt-14">
        <div className="card glow p-6 sm:p-8">
          <h1 className="text-2xl font-bold">Ingresar</h1>
          <p className="mt-1 text-sm text-muted">Cuenta propia de Effi Drink Pass. No se usa el login de Effi.</p>

          <div className="mt-6 grid grid-cols-2 gap-1 rounded-xl bg-surface-2 p-1 text-sm" role="tablist">
            {([['otp', 'Código por email', <Mail key="m" className="size-4" />], ['password', 'Contraseña (staff)', <KeyRound key="k" className="size-4" />]] as const).map(([m, label, icon]) => (
              <button key={m} role="tab" aria-selected={mode === m} onClick={() => { setMode(m); setError(null) }}
                className={`flex items-center justify-center gap-2 rounded-lg px-3 py-2 transition ${mode === m ? 'bg-surface font-semibold text-ink shadow' : 'text-muted'}`}>
                {icon} {label}
              </button>
            ))}
          </div>

          {mode === 'otp' ? (
            !sent ? (
              <form onSubmit={sendCode} className="mt-6 space-y-4">
                <Field label="Email registrado">
                  <Input type="email" autoComplete="email" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="tu@email.com" />
                </Field>
                <Button type="submit" className="w-full" size="lg" loading={busy}>Enviarme un código</Button>
                <p className="text-xs text-faint">Te enviaremos un código de 6 dígitos (y un enlace) al email con el que te registraron en la feria.</p>
              </form>
            ) : (
              <form onSubmit={verify} className="mt-6 space-y-4">
                <p className="text-sm text-muted">Enviamos un código a <strong className="text-ink">{email}</strong>. También puedes abrir el enlace del correo en este dispositivo.</p>
                <Field label="Código">
                  <Input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6,10}" maxLength={10} required value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} className="text-center text-2xl tracking-[0.5em]" autoFocus />
                </Field>
                <Button type="submit" className="w-full" size="lg" loading={busy}>Verificar</Button>
                <div className="flex justify-between text-sm">
                  <button type="button" className="text-muted hover:text-ink" onClick={() => { setSent(false); setCode('') }}>Cambiar email</button>
                  <button type="button" disabled={cooldown > 0 || busy} className="text-brand disabled:text-faint" onClick={() => sendCode()}>
                    {cooldown > 0 ? `Reenviar en ${cooldown}s` : 'Reenviar código'}
                  </button>
                </div>
              </form>
            )
          ) : (
            <form onSubmit={passwordLogin} className="mt-6 space-y-4">
              <Field label="Email">
                <Input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
              </Field>
              <Field label="Contraseña">
                <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
              </Field>
              <Button type="submit" className="w-full" size="lg" loading={busy}>Ingresar</Button>
              <p className="text-xs text-faint">¿Primera vez o sin contraseña? Usa “Código por email” y luego define tu contraseña en “Mi cuenta”.</p>
            </form>
          )}
          <div className="mt-4"><ErrorBox error={error} /></div>
        </div>
      </div>
    </PublicShell>
  )
}

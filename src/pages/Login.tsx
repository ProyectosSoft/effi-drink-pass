import { useState, type FormEvent } from 'react'
import { Navigate, useSearchParams } from 'react-router'
import { PublicShell } from '@/components/layout'
import { Button, ErrorBox, Field, Input } from '@/components/ui'
import { useAuth } from '@/lib/auth'
import { supabase, toAppError } from '@/lib/supabase'

function safeNext(next: string | null): string {
  return next && /^\/(?![/\\])/.test(next) && !/[\\\u0000-\u001f\u007f]/.test(next) ? next : '/dashboard'
}

/** Acceso por contraseña, sin envíos de correo. */
export function Login() {
  const { session, loading } = useAuth()
  const [params] = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  if (!loading && session) return <Navigate to={session.user.app_metadata.must_change_password ? '/account' : safeNext(params.get('next'))} replace />
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password })
      if (error) throw new Error('Email o contraseña incorrectos. Si aún no tienes contraseña, solicita una temporal al organizador.')
    } catch (err) { setError(toAppError(err)) }
    finally { setBusy(false) }
  }
  return <PublicShell><div className="card glow mx-auto mt-6 max-w-md p-6 sm:mt-14 sm:p-8">
    <h1 className="text-2xl font-bold">Ingresar con contraseña</h1>
    <p className="mt-2 text-sm text-muted">Cuenta de Effi Drink Pass.</p>
    <form onSubmit={submit} className="mt-6 space-y-4">
      <Field label="Email registrado"><Input type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} /></Field>
      <Field label="Contraseña"><Input type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></Field>
      <Button type="submit" className="w-full" size="lg" loading={busy}>Ingresar</Button>
      <ErrorBox error={error} />
      <p className="text-sm text-muted">¿Primera vez, sin contraseña o la olvidaste? Solicita una contraseña temporal al organizador. Al ingresar podrás crear tu propia contraseña.</p>
    </form>
  </div></PublicShell>
}

import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { Button, Card, ErrorBox, Field, Input, useToast } from '@/components/ui'
import { useAuth } from '@/lib/auth'
import { supabase, toAppError } from '@/lib/supabase'

/**
 * /account — "Mi cuenta". Accesible para cualquier usuario autenticado (asistente o staff).
 * Muestra email, roles y si la cuenta está vinculada a un asistente, y permite definir o
 * cambiar la contraseña vía `supabase.auth.updateUser` (útil para quien entró por magic link).
 */
export default function Account() {
  const { session, access, signOut } = useAuth()
  const toast = useToast()
  const navigate = useNavigate()
  const temporary = session?.user.app_metadata.must_change_password === true
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    // Validación local previa para dar feedback inmediato; Supabase aplica además su propia política.
    if (pw.length < 10 || pw.length > 72) return setError(new Error('La contraseña debe tener entre 10 y 72 caracteres.'))
    if (pw !== pw2) return setError(new Error('Las contraseñas no coinciden.'))
    setBusy(true)
    try {
      if (temporary) {
        const { data, error } = await supabase.functions.invoke('password-access', { body: { action: 'complete', password: pw } })
        if (error || data?.error) throw new Error(data?.error ?? 'No se pudo guardar la contraseña.')
        const { error: refreshError } = await supabase.auth.refreshSession()
        if (refreshError) throw refreshError
      } else {
        const { error } = await supabase.auth.updateUser({ password: pw })
        if (error) throw error
      }
      setPw('')
      setPw2('')
      toast('Contraseña actualizada')
      if (temporary) navigate('/dashboard', { replace: true })
    } catch (err) {
      setError(toAppError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto mt-6 max-w-lg space-y-4">
      {temporary && <p role="status" className="card p-4">Crea tu contraseña personal para continuar. Usa entre 10 y 72 caracteres.</p>}
      <Card title="Mi cuenta">
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between gap-4"><dt className="text-muted">Email</dt><dd>{session?.user.email}</dd></div>
          <div className="flex justify-between gap-4"><dt className="text-muted">Roles</dt><dd>{access?.roles.join(', ') || '—'}</dd></div>
          <div className="flex justify-between gap-4"><dt className="text-muted">Asistente vinculado</dt><dd>{access?.attendee ? 'Sí' : 'No'}</dd></div>
        </dl>
      </Card>
      <Card title="Definir o cambiar contraseña">
        <form onSubmit={submit} className="space-y-4">
          <Field label="Nueva contraseña" hint="Mínimo 10 caracteres">
            <Input type="password" autoComplete="new-password" required minLength={10} maxLength={72} value={pw} onChange={(e) => setPw(e.target.value)} />
          </Field>
          <Field label="Repetir contraseña">
            <Input type="password" autoComplete="new-password" required minLength={10} maxLength={72} value={pw2} onChange={(e) => setPw2(e.target.value)} />
          </Field>
          <ErrorBox error={error} />
          <div className="flex justify-between">
            <Button type="button" variant="ghost" onClick={signOut}>Cerrar sesión</Button>
            <Button type="submit" loading={busy}>Guardar</Button>
          </div>
        </form>
      </Card>
    </div>
  )
}

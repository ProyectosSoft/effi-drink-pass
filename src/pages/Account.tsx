import { useState, type FormEvent } from 'react'
import { Button, Card, ErrorBox, Field, Input, useToast } from '@/components/ui'
import { useAuth } from '@/lib/auth'
import { supabase, toAppError } from '@/lib/supabase'

export default function Account() {
  const { session, access, signOut } = useAuth()
  const toast = useToast()
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (pw.length < 10) return setError(new Error('La contraseña debe tener al menos 10 caracteres.'))
    if (pw !== pw2) return setError(new Error('Las contraseñas no coinciden.'))
    setBusy(true)
    try {
      const { error } = await supabase.auth.updateUser({ password: pw })
      if (error) throw error
      setPw('')
      setPw2('')
      toast('Contraseña actualizada')
    } catch (err) {
      setError(toAppError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto mt-6 max-w-lg space-y-4">
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
            <Input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
          </Field>
          <Field label="Repetir contraseña">
            <Input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
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

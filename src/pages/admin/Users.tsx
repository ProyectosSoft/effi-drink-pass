import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Badge, Button, Checkbox, ErrorBox, Field, Input, Modal, PageHeader, Spinner, useToast } from '@/components/ui'
import { useAuth } from '@/lib/auth'
import { fmtDateTime, fullName } from '@/lib/format'
import { query, rpc, supabase } from '@/lib/supabase'

type Profile = { id: string; auth_user_id: string | null; nombres: string; apellidos: string; email: string; telefono: string | null; activo: boolean; created_at: string }
type Role = { id: string; name: string; description: string | null; active: boolean }
type UserRole = { user_id: string; role_id: string }

export default function Users() {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<Profile | 'new' | null>(null)
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: async () => (await query<Profile[]>(supabase.from('profiles').select('*').order('nombres'))).data })
  const roles = useQuery({ queryKey: ['roles'], queryFn: async () => (await query<Role[]>(supabase.from('roles').select('*').order('name'))).data })
  const userRoles = useQuery({ queryKey: ['user-roles'], queryFn: async () => (await query<UserRole[]>(supabase.from('user_roles').select('user_id,role_id'))).data })
  const roleName = new Map(roles.data?.map((r) => [r.id, r.name]))

  return (
    <div>
      <PageHeader title="Usuarios del staff" subtitle="El staff se pre-registra por email. Al ingresar con ese email (código o contraseña) su cuenta queda vinculada."
        actions={<Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>Nuevo usuario</Button>} />
      <ErrorBox error={profiles.error} />
      <div className="card overflow-x-auto p-2">
        {profiles.isLoading ? <Spinner /> : (
          <table className="table-base min-w-[720px]">
            <thead><tr><th>Nombre</th><th>Email</th><th>Roles</th><th>Cuenta</th><th>Estado</th><th>Creado</th></tr></thead>
            <tbody>
              {profiles.data?.map((p) => (
                <tr key={p.id} className="cursor-pointer" onClick={() => setEditing(p)}>
                  <td className="font-medium">{fullName(p)}</td>
                  <td className="text-muted">{p.email}</td>
                  <td className="space-x-1">{userRoles.data?.filter((u) => u.user_id === p.id).map((u) => <Badge key={u.role_id} tone="accent">{roleName.get(u.role_id)}</Badge>)}</td>
                  <td>{p.auth_user_id ? <Badge tone="ok">Vinculada</Badge> : <Badge tone="warn">Pendiente de primer ingreso</Badge>}</td>
                  <td>{p.activo ? <Badge tone="ok">Activo</Badge> : <Badge tone="bad">Inactivo</Badge>}</td>
                  <td className="text-muted">{fmtDateTime(p.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editing && (
        <UserModal profile={editing === 'new' ? null : editing} roles={roles.data ?? []}
          currentRoles={editing === 'new' ? [] : userRoles.data?.filter((u) => u.user_id === editing.id).map((u) => u.role_id) ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); for (const k of ['profiles', 'user-roles']) void qc.invalidateQueries({ queryKey: [k] }) }} />
      )}
    </div>
  )
}

function UserModal({ profile, roles, currentRoles, onClose, onSaved }: {
  profile: Profile | null; roles: Role[]; currentRoles: string[]; onClose: () => void; onSaved: () => void
}) {
  const { access } = useAuth()
  const toast = useToast()
  const [f, setF] = useState({ email: profile?.email ?? '', nombres: profile?.nombres ?? '', apellidos: profile?.apellidos ?? '', telefono: profile?.telefono ?? '' })
  const [activo, setActivo] = useState(profile?.activo ?? true)
  const [selected, setSelected] = useState<string[]>(currentRoles)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const isSelf = profile?.id === access?.profile?.id

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const id = await rpc<string>('upsert_staff_profile', {
        p_id: profile?.id ?? null, p_email: f.email.trim(), p_nombres: f.nombres.trim(), p_apellidos: f.apellidos.trim(),
        p_telefono: f.telefono.trim() || null, p_activo: activo,
      })
      await rpc('set_user_roles', { p_profile_id: id, p_role_ids: selected })
      toast(profile ? 'Usuario actualizado' : 'Usuario creado. Debe ingresar con ese email para activar su cuenta.')
      onSaved()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={profile ? 'Editar usuario' : 'Nuevo usuario del staff'}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Email *"><Input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Teléfono"><Input value={f.telefono} onChange={(e) => setF({ ...f, telefono: e.target.value })} /></Field>
          <Field label="Nombres *"><Input required value={f.nombres} onChange={(e) => setF({ ...f, nombres: e.target.value })} /></Field>
          <Field label="Apellidos"><Input value={f.apellidos} onChange={(e) => setF({ ...f, apellidos: e.target.value })} /></Field>
        </div>
        <div>
          <p className="label">Roles</p>
          {roles.filter((r) => r.active).map((r) => (
            <Checkbox key={r.id} label={r.name} description={r.description ?? undefined} checked={selected.includes(r.id)}
              onChange={(v) => setSelected((s) => (v ? [...s, r.id] : s.filter((x) => x !== r.id)))} />
          ))}
        </div>
        <Checkbox label="Activo" checked={activo} disabled={isSelf} onChange={setActivo} description={isSelf ? 'No puedes desactivarte a ti mismo.' : 'Un usuario inactivo pierde todos sus permisos de inmediato.'} />
        <ErrorBox error={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button type="submit" loading={busy}>Guardar</Button>
        </div>
      </form>
    </Modal>
  )
}

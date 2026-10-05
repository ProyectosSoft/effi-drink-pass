import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Badge, Button, ErrorBox, Field, Input, Modal, PageHeader, Spinner, useToast } from '@/components/ui'
import { useAuth } from '@/lib/auth'
import { query, rpc, supabase } from '@/lib/supabase'
import { PERMISSIONS as P } from '@/lib/types'

type Role = { id: string; name: string; description: string | null; active: boolean; is_system: boolean }
type Perm = { id: string; name: string; description: string | null; integration_assignable: boolean }
type RP = { role_id: string; permission_id: string }

/**
 * /admin/roles — matriz de roles × permisos. Accesible con `rolesManage` o `usersManage`;
 * solo `rolesManage` puede editar (con `usersManage` es de solo lectura).
 * Los cambios se acumulan localmente y se guardan por rol con `set_role_permissions`.
 * El rol super_admin no se puede modificar. Permite crear roles nuevos (`upsert_role`).
 */
export default function Roles() {
  const { can } = useAuth()
  const qc = useQueryClient()
  const toast = useToast()
  const editable = can(P.rolesManage)
  const roles = useQuery({ queryKey: ['roles'], queryFn: async () => (await query<Role[]>(supabase.from('roles').select('*').order('name'))).data })
  const perms = useQuery({ queryKey: ['permissions'], queryFn: async () => (await query<Perm[]>(supabase.from('permissions').select('*').order('name'))).data })
  const rp = useQuery({ queryKey: ['role-permissions'], queryFn: async () => (await query<RP[]>(supabase.from('role_permissions').select('*'))).data })

  // role_id → nombres de permisos asignados (copia editable local).
  const [matrix, setMatrix] = useState<Record<string, Set<string>>>({})
  // Roles modificados y aún no guardados; solo esos se envían al guardar.
  const [dirty, setDirty] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [creating, setCreating] = useState(false)

  // Reconstruye la matriz desde el servidor (ids → nombres de permiso) y descarta cambios
  // locales cada vez que llegan datos nuevos (p. ej. tras guardar e invalidar).
  useEffect(() => {
    if (!rp.data || !perms.data) return
    const byId = new Map(perms.data.map((p) => [p.id, p.name]))
    const m: Record<string, Set<string>> = {}
    for (const r of rp.data) (m[r.role_id] ??= new Set()).add(byId.get(r.permission_id)!)
    setMatrix(m)
    setDirty(new Set())
  }, [rp.data, perms.data])

  /** Alterna un permiso de un rol; crea un Set nuevo para que React detecte el cambio. */
  const toggle = (roleId: string, perm: string) => {
    setMatrix((m) => {
      const s = new Set(m[roleId] ?? [])
      if (s.has(perm)) s.delete(perm)
      else s.add(perm)
      return { ...m, [roleId]: s }
    })
    setDirty((d) => new Set(d).add(roleId))
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      // Secuencial: si un rol falla, los anteriores ya quedaron guardados y se muestra el error.
      for (const roleId of dirty) await rpc('set_role_permissions', { p_role_id: roleId, p_permissions: [...(matrix[roleId] ?? [])] })
      toast('Permisos actualizados')
      void qc.invalidateQueries({ queryKey: ['role-permissions'] })
    } catch (e) {
      setError(e)
    } finally {
      setSaving(false)
    }
  }

  if (roles.isLoading || perms.isLoading) return <Spinner />
  const visibleRoles = roles.data ?? []

  return (
    <div>
      <PageHeader title="Roles y permisos" subtitle="Los permisos son también los scopes de la API. Los marcados como ‘API’ pueden asignarse a integraciones."
        actions={editable && <>
          <Button variant="secondary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>Nuevo rol</Button>
          <Button disabled={dirty.size === 0} loading={saving} onClick={save}>Guardar cambios</Button>
        </>} />
      <ErrorBox error={error} />
      <div className="card overflow-x-auto p-2">
        <table className="table-base min-w-[860px]">
          <thead>
            <tr>
              <th>Permiso</th>
              {visibleRoles.map((r) => <th key={r.id} className="text-center">{r.name}{!r.active && ' (inactivo)'}</th>)}
            </tr>
          </thead>
          <tbody>
            {perms.data?.map((p) => (
              <tr key={p.id}>
                <td>
                  <span className="font-mono text-xs">{p.name}</span> {p.integration_assignable && <Badge tone="accent">API</Badge>}
                  <span className="block text-xs text-faint">{p.description}</span>
                </td>
                {visibleRoles.map((r) => (
                  <td key={r.id} className="text-center">
                    <input type="checkbox" aria-label={`${r.name}: ${p.name}`} className="size-4 accent-[var(--color-brand)]"
                      checked={matrix[r.id]?.has(p.name) ?? false} disabled={!editable || r.name === 'super_admin'}
                      onChange={() => toggle(r.id, p.name)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-faint">El rol super_admin siempre tiene todos los permisos y no se puede modificar. Los cambios quedan en auditoría.</p>
      <NewRole open={creating} onClose={() => setCreating(false)} onDone={() => void qc.invalidateQueries({ queryKey: ['roles'] })} />
    </div>
  )
}

/**
 * Modal de creación de rol. El nombre se fuerza a minúsculas y debe cumplir el patrón
 * snake_case (letra inicial, luego minúsculas, dígitos o _; 2–50 caracteres).
 * El rol se crea sin permisos; se asignan después en la matriz.
 */
function NewRole({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  return (
    <Modal open={open} onClose={onClose} title="Nuevo rol" size="sm" footer={<>
      <Button variant="ghost" onClick={onClose}>Cancelar</Button>
      <Button loading={busy} disabled={!/^[a-z][a-z0-9_]{1,49}$/.test(name)} onClick={async () => {
        setBusy(true); setError(null)
        try { await rpc('upsert_role', { p_id: null, p_name: name, p_description: desc || null, p_active: true }); onDone(); onClose() }
        catch (e) { setError(e) } finally { setBusy(false) }
      }}>Crear</Button>
    </>}>
      <div className="space-y-3">
        <Field label="Nombre" hint="minúsculas, números y _ (ej. barra_vip)"><Input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} /></Field>
        <Field label="Descripción"><Input value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={300} /></Field>
        <ErrorBox error={error} />
      </div>
    </Modal>
  )
}

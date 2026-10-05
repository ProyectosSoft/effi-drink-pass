import { useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpen, KeyRound, Plus, RotateCw, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { Badge, Button, Card, Checkbox, ConfirmDialog, CopyButton, EmptyState, ErrorBox, Field, Input, Modal, PageHeader, Spinner, Textarea, useToast } from '@/components/ui'
import { WebhooksSection } from '@/components/WebhooksSection'
import { apiBaseUrl } from '@/lib/config'
import { fmtDateTime } from '@/lib/format'
import { query, rpc, supabase } from '@/lib/supabase'

type Integration = { id: string; name: string; description: string | null; contact_email: string | null; active: boolean; allowed_scopes: string[]; created_at: string }
type Credential = {
  id: string; integration_id: string; client_id: string; secret_hint: string; scopes: string[]; active: boolean; expires_at: string | null
  last_used_at: string | null; last_used_ip: string | null; created_at: string; revoked_at: string | null; revoke_reason: string | null
}
/** Credencial recién emitida: es la única vez que el cliente recibe el secreto en claro. */
type Issued = { id: string; client_id: string; client_secret: string; api_key: string; scopes: string[]; expires_at: string | null }

/**
 * /admin/integrations — sistemas externos que consumen la API. Requiere `integrationsManage`.
 * · Alta/edición de integraciones con sus scopes permitidos (techo para sus credenciales).
 * · Emisión (`create_api_credential`), rotación (`rotate_api_credential`) y revocación con
 *   motivo obligatorio (`revoke_api_credential`) de credenciales, con confirmación.
 * · El secreto solo se muestra una vez (SecretModal); en BD solo se guarda su hash.
 * · Webhooks salientes por integración (WebhooksSection).
 */
export default function Integrations() {
  const qc = useQueryClient()
  const toast = useToast()
  // Estados de los modales: integración en edición, integración para la que se emite
  // credencial, credencial recién emitida (secreto visible) y credencial a revocar/rotar.
  const [editing, setEditing] = useState<Integration | 'new' | null>(null)
  const [issuing, setIssuing] = useState<Integration | null>(null)
  const [issued, setIssued] = useState<Issued | null>(null)
  const [revoking, setRevoking] = useState<Credential | null>(null)
  const [rotating, setRotating] = useState<Credential | null>(null)

  const ints = useQuery({ queryKey: ['integrations'], queryFn: async () => (await query<Integration[]>(supabase.from('api_integrations').select('*').order('name'))).data })
  const creds = useQuery({
    queryKey: ['credentials'],
    // Selección explícita de columnas: nunca se pide el hash del secreto al cliente.
    queryFn: async () => (await query<Credential[]>(supabase.from('api_credentials')
      .select('id,integration_id,client_id,secret_hint,scopes,active,expires_at,last_used_at,last_used_ip,created_at,revoked_at,revoke_reason')
      .order('created_at', { ascending: false }))).data,
  })
  // Solo los permisos marcados como asignables a integraciones pueden ser scopes de API.
  const scopes = useQuery({
    queryKey: ['assignable-scopes'],
    queryFn: async () => (await query<{ name: string; description: string }[]>(supabase.from('permissions').select('name,description').eq('integration_assignable', true).order('name'))).data,
  })
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['integrations'] }); void qc.invalidateQueries({ queryKey: ['credentials'] }) }

  return (
    <div className="space-y-4">
      <PageHeader title="Integraciones" subtitle="Sistemas externos (p. ej. Effi) que consumen la API. Nunca acceden a la base de datos directamente."
        actions={<>
          <Link to="/api-docs"><Button variant="secondary" icon={<BookOpen className="size-4" />}>Documentación API</Button></Link>
          <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>Nueva integración</Button>
        </>} />

      <Card>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-muted">URL base de la API:</span>
          <code className="rounded-lg bg-surface-2 px-2 py-1 font-mono text-xs break-all">{apiBaseUrl}/v1</code>
          {apiBaseUrl && <CopyButton value={`${apiBaseUrl}/v1`} />}
        </div>
      </Card>

      <ErrorBox error={ints.error ?? creds.error} />
      {ints.isLoading ? <Spinner /> : ints.data?.length === 0 ? (
        <EmptyState title="Sin integraciones" icon={<KeyRound className="size-10" />}>Crea una integración para emitir credenciales de API con permisos mínimos.</EmptyState>
      ) : ints.data?.map((i) => {
        const list = creds.data?.filter((c) => c.integration_id === i.id) ?? []
        return (
          <Card key={i.id} title={<span className="flex flex-wrap items-center gap-2">{i.name} {i.active ? <Badge tone="ok">Activa</Badge> : <Badge tone="bad">Desactivada</Badge>}</span>}
            actions={<>
              <Button size="sm" variant="secondary" onClick={() => setEditing(i)}>Editar</Button>
              <Button size="sm" disabled={!i.active} icon={<KeyRound className="size-4" />} onClick={() => setIssuing(i)}>Generar credencial</Button>
            </>}>
            {i.description && <p className="mb-2 text-sm text-muted">{i.description}</p>}
            <div className="mb-4 flex flex-wrap gap-1">{i.allowed_scopes.map((s) => <Badge key={s} tone="accent">{s}</Badge>)}</div>
            <div className="overflow-x-auto">
              <table className="table-base min-w-[780px]">
                <thead><tr><th>Client ID</th><th>Secreto</th><th>Scopes</th><th>Último uso</th><th>Expira</th><th>Estado</th><th /></tr></thead>
                <tbody>
                  {list.map((c) => {
                    // Solo informativo (reloj local); la expiración real la aplica el servidor.
                    const expired = c.expires_at && new Date(c.expires_at) <= new Date()
                    return (
                      <tr key={c.id}>
                        <td className="font-mono text-xs">{c.client_id}</td>
                        <td className="font-mono text-xs text-muted">…{c.secret_hint}</td>
                        <td className="max-w-xs"><div className="flex flex-wrap gap-1">{c.scopes.map((s) => <Badge key={s}>{s}</Badge>)}</div></td>
                        <td className="text-xs">{fmtDateTime(c.last_used_at)}{c.last_used_ip && <span className="block text-faint">{c.last_used_ip}</span>}</td>
                        <td className="text-xs">{c.expires_at ? fmtDateTime(c.expires_at) : 'Nunca'}</td>
                        <td>{c.revoked_at ? <Badge tone="bad" className="max-w-[10rem] truncate">Revocada{c.revoke_reason ? `: ${c.revoke_reason}` : ''}</Badge> : expired ? <Badge tone="warn">Expirada</Badge> : <Badge tone="ok">Activa</Badge>}</td>
                        <td className="text-right whitespace-nowrap">
                          {!c.revoked_at && <>
                            <Button size="sm" variant="ghost" icon={<RotateCw className="size-3.5" />} onClick={() => setRotating(c)}>Rotar</Button>
                            <Button size="sm" variant="danger" onClick={() => setRevoking(c)}>Revocar</Button>
                          </>}
                        </td>
                      </tr>
                    )
                  })}
                  {list.length === 0 && <tr><td colSpan={7} className="text-center text-muted">Sin credenciales</td></tr>}
                </tbody>
              </table>
            </div>
            {/* Los webhooks emiten datos de consumos, por eso exigen el scope consumptions:read. */}
            <WebhooksSection integrationId={i.id} canSubscribe={i.allowed_scopes.includes('consumptions:read')} />
          </Card>
        )
      })}

      {editing && <IntegrationModal integration={editing === 'new' ? null : editing} scopes={scopes.data ?? []} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh() }} />}
      {issuing && <IssueModal integration={issuing} onClose={() => setIssuing(null)} onIssued={(c) => { setIssuing(null); setIssued(c); refresh() }} />}
      {issued && <SecretModal cred={issued} onClose={() => setIssued(null)} />}
      <ConfirmDialog open={!!revoking} title="Revocar credencial" danger requireReason confirmLabel="Revocar"
        message={<>La credencial <code>{revoking?.client_id}</code> dejará de funcionar de inmediato, incluidos los access tokens ya emitidos.</>}
        onClose={() => setRevoking(null)}
        onConfirm={async (reason) => { await rpc('revoke_api_credential', { p_credential_id: revoking!.id, p_reason: reason }); toast('Credencial revocada'); refresh() }} />
      <ConfirmDialog open={!!rotating} title="Rotar credencial" confirmLabel="Rotar"
        message="Se emitirá una credencial nueva con los mismos scopes y la actual quedará revocada de inmediato. Actualice el sistema externo con el nuevo secreto."
        onClose={() => setRotating(null)}
        // La rotación devuelve una credencial nueva: se muestra su secreto con SecretModal.
        onConfirm={async () => { const c = await rpc<Issued>('rotate_api_credential', { p_credential_id: rotating!.id }); setIssued(c); refresh() }} />
    </div>
  )
}

/**
 * Alta/edición de una integración: nombre, contacto, scopes permitidos y (solo al editar)
 * estado activo. Reducir scopes recorta también las credenciales existentes (servidor).
 */
function IntegrationModal({ integration, scopes, onClose, onSaved }: {
  integration: Integration | null; scopes: { name: string; description: string }[]; onClose: () => void; onSaved: () => void
}) {
  const [name, setName] = useState(integration?.name ?? '')
  const [description, setDescription] = useState(integration?.description ?? '')
  const [contact, setContact] = useState(integration?.contact_email ?? '')
  const [active, setActive] = useState(integration?.active ?? true)
  const [allowed, setAllowed] = useState<string[]>(integration?.allowed_scopes ?? [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  return (
    <Modal open onClose={onClose} title={integration ? 'Editar integración' : 'Nueva integración'} footer={<>
      <Button variant="ghost" onClick={onClose}>Cancelar</Button>
      <Button loading={busy} disabled={name.trim().length < 2} onClick={async () => {
        setBusy(true); setError(null)
        try {
          if (integration) {
            await rpc('update_integration', { p_id: integration.id, p_name: name, p_description: description || null, p_allowed_scopes: allowed, p_contact_email: contact || null, p_active: active })
          } else {
            await rpc('create_integration', { p_name: name, p_description: description || null, p_allowed_scopes: allowed, p_contact_email: contact || null })
          }
          onSaved()
        } catch (e) { setError(e) } finally { setBusy(false) }
      }}>Guardar</Button>
    </>}>
      <div className="space-y-4">
        <Field label="Nombre"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Effi ERP" maxLength={100} /></Field>
        <Field label="Descripción"><Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} /></Field>
        <Field label="Email de contacto técnico"><Input type="email" value={contact} onChange={(e) => setContact(e.target.value)} /></Field>
        <div>
          <p className="label">Scopes permitidos (techo para sus credenciales)</p>
          <p className="mb-2 text-xs text-faint">Asigne solo lo mínimo necesario. Reducirlos recorta también las credenciales existentes.</p>
          <div className="grid gap-1 sm:grid-cols-2">
            {scopes.map((s) => (
              <Checkbox key={s.name} label={<span className="font-mono text-xs">{s.name}</span>} description={s.description} checked={allowed.includes(s.name)}
                onChange={(v) => setAllowed((a) => (v ? [...a, s.name] : a.filter((x) => x !== s.name)))} />
            ))}
          </div>
        </div>
        {integration && <Checkbox label="Integración activa" checked={active} onChange={setActive} description="Desactivarla bloquea todas sus credenciales al instante." />}
        <ErrorBox error={error} />
      </div>
    </Modal>
  )
}

/**
 * Emite una credencial con un subconjunto de los scopes permitidos de la integración
 * (principio de mínimo privilegio) y expiración opcional.
 */
function IssueModal({ integration, onClose, onIssued }: { integration: Integration; onClose: () => void; onIssued: (c: Issued) => void }) {
  const [selected, setSelected] = useState<string[]>([])
  const [expires, setExpires] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  return (
    <Modal open onClose={onClose} title={`Nueva credencial · ${integration.name}`} footer={<>
      <Button variant="ghost" onClick={onClose}>Cancelar</Button>
      <Button loading={busy} disabled={selected.length === 0} onClick={async () => {
        setBusy(true); setError(null)
        try {
          // La fecha elegida expira al final de ese día en hora de Colombia (23:59:59 -05:00).
          onIssued(await rpc<Issued>('create_api_credential', {
            p_integration_id: integration.id, p_scopes: selected, p_expires_at: expires ? new Date(`${expires}T23:59:59-05:00`).toISOString() : null }))
        } catch (e) { setError(e) } finally { setBusy(false) }
      }}>Generar</Button>
    </>}>
      <div className="space-y-4">
        <div>
          <p className="label">Scopes de esta credencial</p>
          {integration.allowed_scopes.length === 0 && <p className="text-sm text-warn">La integración no tiene scopes permitidos. Edítela primero.</p>}
          {integration.allowed_scopes.map((s) => (
            <Checkbox key={s} label={<span className="font-mono text-xs">{s}</span>} checked={selected.includes(s)}
              onChange={(v) => setSelected((a) => (v ? [...a, s] : a.filter((x) => x !== s)))} />
          ))}
        </div>
        <Field label="Expira (opcional)" hint="Recomendado: fecha de cierre del evento"><Input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} /></Field>
        <ErrorBox error={error} />
      </div>
    </Modal>
  )
}

/**
 * Muestra client_id, client_secret y API key de una credencial recién emitida o rotada.
 * No se puede cerrar (ni con Escape/fondo) hasta marcar que el secreto fue guardado,
 * porque no se volverá a mostrar.
 */
function SecretModal({ cred, onClose }: { cred: Issued; onClose: () => void }) {
  const [ack, setAck] = useState(false)
  return (
    <Modal open onClose={() => ack && onClose()} title="Credencial generada" footer={<Button disabled={!ack} onClick={onClose}>Listo</Button>}>
      <div className="space-y-4 text-sm">
        <p className="flex items-start gap-2 rounded-xl bg-warn/10 p-3 text-warn">
          <ShieldAlert className="mt-0.5 size-5 shrink-0" />
          Copie el secreto ahora y entréguelo por un canal seguro. No se volverá a mostrar: el sistema solo guarda su hash.
        </p>
        {([['client_id', cred.client_id], ['client_secret', cred.client_secret], ['X-API-Key', cred.api_key]] as const).map(([k, v]) => (
          <div key={k}>
            <p className="label">{k}</p>
            <div className="flex gap-2"><code className="flex-1 rounded-lg bg-surface-2 px-3 py-2 font-mono text-xs break-all">{v}</code><CopyButton value={v} /></div>
          </div>
        ))}
        <p className="text-xs text-muted">Scopes: {cred.scopes.join(', ')} · Expira: {cred.expires_at ? fmtDateTime(cred.expires_at) : 'nunca'}</p>
        <Checkbox label="Ya copié y guardé el secreto de forma segura" checked={ack} onChange={setAck} />
      </div>
    </Modal>
  )
}

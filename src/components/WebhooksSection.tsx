import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, RotateCw, ShieldAlert, Webhook } from 'lucide-react'
import { useState } from 'react'
import { Badge, Button, Checkbox, CopyButton, ErrorBox, Field, Input, Modal, Spinner, useToast } from '@/components/ui'
import { fmtDateTime } from '@/lib/format'
import { query, rpc, supabase } from '@/lib/supabase'

/** Suscripción de webhook. Del secreto solo se expone `secret_hint` (últimos caracteres), nunca el valor completo. */
type Subscription = { id: string; integration_id: string; url: string; events: string[]; description: string | null; active: boolean; secret_hint: string; created_at: string }
/** Intento(s) de entrega de un evento a una suscripción, gestionados por el despachador programado. */
type Delivery = { id: number; event_id: number; event_type: string; status: string; attempts: number; next_attempt_at: string; last_status_code: number | null; last_error: string | null; delivered_at: string | null; created_at: string }

/** Color del badge según el estado de la entrega (estados desconocidos → neutro). */
const deliveryTone = { delivered: 'ok', pending: 'info', sending: 'info', failed: 'bad' } as const

/**
 * Webhooks salientes de una integración (evento benefit.consumed).
 * @param canSubscribe la integración tiene el scope consumptions:read; sin él no se permiten
 *   suscripciones (un webhook no puede revelar datos que la integración no podría leer por API).
 */
export function WebhooksSection({ integrationId, canSubscribe }: { integrationId: string; canSubscribe: boolean }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [creating, setCreating] = useState(false)
  /** Secreto en claro recién creado/rotado; solo vive en memoria mientras el modal está abierto. */
  const [secret, setSecret] = useState<string | null>(null)
  const [viewing, setViewing] = useState<Subscription | null>(null)
  // Lectura directa de la tabla: la política RLS exige integrations:manage. El secreto vive en otra tabla (privada).
  const subs = useQuery({
    queryKey: ['webhooks', integrationId],
    queryFn: async () => (await query<Subscription[]>(supabase.from('webhook_subscriptions').select('*').eq('integration_id', integrationId).order('created_at'))).data,
  })
  const refresh = () => void qc.invalidateQueries({ queryKey: ['webhooks', integrationId] })

  /** Pausa/activa la suscripción; la RPC reemplaza todos los campos, por eso se reenvían los actuales. */
  const toggle = async (s: Subscription) => {
    try {
      await rpc('update_webhook_subscription', { p_id: s.id, p_url: s.url, p_events: s.events, p_description: s.description, p_active: !s.active })
      refresh()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'bad')
    }
  }

  return (
    <div className="mt-5 border-t border-line pt-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold"><Webhook className="size-4" /> Webhooks</h3>
        <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} disabled={!canSubscribe} onClick={() => setCreating(true)}
          title={canSubscribe ? undefined : 'La integración necesita el scope consumptions:read'}>Nuevo webhook</Button>
      </div>
      {!canSubscribe && <p className="mb-2 text-xs text-faint">Para recibir webhooks la integración debe tener el scope <code>consumptions:read</code>.</p>}
      {subs.isLoading ? <Spinner /> : subs.data?.length === 0 ? <p className="text-sm text-muted">Sin webhooks.</p> : (
        <ul className="divide-y divide-line text-sm">
          {subs.data?.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <p className="truncate font-mono text-xs">{s.url}</p>
                <p className="text-xs text-faint">{s.events.join(', ')} · secreto …{s.secret_hint}{s.description ? ` · ${s.description}` : ''}</p>
              </div>
              <div className="flex items-center gap-1">
                {s.active ? <Badge tone="ok">Activo</Badge> : <Badge>Pausado</Badge>}
                <Button size="sm" variant="ghost" onClick={() => setViewing(s)}>Entregas</Button>
                <Button size="sm" variant="ghost" onClick={() => toggle(s)}>{s.active ? 'Pausar' : 'Activar'}</Button>
                {/* Rotar invalida el secreto anterior; el nuevo se muestra una única vez. */}
                <Button size="sm" variant="ghost" icon={<RotateCw className="size-3.5" />} onClick={async () => {
                  try { setSecret((await rpc<{ secret: string }>('rotate_webhook_secret', { p_id: s.id })).secret); refresh() }
                  catch (e) { toast(e instanceof Error ? e.message : String(e), 'bad') }
                }}>Rotar secreto</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {creating && <CreateModal integrationId={integrationId} onClose={() => setCreating(false)} onCreated={(sec) => { setCreating(false); setSecret(sec); refresh() }} />}
      {secret && (
        <Modal open onClose={() => setSecret(null)} title="Secreto de firma del webhook" footer={<Button onClick={() => setSecret(null)}>Listo</Button>}>
          <div className="space-y-3 text-sm">
            <p className="flex items-start gap-2 rounded-xl bg-warn/10 p-3 text-warn"><ShieldAlert className="mt-0.5 size-5 shrink-0" />
              Entréguelo al receptor para verificar <code>X-EDP-Signature</code>. No se volverá a mostrar.</p>
            <div className="flex gap-2"><code className="flex-1 rounded-lg bg-surface-2 px-3 py-2 font-mono text-xs break-all">{secret}</code><CopyButton value={secret} /></div>
          </div>
        </Modal>
      )}
      {viewing && <DeliveriesModal sub={viewing} onClose={() => setViewing(null)} />}
    </div>
  )
}

/** Alta de una suscripción. El servidor genera el secreto de firma y lo devuelve solo en esta respuesta. */
function CreateModal({ integrationId, onClose, onCreated }: { integrationId: string; onClose: () => void; onCreated: (secret: string) => void }) {
  const [url, setUrl] = useState('https://')
  const [description, setDescription] = useState('')
  const [consumed, setConsumed] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  return (
    <Modal open onClose={onClose} title="Nuevo webhook" footer={<>
      <Button variant="ghost" onClick={onClose}>Cancelar</Button>
      {/* Pre-validación de UX (HTTPS + host con dominio). La validación definitiva (anti-SSRF: sin IPs literales,
          credenciales ni hosts internos) la hace el servidor en create_webhook_subscription. */}
      <Button loading={busy} disabled={!consumed || !/^https:\/\/[^\s/]+\.[^\s/]+/.test(url)} onClick={async () => {
        setBusy(true); setError(null)
        try {
          const r = await rpc<{ secret: string }>('create_webhook_subscription', {
            p_integration_id: integrationId, p_url: url.trim(), p_events: ['benefit.consumed'], p_description: description || null })
          onCreated(r.secret)
        } catch (e) { setError(e) } finally { setBusy(false) }
      }}>Crear</Button>
    </>}>
      <div className="space-y-3">
        <Field label="URL HTTPS del receptor" hint="Debe responder 2xx en menos de 10 s. Se reintenta hasta 8 veces con espera creciente.">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://erp.ejemplo.com/webhooks/drinkpass" />
        </Field>
        <Field label="Descripción"><Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} /></Field>
        <div>
          <p className="label">Eventos</p>
          <Checkbox label={<code>benefit.consumed</code>} description="Cada vez que se consume un beneficio" checked={consumed} onChange={setConsumed} />
        </div>
        <ErrorBox error={error} />
      </div>
    </Modal>
  )
}

/** Historial de las últimas 100 entregas de una suscripción, con reintento manual de las fallidas. */
function DeliveriesModal({ sub, onClose }: { sub: Subscription; onClose: () => void }) {
  const toast = useToast()
  // Se refresca cada 15 s para ver el avance de los reintentos del despachador sin recargar.
  const list = useQuery({
    queryKey: ['webhook-deliveries', sub.id],
    queryFn: () => rpc<Delivery[]>('list_webhook_deliveries', { p_subscription_id: sub.id, p_limit: 100 }),
    refetchInterval: 15_000,
  })
  return (
    <Modal open onClose={onClose} title="Entregas recientes" size="lg">
      <p className="mb-3 truncate font-mono text-xs text-muted">{sub.url}</p>
      <ErrorBox error={list.error} />
      {list.isLoading ? <Spinner /> : list.data?.length === 0 ? <p className="text-sm text-muted">Aún no hay entregas.</p> : (
        <div className="max-h-[60vh] overflow-auto">
          <table className="table-base">
            <thead><tr><th>#</th><th>Evento</th><th>Estado</th><th>Intentos</th><th>Respuesta</th><th>Fecha</th><th /></tr></thead>
            <tbody>
              {list.data?.map((d) => (
                <tr key={d.id}>
                  <td className="tabular-nums">{d.id}</td>
                  <td className="text-xs">{d.event_type}</td>
                  <td><Badge tone={deliveryTone[d.status as keyof typeof deliveryTone] ?? 'neutral'}>{d.status}</Badge></td>
                  <td className="tabular-nums">{d.attempts}</td>
                  <td className="max-w-[14rem] truncate text-xs text-muted" title={d.last_error ?? ''}>{d.last_status_code ?? '—'} {d.last_error ?? ''}</td>
                  <td className="text-xs">{fmtDateTime(d.delivered_at ?? d.created_at)}{d.status === 'pending' && d.attempts > 0 && <span className="block text-faint">próximo {fmtDateTime(d.next_attempt_at)}</span>}</td>
                  <td>{d.status === 'failed' && <Button size="sm" variant="secondary" onClick={async () => {
                    try { await rpc('retry_webhook_delivery', { p_delivery_id: d.id }); toast('Reintento programado'); void list.refetch() }
                    catch (e) { toast(e instanceof Error ? e.message : String(e), 'bad') }
                  }}>Reintentar</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}

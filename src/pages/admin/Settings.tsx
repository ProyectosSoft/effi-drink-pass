import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Badge, Button, Card, Checkbox, ErrorBox, Field, Input, Modal, PageHeader, Select, useToast } from '@/components/ui'
import { useAuth } from '@/lib/auth'
import { fmtEventDate, hhmm } from '@/lib/format'
import { query, rpc, supabase } from '@/lib/supabase'
import { PERMISSIONS as P, type EventDay } from '@/lib/types'

/**
 * /admin/settings — configuración. Accesible con `settingsManage` o `eventDaysWrite`.
 * · Reloj oficial del servidor (RPC `server_time`, cada 10 s): referencia de todas las validaciones.
 * · Días del evento: alta/edición con `upsert_event_day` (requiere `eventDaysWrite`).
 * · Ajustes de la app (`app_settings`, guardados con `update_setting`; requiere `settingsManage`).
 */
export default function Settings() {
  const { can } = useAuth()
  const qc = useQueryClient()
  const toast = useToast()
  const [editing, setEditing] = useState<EventDay | 'new' | null>(null)
  const days = useQuery({ queryKey: ['event-days'], queryFn: async () => (await query<EventDay[]>(supabase.from('event_days').select('*').order('date'))).data })
  // Ajustes como objeto clave → valor (jsonb).
  const settings = useQuery({
    queryKey: ['app-settings'],
    queryFn: async () => Object.fromEntries((await query<{ key: string; value: unknown }[]>(supabase.from('app_settings').select('key,value'))).data.map((r) => [r.key, r.value])),
  })
  const clock = useQuery({ queryKey: ['server-time'], queryFn: () => rpc<{ now: string; today: string; local_time: string; timezone: string }>('server_time'), refetchInterval: 10_000 })

  // Solo las claves editadas viven en `draft`; el resto se muestra desde el servidor.
  const [draft, setDraft] = useState<Record<string, string>>({})
  const val = (k: string) => draft[k] ?? String(settings.data?.[k] ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const saveSettings = async () => {
    setSaving(true)
    setError(null)
    try {
      // Una RPC por clave modificada; los inputs entregan texto, así que el ajuste numérico
      // se convierte antes de guardarlo como jsonb.
      for (const [k, v] of Object.entries(draft)) {
        const value = k === 'scanner_auto_return_seconds' ? Number(v) : v
        await rpc('update_setting', { p_key: k, p_value: value })
      }
      setDraft({})
      toast('Configuración guardada')
      void qc.invalidateQueries({ queryKey: ['app-settings'] })
    } catch (e) {
      setError(e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Configuración" />

      <Card title="Reloj oficial del servidor">
        <p className="text-sm">
          {clock.data ? <>Hoy es <strong>{fmtEventDate(clock.data.today)}</strong>, {clock.data.local_time} ({clock.data.timezone}). </> : 'Consultando…'}
          <span className="text-muted">Toda validación usa esta hora; la del dispositivo se ignora.</span>
        </p>
      </Card>

      <Card title="Días del evento" actions={can(P.eventDaysWrite) && <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>Agregar día</Button>}>
        <div className="overflow-x-auto">
          <table className="table-base min-w-[560px]">
            <thead><tr><th>Fecha</th><th>Nombre</th><th>Horario (Colombia)</th><th>Estado</th><th /></tr></thead>
            <tbody>
              {days.data?.map((d) => (
                <tr key={d.id}>
                  <td>{fmtEventDate(d.date)}</td>
                  <td>{d.name}</td>
                  <td className="tabular-nums">{hhmm(d.start_time)} – {hhmm(d.end_time)}</td>
                  <td>{d.active ? <Badge tone="ok">Activo</Badge> : <Badge>Inactivo</Badge>}</td>
                  <td className="text-right">{can(P.eventDaysWrite) && <Button size="sm" variant="ghost" onClick={() => setEditing(d)}>Editar</Button>}</td>
                </tr>
              ))}
              {days.data?.length === 0 && <tr><td colSpan={5} className="text-center text-muted">Aún no hay días. Agregue los días de la feria.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>

      {can(P.settingsManage) && (
        <Card title="Aplicación">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nombre del evento"><Input value={val('event_name')} onChange={(e) => setDraft({ ...draft, event_name: e.target.value })} /></Field>
            <Field label="Modo por defecto del scanner" hint="Cada operador puede cambiarlo en su dispositivo">
              <Select value={val('scanner_default_mode')} onChange={(e) => setDraft({ ...draft, scanner_default_mode: e.target.value })}>
                <option value="confirm">Confirmación (muestra datos y el operador confirma)</option>
                <option value="auto">Automático (QR válido → consume de inmediato)</option>
              </Select>
            </Field>
            <Field label="Segundos para volver al scanner"><Input type="number" min={1} max={30} value={val('scanner_auto_return_seconds')} onChange={(e) => setDraft({ ...draft, scanner_auto_return_seconds: e.target.value })} /></Field>
            <Field label="Contacto de soporte (visible a asistentes)"><Input value={val('support_contact')} onChange={(e) => setDraft({ ...draft, support_contact: e.target.value })} /></Field>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <ErrorBox error={error} />
            <Button disabled={Object.keys(draft).length === 0} loading={saving} onClick={saveSettings}>Guardar</Button>
          </div>
        </Card>
      )}

      {editing && <DayModal day={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void qc.invalidateQueries({ queryKey: ['event-days'] }); toast('Día guardado') }} />}
    </div>
  )
}

/**
 * Alta/edición de un día del evento (hora de Colombia). Valores por defecto 08:00–20:00
 * cuando no hay horario; el botón se deshabilita si el fin no es posterior al inicio
 * (comparación lexicográfica válida para el formato HH:MM).
 */
function DayModal({ day, onClose, onSaved }: { day: EventDay | null; onClose: () => void; onSaved: () => void }) {
  const [date, setDate] = useState(day?.date ?? '')
  const [name, setName] = useState(day?.name ?? '')
  const [start, setStart] = useState(hhmm(day?.start_time) === '—' ? '08:00' : hhmm(day?.start_time))
  const [end, setEnd] = useState(hhmm(day?.end_time) === '—' ? '20:00' : hhmm(day?.end_time))
  const [active, setActive] = useState(day?.active ?? true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  return (
    <Modal open onClose={onClose} title={day ? 'Editar día' : 'Nuevo día del evento'} size="sm" footer={<>
      <Button variant="ghost" onClick={onClose}>Cancelar</Button>
      <Button loading={busy} disabled={!date || !name || end <= start} onClick={async () => {
        setBusy(true); setError(null)
        try { await rpc('upsert_event_day', { p_id: day?.id ?? null, p_date: date, p_name: name, p_start_time: start, p_end_time: end, p_active: active }); onSaved() }
        catch (e) { setError(e) } finally { setBusy(false) }
      }}>Guardar</Button>
    </>}>
      <div className="space-y-3">
        <Field label="Fecha"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Nombre"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Día 1" maxLength={80} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Inicio"><Input type="time" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
          <Field label="Fin"><Input type="time" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
        </div>
        <Checkbox label="Activo" checked={active} onChange={setActive} description="Un día inactivo no permite consumos." />
        {day && <p className="text-xs text-faint">Cambiar el horario actualiza la expiración de los beneficios pendientes de ese día.</p>}
        <ErrorBox error={error} />
      </div>
    </Modal>
  )
}

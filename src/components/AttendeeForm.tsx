import { useState, type FormEvent } from 'react'
import { Button, Checkbox, ErrorBox, Field, Input } from '@/components/ui'
import { rpc } from '@/lib/supabase'
import type { Attendee, EventDay } from '@/lib/types'

type Props = {
  /** Asistente a editar; si se omite, el formulario crea uno nuevo. */
  attendee?: Attendee | null
  /** Días del evento para elegir elegibilidad (solo en creación). */
  eventDays?: EventDay[]
  /** Recibe el id del asistente guardado. */
  onSaved: (id: string) => void
  onCancel?: () => void
}

/** Campos editables: [columna, etiqueta, tipo de input]. */
const fields = [
  ['nombres', 'Nombres *', 'text'],
  ['apellidos', 'Apellidos', 'text'],
  ['email', 'Email (login del portal)', 'email'],
  ['telefono', 'Teléfono', 'tel'],
  ['effi_id', 'ID Effi (opcional)', 'text'],
  ['effi_username', 'Usuario Effi (opcional)', 'text'],
  ['tipo_acceso', 'Tipo de acceso', 'text'],
  ['empresa', 'Empresa', 'text'],
] as const

/**
 * Formulario de alta/edición de asistentes. Guarda mediante la RPC `upsert_attendee`, que valida
 * permisos (attendees:write), formato y unicidad en el servidor; aquí solo se limpia la entrada.
 */
export function AttendeeForm({ attendee, eventDays, onSaved, onCancel }: Props) {
  const [data, setData] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map(([k]) => [k, (attendee?.[k] as string | null) ?? (k === 'tipo_acceso' ? 'GENERAL' : '')])))
  const [activo, setActivo] = useState(attendee?.activo ?? true)
  const [days, setDays] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const payload: Record<string, unknown> = { activo }
      // Campos vacíos se envían como null para limpiar el valor (y no chocar con índices únicos con '').
      for (const [k] of fields) payload[k] = data[k].trim() === '' ? null : data[k].trim()
      if (!payload.nombres) throw new Error('El nombre es obligatorio.')
      // p_partial=false reemplaza todos los campos: la metadata (no editable en este formulario)
      // se reenvía tal cual para no borrarla al editar.
      if (attendee) payload.metadata = attendee.metadata ?? {}
      const id = await rpc<string>('upsert_attendee', {
        p_id: attendee?.id ?? null,
        p_data: payload,
        p_partial: false,
        // Los días elegibles solo se asignan al crear; null en edición = no modificar los días.
        p_event_day_ids: attendee ? null : days,
      })
      onSaved(id)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map(([k, label, type]) => (
          <Field key={k} label={label}>
            <Input type={type} value={data[k]} required={k === 'nombres'} maxLength={k === 'empresa' ? 200 : 120}
              onChange={(e) => setData((d) => ({ ...d, [k]: e.target.value }))} />
          </Field>
        ))}
      </div>
      <Checkbox label="Activo" checked={activo} onChange={setActivo} description="Un asistente inactivo no puede usar sus beneficios." />
      {!attendee && eventDays && eventDays.length > 0 && (
        <div>
          <p className="label">Días elegibles (se generan los beneficios automáticamente)</p>
          <div className="grid gap-1 sm:grid-cols-2">
            {eventDays.map((d) => (
              <Checkbox key={d.id} label={`${d.name} · ${d.date}`} checked={days.includes(d.id)}
                onChange={(v) => setDays((s) => (v ? [...s, d.id] : s.filter((x) => x !== d.id)))} />
            ))}
          </div>
        </div>
      )}
      <ErrorBox error={error} />
      <div className="flex justify-end gap-2">
        {onCancel && <Button type="button" variant="ghost" onClick={onCancel}>Cancelar</Button>}
        <Button type="submit" loading={busy}>Guardar</Button>
      </div>
    </form>
  )
}

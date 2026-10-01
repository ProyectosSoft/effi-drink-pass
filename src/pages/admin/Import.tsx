import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, FileSpreadsheet, Upload } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Badge, Button, Card, Checkbox, ErrorBox, Field, PageHeader, Select, useToast } from '@/components/ui'
import { downloadCsv } from '@/lib/csv'
import {
  applyMapping, chunk, IMPORT_FIELDS, readSpreadsheet, suggestMapping, TEMPLATE_CSV, validateRows,
  type ImportField, type ImportRow, type RowCheck,
} from '@/lib/importParser'
import { query, rpc, supabase } from '@/lib/supabase'
import type { EventDay } from '@/lib/types'

type ServerRow = { row: number; action: 'insert' | 'update' | 'skip' | 'error'; attendee_id: string | null; errors: string[]; warnings: string[] }
type ServerResult = { dry_run: boolean; summary: Record<'total' | 'insert' | 'update' | 'skip' | 'error', number>; rows: ServerRow[] }
type Step = 'upload' | 'map' | 'preview' | 'done'

const BATCH = 500
const actionTone = { insert: 'ok', update: 'info', skip: 'neutral', error: 'bad' } as const
const actionLabel = { insert: 'Nuevo', update: 'Actualizar', skip: 'Omitir', error: 'Error' }

export default function Import() {
  const qc = useQueryClient()
  const toast = useToast()
  const [step, setStep] = useState<Step>('upload')
  const [fileName, setFileName] = useState('')
  const [headers, setHeaders] = useState<string[]>([])
  const [raw, setRaw] = useState<Record<string, unknown>[]>([])
  const [mapping, setMapping] = useState<Record<string, ImportField | ''>>({})
  const [mode, setMode] = useState<'upsert' | 'insert_only'>('upsert')
  const [dayIds, setDayIds] = useState<string[]>([])
  const [preview, setPreview] = useState<ServerRow[] | null>(null)
  const [final, setFinal] = useState<ServerResult['summary'] | null>(null)
  const [finalRows, setFinalRows] = useState<ServerRow[]>([])
  const [onlyProblems, setOnlyProblems] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<unknown>(null)

  const days = useQuery({ queryKey: ['event-days'], queryFn: async () => (await query<EventDay[]>(supabase.from('event_days').select('*').order('date'))).data })

  const rows: ImportRow[] = useMemo(() => applyMapping(raw, mapping), [raw, mapping])
  const localChecks: RowCheck[] = useMemo(() => validateRows(rows), [rows])
  const mappedFields = Object.values(mapping).filter(Boolean)

  const onFile = async (file: File) => {
    setError(null)
    setBusy(true)
    try {
      const r = await readSpreadsheet(file)
      if (r.rows.length === 0) throw new Error('El archivo no tiene filas de datos.')
      setFileName(file.name)
      setHeaders(r.headers)
      setRaw(r.rows)
      setMapping(suggestMapping(r.headers))
      setPreview(null)
      setStep('map')
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  /** Ejecuta en lotes contra el servidor (dry-run o real). Combina las validaciones locales. */
  const runServer = async (dryRun: boolean): Promise<ServerResult['rows']> => {
    const all: ServerRow[] = []
    const localByRow = new Map(localChecks.map((c) => [c.row, c]))
    const valid = rows.filter((r) => (localByRow.get(r.row)?.errors.length ?? 0) === 0)
    const batches = chunk(valid, BATCH)
    setProgress(0)
    for (let i = 0; i < batches.length; i++) {
      const res = await rpc<ServerResult>('import_attendees', {
        p_rows: batches[i], p_mode: mode, p_dry_run: dryRun, p_event_day_ids: dayIds.length ? dayIds : null, p_file_name: fileName,
      })
      all.push(...res.rows)
      setProgress(Math.round(((i + 1) / batches.length) * 100))
    }
    for (const c of localChecks) {
      if (c.errors.length) all.push({ row: c.row, action: 'error', attendee_id: null, errors: c.errors, warnings: c.warnings })
    }
    return all.sort((a, b) => a.row - b.row)
  }

  const validate = async () => {
    setBusy(true)
    setError(null)
    try {
      setPreview(await runServer(true))
      setStep('preview')
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  const commit = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await runServer(false)
      const summary = { total: result.length, insert: 0, update: 0, skip: 0, error: 0 }
      for (const r of result) summary[r.action]++
      setFinal(summary)
      setFinalRows(result)
      setStep('done')
      toast(`Importación terminada: ${summary.insert} nuevos, ${summary.update} actualizados`)
      void qc.invalidateQueries({ queryKey: ['attendees'] })
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  const summary = useMemo(() => {
    const s = { insert: 0, update: 0, skip: 0, error: 0 }
    for (const r of preview ?? []) s[r.action]++
    return s
  }, [preview])

  const rowData = new Map(rows.map((r) => [r.row, r]))
  const report = (list: ServerRow[]) => list.map((r) => ({
    fila: r.row, accion: actionLabel[r.action], ...rowData.get(r.row), attendee_id: r.attendee_id ?? '',
    errores: r.errors.join(' | '), advertencias: r.warnings.join(' | '),
  }))

  const visible = (preview ?? []).filter((r) => !onlyProblems || r.action === 'error' || r.warnings.length > 0)

  return (
    <div className="space-y-4">
      <PageHeader title="Importación de asistentes" subtitle="CSV o XLSX · validación, previsualización y confirmación explícita. Nunca se importa en silencio."
        actions={<Button variant="secondary" icon={<Download className="size-4" />} onClick={() => {
          const blob = new Blob(['﻿' + TEMPLATE_CSV], { type: 'text/csv;charset=utf-8' })
          const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'plantilla-asistentes.csv'; a.click()
        }}>Plantilla CSV</Button>} />

      <ol className="flex flex-wrap gap-2 text-xs">
        {(['upload', 'map', 'preview', 'done'] as Step[]).map((s, i) => (
          <li key={s}><Badge tone={step === s ? 'brand' : 'neutral'}>{i + 1}. {{ upload: 'Archivo', map: 'Columnas y opciones', preview: 'Previsualización', done: 'Resultado' }[s]}</Badge></li>
        ))}
      </ol>

      <ErrorBox error={error} />

      {step === 'upload' && (
        <Card>
          <label className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-line p-10 text-center hover:border-brand">
            <FileSpreadsheet className="size-10 text-brand" />
            <span className="font-semibold">Selecciona un archivo .csv o .xlsx</span>
            <span className="text-sm text-muted">Máximo 5 MB / 20 000 filas. Columnas: nombres, apellidos, email, teléfono, effi_id, effi_username, tipo_acceso, empresa.</span>
            <input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only"
              disabled={busy} onChange={(e) => e.target.files?.[0] && void onFile(e.target.files[0])} />
            <Button variant="secondary" loading={busy} icon={<Upload className="size-4" />} onClick={(e) => (e.currentTarget.previousElementSibling as HTMLInputElement)?.click()}>Elegir archivo</Button>
          </label>
        </Card>
      )}

      {step === 'map' && (
        <>
          <Card title={`Columnas de ${fileName}`} actions={<Badge>{raw.length} filas</Badge>}>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {headers.map((h) => (
                <Field key={h} label={h}>
                  <Select value={mapping[h] ?? ''} onChange={(e) => setMapping((m) => ({ ...m, [h]: e.target.value as ImportField | '' }))}>
                    <option value="">— ignorar —</option>
                    {IMPORT_FIELDS.map((f) => <option key={f} value={f} disabled={mappedFields.includes(f) && mapping[h] !== f}>{f}</option>)}
                  </Select>
                </Field>
              ))}
            </div>
            {!mappedFields.includes('nombres') && <p className="mt-3 text-sm text-bad">Debes mapear la columna “nombres”.</p>}
          </Card>
          <Card title="Opciones">
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <p className="label">Si el asistente ya existe (mismo ID Effi, email o usuario Effi)</p>
                <Checkbox label="Actualizar sus datos (celdas vacías no borran datos)" checked={mode === 'upsert'} onChange={(v) => setMode(v ? 'upsert' : 'insert_only')} />
                <Checkbox label="Omitirlo (solo insertar nuevos)" checked={mode === 'insert_only'} onChange={(v) => setMode(v ? 'insert_only' : 'upsert')} />
              </div>
              <div>
                <p className="label">Días elegibles a asignar (genera beneficios)</p>
                {days.data?.length === 0 && <p className="text-sm text-muted">No hay días configurados todavía.</p>}
                {days.data?.map((d) => (
                  <Checkbox key={d.id} label={`${d.name} · ${d.date}`} checked={dayIds.includes(d.id)}
                    onChange={(v) => setDayIds((s) => (v ? [...s, d.id] : s.filter((x) => x !== d.id)))} />
                ))}
              </div>
            </div>
            <div className="mt-4 flex justify-between gap-2">
              <Button variant="ghost" onClick={() => setStep('upload')}>Otro archivo</Button>
              <Button loading={busy} disabled={!mappedFields.includes('nombres')} onClick={validate}>Validar {rows.length} filas</Button>
            </div>
            {busy && <p className="mt-2 text-right text-xs text-muted">Validando con el servidor… {progress}%</p>}
          </Card>
        </>
      )}

      {step === 'preview' && preview && (
        <Card title="Previsualización (aún no se ha guardado nada)" actions={<>
          <Badge tone="ok">{summary.insert} nuevos</Badge><Badge tone="info">{summary.update} a actualizar</Badge>
          <Badge>{summary.skip} omitidos</Badge><Badge tone="bad">{summary.error} con error</Badge>
        </>}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <Checkbox label="Mostrar solo errores y advertencias" checked={onlyProblems} onChange={setOnlyProblems} />
            <Button size="sm" variant="secondary" onClick={() => downloadCsv('previsualizacion-importacion.csv', report(preview))}>Descargar previsualización</Button>
          </div>
          <div className="max-h-[50vh] overflow-auto">
            <table className="table-base min-w-[800px]">
              <thead className="sticky top-0 bg-surface"><tr><th>Fila</th><th>Acción</th><th>Nombre</th><th>Email</th><th>ID Effi</th><th>Detalle</th></tr></thead>
              <tbody>
                {visible.slice(0, 1000).map((r) => {
                  const d = rowData.get(r.row)
                  return (
                    <tr key={r.row}>
                      <td className="tabular-nums">{r.row}</td>
                      <td><Badge tone={actionTone[r.action]}>{actionLabel[r.action]}</Badge></td>
                      <td>{[d?.nombres, d?.apellidos].filter(Boolean).join(' ')}</td>
                      <td className="text-muted">{d?.email ?? '—'}</td>
                      <td className="font-mono">{d?.effi_id ?? '—'}</td>
                      <td className="text-xs">
                        {r.errors.map((e) => <p key={e} className="text-bad">{e}</p>)}
                        {r.warnings.map((w) => <p key={w} className="text-warn">{w}</p>)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {visible.length > 1000 && <p className="p-2 text-xs text-muted">Mostrando 1000 de {visible.length}. Descarga la previsualización para ver todo.</p>}
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
            <Button variant="ghost" onClick={() => setStep('map')}>Volver</Button>
            <div className="flex items-center gap-3">
              {summary.error > 0 && <span className="text-xs text-warn">Las filas con error no se importarán.</span>}
              <Button loading={busy} disabled={summary.insert + summary.update === 0} onClick={commit}>
                Confirmar importación ({summary.insert + summary.update})
              </Button>
            </div>
          </div>
          {busy && <p className="mt-2 text-right text-xs text-muted">Importando… {progress}%</p>}
        </Card>
      )}

      {step === 'done' && final && (
        <Card title="Importación completada">
          <div className="mb-4 flex flex-wrap gap-2">
            <Badge tone="ok">{final.insert} insertados</Badge><Badge tone="info">{final.update} actualizados</Badge>
            <Badge>{final.skip} omitidos</Badge><Badge tone="bad">{final.error} con error</Badge>
          </div>
          <p className="mb-4 text-sm text-muted">La operación quedó registrada en auditoría (IMPORT_ATTENDEES).</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" icon={<Download className="size-4" />} onClick={() => downloadCsv('reporte-importacion.csv', report(finalRows))}>Descargar reporte</Button>
            <Button onClick={() => { setStep('upload'); setRaw([]); setPreview(null); setFinal(null) }}>Nueva importación</Button>
          </div>
        </Card>
      )}
    </div>
  )
}

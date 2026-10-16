import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Button, Card, Checkbox, ErrorBox } from '@/components/ui'
import { COMPANY_TEMPLATE, parseCompanies } from '@/lib/companyImport'
import { chunk, readSpreadsheet } from '@/lib/importParser'
import { rpc } from '@/lib/supabase'
import type { EventDay } from '@/lib/types'

export function CompanyImport({ days }: { days: EventDay[] }) {
  const qc = useQueryClient()
  const [parsed, setParsed] = useState<ReturnType<typeof parseCompanies> | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [validated, setValidated] = useState(false)
  const [saved, setSaved] = useState(0)
  const [completed, setCompleted] = useState(false)
  const run = async (dryRun: boolean) => {
    if (busy || !parsed || !selected.length) return
    setBusy(true); setError(null); setCompleted(false)
    if (!dryRun) setSaved(0)
    try {
      for (const batch of chunk(parsed.companies, 500)) {
        await rpc('import_drink_companies', { p_rows: batch, p_event_day_ids: selected, p_dry_run: dryRun })
        if (!dryRun) setSaved((n) => n + batch.length)
      }
      if (dryRun) setValidated(true)
      else { setCompleted(true); setValidated(false) }
    } catch (err) { setError(err); setValidated(false) }
    finally {
      setBusy(false)
      if (!dryRun) { void qc.invalidateQueries({ queryKey: ['drink-companies'] }); void qc.invalidateQueries({ queryKey: ['company-balances'] }) }
    }
  }
  return (
    <Card title="Importar empresas y cupos diarios">
      <div className="space-y-4">
        <p className="text-sm text-muted">CSV o XLSX. Columnas: ID, Nombre fiscal, Identificación, CANTIDAD USUARIO y correo opcional. Guarda el archivo XLS como XLSX o CSV antes de cargarlo. Cantidad vacía = 1 bebida diaria. Las empresas existentes se actualizan por ID Effi.</p>
        <Button variant="secondary" onClick={() => {
          const url = URL.createObjectURL(new Blob(['\uFEFF' + COMPANY_TEMPLATE], { type: 'text/csv;charset=utf-8' }))
          const a = document.createElement('a'); a.href = url; a.download = 'plantilla-empresas.csv'; a.click()
          setTimeout(() => URL.revokeObjectURL(url), 1000)
        }}>Descargar plantilla de empresas</Button>
        <input type="file" accept=".csv,.xlsx" disabled={busy} aria-label="Archivo de empresas" onChange={async (e) => {
          const file = e.target.files?.[0]; if (!file) return
          setParsed(null); setValidated(false); setCompleted(false); setSaved(0); setError(null); setBusy(true)
          try { setParsed(parseCompanies((await readSpreadsheet(file)).rows)) } catch (err) { setError(err) }
          finally { setBusy(false) }
        }} />
        <fieldset disabled={busy}>
          <legend className="mb-2 text-sm font-semibold">Días habilitados para las empresas del archivo</legend>
          <div className="flex flex-wrap gap-3">{days.map((d) => <Checkbox key={d.id} label={`${d.name} (${d.date})`} checked={selected.includes(d.id)}
            onChange={(v) => { setSelected((ids) => v ? [...ids, d.id] : ids.filter((id) => id !== d.id)); setValidated(false); setCompleted(false) }} />)}</div>
        </fieldset>
        {parsed && <>
          <p className="text-sm">{parsed.companies.length} empresas válidas · {parsed.defaults} con cupo predeterminado de 1 · {parsed.errors.length} filas con errores.</p>
          {parsed.errors.length > 0 && <div role="alert" className="max-h-44 overflow-auto text-sm text-bad">{parsed.errors.slice(0, 50).map((err) => <p key={err}>{err}</p>)}<p>Corrige los errores antes de importar.</p></div>}
          <div className="max-h-56 overflow-auto"><table className="table-base"><thead><tr><th>ID Effi</th><th>Empresa</th><th>Cupo por día</th></tr></thead>
            <tbody>{parsed.companies.slice(0, 20).map((c) => <tr key={c.effi_id}><td>{c.effi_id}</td><td>{c.name}</td><td>{c.user_count}</td></tr>)}</tbody>
          </table></div>
          <p className="text-xs text-faint">Vista previa de las primeras 20 empresas. Importación por lotes: si un lote falla, los anteriores permanecen guardados.</p>
          <div className="flex gap-3">
            <Button variant="secondary" loading={busy} disabled={!selected.length || !!parsed.errors.length || !parsed.companies.length} onClick={() => void run(true)}>Validar sin guardar</Button>
            <Button loading={busy} disabled={!validated || completed || !selected.length} onClick={() => void run(false)}>Confirmar importación</Button>
          </div>
        </>}
        {(saved > 0 || completed) && <p role="status" className="text-sm">{completed ? 'Importación terminada' : 'Progreso guardado'}: {saved} empresas confirmadas.</p>}
        {validated && <p role="status" className="text-sm text-ok">Validación correcta. Puedes confirmar la importación.</p>}
        <ErrorBox error={error} />
      </div>
    </Card>
  )
}

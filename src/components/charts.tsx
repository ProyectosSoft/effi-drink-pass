import { useState, type ReactNode } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Table2, BarChart3 } from 'lucide-react'

/**
 * Paleta categórica validada (dataviz validator) sobre la superficie oscura #141424:
 * CVD ΔE ≥ 9.4, visión normal ΔE ≥ 26.5, contraste ≥ 3:1. Orden fijo, nunca ciclado.
 */
export const SERIES = ['#3987e5', '#d95926', '#199e70'] as const

const axis = { stroke: '#6e6e8a', fontSize: 12, tickLine: false, axisLine: false }
const tooltipStyle = {
  contentStyle: { background: '#1c1c30', border: '1px solid #2a2a42', borderRadius: 12, color: '#f3f3f8', fontSize: 13 },
  labelStyle: { color: '#a3a3bd', marginBottom: 4 },
  itemStyle: { color: '#f3f3f8' },
  cursor: { fill: 'rgba(255,255,255,0.05)' },
}

type Series = { key: string; label: string }

/** Tarjeta de gráfica con vista alternativa en tabla (accesibilidad). */
export function ChartCard<T extends Record<string, unknown>>({
  title, data, xKey, xLabel, series, height = 260, horizontal, stacked, formatX,
}: {
  title: string; data: T[]; xKey: keyof T & string; xLabel: string; series: Series[]; height?: number
  horizontal?: boolean; stacked?: boolean; formatX?: (v: unknown) => string
}) {
  const [table, setTable] = useState(false)
  const fx = formatX ?? ((v: unknown) => String(v))
  const empty = data.length === 0 || data.every((d) => series.every((s) => !Number(d[s.key])))

  let body: ReactNode
  if (empty) {
    body = <p className="grid h-40 place-items-center text-sm text-faint">Sin datos para los filtros actuales</p>
  } else if (table) {
    body = (
      <div className="max-h-72 overflow-auto">
        <table className="table-base">
          <thead><tr><th>{xLabel}</th>{series.map((s) => <th key={s.key} className="text-right">{s.label}</th>)}</tr></thead>
          <tbody>{data.map((d, i) => (
            <tr key={i}><td>{fx(d[xKey])}</td>{series.map((s) => <td key={s.key} className="text-right tabular-nums">{String(d[s.key] ?? 0)}</td>)}</tr>
          ))}</tbody>
        </table>
      </div>
    )
  } else {
    body = (
      <ResponsiveContainer width="100%" height={horizontal ? Math.max(160, data.length * 36) : height}>
        <BarChart data={data} layout={horizontal ? 'vertical' : 'horizontal'} margin={{ top: 4, right: 8, bottom: 0, left: horizontal ? 8 : -16 }}
          barCategoryGap={horizontal ? 8 : '20%'}>
          <CartesianGrid stroke="#2a2a42" strokeDasharray="0" vertical={horizontal} horizontal={!horizontal} />
          {horizontal ? (
            <>
              <XAxis type="number" allowDecimals={false} {...axis} />
              <YAxis type="category" dataKey={xKey as never} width={130} tickFormatter={fx} {...axis} />
            </>
          ) : (
            <>
              <XAxis dataKey={xKey as never} tickFormatter={fx} {...axis} />
              <YAxis allowDecimals={false} {...axis} />
            </>
          )}
          <Tooltip {...tooltipStyle} labelFormatter={(l) => fx(l)} />
          {series.length > 1 && <Legend wrapperStyle={{ fontSize: 12, color: '#a3a3bd' }} iconType="circle" />}
          {series.map((s, i) => (
            <Bar key={s.key} dataKey={s.key} name={s.label} fill={SERIES[i]} stackId={stacked ? 'a' : undefined}
              stroke="#141424" strokeWidth={stacked ? 2 : 0}
              radius={stacked ? (i === series.length - 1 ? (horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]) : 0) : (horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0])}
              maxBarSize={horizontal ? 22 : 36} isAnimationActive={false} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    )
  }

  return (
    <section className="card p-4 sm:p-5">
      <header className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <button onClick={() => setTable((t) => !t)} className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-ink"
          aria-label={table ? 'Ver gráfica' : 'Ver tabla'} title={table ? 'Ver gráfica' : 'Ver tabla'}>
          {table ? <BarChart3 className="size-4" /> : <Table2 className="size-4" />}
        </button>
      </header>
      {body}
    </section>
  )
}

import { clsx } from 'clsx'
import { Loader2, X } from 'lucide-react'
import {
  createContext, useCallback, useContext, useEffect, useId, useRef, useState,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react'
import type { BenefitStatus } from '@/lib/types'

// ───────────────────────────── Button ───────────────────────────────────────
// Biblioteca mínima de componentes de UI (Tailwind). Las clases utilitarias propias
// (brand-gradient, effi-corner, card, input, label…) están definidas en index.css.

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success'
/** Estilos por variante; `primary` usa la esquina recortada de la marca en lugar de bordes redondeados. */
const variants: Record<Variant, string> = {
  primary: 'brand-gradient brand-gradient-hover effi-corner text-white font-bold uppercase tracking-wide shadow-lg shadow-brand-deep/30',
  secondary: 'bg-surface-2 text-ink border border-line hover:border-muted',
  ghost: 'text-muted hover:text-ink hover:bg-surface-2',
  danger: 'bg-bad/15 text-bad border border-bad/40 hover:bg-bad/25',
  success: 'bg-ok text-bg font-bold uppercase tracking-wide hover:brightness-110',
}

/**
 * Botón estándar. Con `loading` se deshabilita y muestra un spinner en lugar del ícono,
 * lo que evita envíos dobles mientras una petición está en curso.
 */
export function Button({
  variant = 'primary', size = 'md', loading, icon, className, children, disabled, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg' | 'xl'; loading?: boolean; icon?: ReactNode }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center gap-2 transition select-none disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' && 'px-3 py-1.5 text-xs',
        size === 'md' && 'px-4 py-2.5 text-sm',
        size === 'lg' && 'px-5 py-3 text-base',
        size === 'xl' && 'px-6 py-5 text-lg font-bold',
        variant !== 'primary' && 'rounded-[10px]',
        variants[variant],
        className,
      )}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  )
}

// ───────────────────────────── Form fields ──────────────────────────────────
/** Etiqueta + control + mensaje inferior (el error tiene prioridad sobre la ayuda). Usa <label> para asociar el control. */
export function Field({ label, hint, error, children, className }: { label: string; hint?: string; error?: string; children: ReactNode; className?: string }) {
  return (
    <label className={clsx('block', className)}>
      <span className="label">{label}</span>
      {children}
      {error ? <span className="mt-1 block text-xs text-bad">{error}</span> : hint ? <span className="mt-1 block text-xs text-faint">{hint}</span> : null}
    </label>
  )
}

/** Input nativo con el estilo `.input`; acepta todas las props de <input>. */
export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={clsx('input', props.className)} />
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={clsx('input min-h-24', props.className)} />
}

export function Select({ children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={clsx('input appearance-none pr-8', props.className)}>
      {children}
    </select>
  )
}

/** Casilla con etiqueta y descripción opcional; `onChange` recibe directamente el booleano. */
export function Checkbox({ label, checked, onChange, disabled, description }: {
  label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; description?: string
}) {
  // id único y estable (compatible con SSR) para enlazar label e input.
  const id = useId()
  return (
    <label htmlFor={id} className={clsx('flex cursor-pointer items-start gap-3 rounded-lg p-1.5', disabled && 'cursor-not-allowed opacity-60')}>
      <input id={id} type="checkbox" className="mt-0.5 size-4 accent-[var(--color-brand)]" checked={checked} disabled={disabled}
        onChange={(e) => onChange(e.target.checked)} />
      <span className="text-sm">
        {label}
        {description && <span className="block text-xs text-faint">{description}</span>}
      </span>
    </label>
  )
}

// ───────────────────────────── Layout bits ──────────────────────────────────
/** Contenedor con cabecera opcional (título + acciones). */
export function Card({ children, className, title, actions }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={clsx('card p-4 sm:p-5', className)}>
      {(title || actions) && (
        <header className="mb-4 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="text-base font-semibold">{title}</h2>}
          {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  )
}

/** Encabezado de página: título (h1), subtítulo y acciones alineadas a la derecha. */
export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  )
}

/** Indicador de carga accesible (role="status" para lectores de pantalla). */
export function Spinner({ label = 'Cargando…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted" role="status">
      <Loader2 className="size-5 animate-spin" aria-hidden /> {label}
    </div>
  )
}

/** Mensaje centrado para listas vacías, accesos denegados y estados sin datos. */
export function EmptyState({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center">
      {icon && <div className="text-faint">{icon}</div>}
      <p className="font-medium">{title}</p>
      {children && <div className="max-w-md text-sm text-muted">{children}</div>}
    </div>
  )
}

/**
 * Muestra un error (normalmente un AppError ya traducido) o nada si `error` es falsy.
 * Se renderiza como texto de React, por lo que el mensaje del servidor no se interpreta como HTML.
 */
export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null
  const msg = error instanceof Error ? error.message : String(error)
  return <div role="alert" className="rounded-xl border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad">{msg}</div>
}

/** Tarjeta de indicador (KPI) con color semántico opcional. */
export function Stat({ label, value, tone = 'default', hint }: { label: string; value: ReactNode; tone?: 'default' | 'ok' | 'warn' | 'bad' | 'brand'; hint?: string }) {
  return (
    <div className="card p-4">
      <p className="text-xs font-medium tracking-wide text-muted uppercase">{label}</p>
      <p className={clsx('mt-1 text-2xl font-bold tabular-nums sm:text-3xl',
        tone === 'ok' && 'text-ok', tone === 'warn' && 'text-warn', tone === 'bad' && 'text-bad', tone === 'brand' && 'brand-text')}>
        {value}
      </p>
      {hint && <p className="mt-0.5 text-xs text-faint">{hint}</p>}
    </div>
  )
}

// ───────────────────────────── Badges ───────────────────────────────────────
/** Etiqueta tipo píldora con tono semántico. */
export function Badge({ children, tone = 'neutral', className }: { children: ReactNode; tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info' | 'brand' | 'accent'; className?: string }) {
  return (
    <span className={clsx('inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap',
      tone === 'neutral' && 'border-line bg-surface-2 text-muted',
      tone === 'ok' && 'border-ok/40 bg-ok/10 text-ok',
      tone === 'warn' && 'border-warn/40 bg-warn/10 text-warn',
      tone === 'bad' && 'border-bad/40 bg-bad/10 text-bad',
      tone === 'info' && 'border-info/40 bg-info/10 text-info',
      tone === 'brand' && 'border-brand/40 bg-brand/10 text-brand',
      tone === 'accent' && 'border-accent/40 bg-accent/10 text-accent',
      className)}>
      {children}
    </span>
  )
}

/** Etiqueta y tono para estados de beneficio (BenefitStatus) y estados de visualización del portal (display_status). */
const statusMap: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' | 'info' | 'neutral' | 'brand' }> = {
  PENDING: { label: 'Pendiente', tone: 'info' },
  CONSUMED: { label: 'Consumido', tone: 'ok' },
  EXPIRED: { label: 'Expirado', tone: 'warn' },
  CANCELLED: { label: 'Cancelado', tone: 'bad' },
  AVAILABLE: { label: 'Disponible', tone: 'brand' },
  NOT_AVAILABLE: { label: 'No disponible', tone: 'neutral' },
  UPCOMING: { label: 'Próximamente', tone: 'neutral' },
}

/** Badge de estado traducido; estados desconocidos se muestran tal cual en tono neutro. */
export function StatusBadge({ status }: { status: BenefitStatus | string | null | undefined }) {
  const s = statusMap[status ?? ''] ?? { label: status ?? '—', tone: 'neutral' as const }
  return <Badge tone={s.tone}>{s.label}</Badge>
}

// ───────────────────────────── Modal ────────────────────────────────────────
/**
 * Modal basado en <dialog> nativo: el navegador aporta foco atrapado, capa superior (top layer),
 * backdrop y cierre con Escape. El estado `open` de React se sincroniza con showModal()/close().
 */
export function Modal({ open, onClose, title, children, footer, size = 'md' }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl'
}) {
  const ref = useRef<HTMLDialogElement>(null)
  // Se comprueba d.open para no llamar showModal() sobre un diálogo ya abierto (lanza InvalidStateError).
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      // Escape: se impide el cierre nativo y se delega en el padre, que es el dueño del estado `open`.
      onCancel={(e) => { e.preventDefault(); onClose() }}
      className={clsx('m-auto w-[calc(100%-1.5rem)] rounded-2xl border border-line bg-surface p-0 text-ink backdrop:bg-black/70 backdrop:backdrop-blur-sm',
        size === 'sm' && 'max-w-md', size === 'md' && 'max-w-xl', size === 'lg' && 'max-w-3xl', size === 'xl' && 'max-w-5xl')}
    >
      {/* El contenido solo se monta mientras está abierto: al cerrar se reinicia el estado de los hijos. */}
      {open && (
        <div className="flex max-h-[90dvh] flex-col">
          <header className="flex items-center justify-between border-b border-line px-5 py-4">
            <h2 className="text-lg font-semibold">{title}</h2>
            <button onClick={onClose} className="rounded-lg p-1 text-muted hover:bg-surface-2 hover:text-ink" aria-label="Cerrar">
              <X className="size-5" />
            </button>
          </header>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer>}
        </div>
      )}
    </dialog>
  )
}

/**
 * Diálogo de confirmación con motivo opcional/obligatorio.
 * `onConfirm` puede ser asíncrono: si lanza, el error se muestra dentro del diálogo y este permanece
 * abierto; si resuelve, se cierra. Con `requireReason` exige al menos 5 caracteres (el motivo se audita).
 */
export function ConfirmDialog({ open, title, message, confirmLabel = 'Confirmar', danger, requireReason, onConfirm, onClose }: {
  open: boolean; title: string; message: ReactNode; confirmLabel?: string; danger?: boolean; requireReason?: boolean
  onConfirm: (reason: string) => Promise<void> | void; onClose: () => void
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  // Cada apertura empieza limpia (sin motivo ni error de un intento anterior).
  useEffect(() => {
    if (open) { setReason(''); setError(null) }
  }, [open])
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm" footer={<>
      <Button variant="ghost" onClick={onClose}>Cancelar</Button>
      <Button variant={danger ? 'danger' : 'primary'} loading={busy} disabled={requireReason && reason.trim().length < 5}
        onClick={async () => {
          setBusy(true); setError(null)
          try { await onConfirm(reason.trim()); onClose() } catch (e) { setError(e) } finally { setBusy(false) }
        }}>{confirmLabel}</Button>
    </>}>
      <div className="space-y-4 text-sm">
        <div className="text-muted">{message}</div>
        {requireReason && (
          <Field label="Motivo (queda en auditoría)" hint="Mínimo 5 caracteres">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} autoFocus />
          </Field>
        )}
        <ErrorBox error={error} />
      </div>
    </Modal>
  )
}

// ───────────────────────────── Paginación ───────────────────────────────────
/** Paginación simple anterior/siguiente; `page` empieza en 1. Muestra el rango "desde–hasta de total". */
export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  return (
    <div className="flex items-center justify-between gap-2 pt-3 text-sm text-muted">
      <span>{total === 0 ? 'Sin resultados' : `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} de ${total}`}</span>
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>Anterior</Button>
        <Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>Siguiente</Button>
      </div>
    </div>
  )
}

// ───────────────────────────── Toasts ───────────────────────────────────────
type Toast = { id: number; text: string; tone: 'ok' | 'bad' | 'info' }
/** El contexto expone directamente la función para mostrar un toast; fuera del proveedor es un no-op. */
const ToastCtx = createContext<(text: string, tone?: Toast['tone']) => void>(() => {})

/** Proveedor de notificaciones efímeras (se ocultan solas a los 4,5 s). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  // useCallback: referencia estable, así los consumidores no se re-renderizan al cambiar la lista.
  const push = useCallback((text: string, tone: Toast['tone'] = 'ok') => {
    // Id único aunque se emitan varios toasts en el mismo milisegundo.
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, text, tone }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500)
  }, [])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      {/* aria-live: los lectores de pantalla anuncian cada toast nuevo; el contenedor no bloquea clics. */}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={clsx('animate-pop pointer-events-auto rounded-xl border px-4 py-3 text-sm shadow-xl backdrop-blur',
            t.tone === 'ok' && 'border-ok/40 bg-ok/15 text-ok', t.tone === 'bad' && 'border-bad/40 bg-bad/15 text-bad',
            t.tone === 'info' && 'border-info/40 bg-info/15 text-info')}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

/** Devuelve `toast(texto, tono?)` para mostrar una notificación. */
export const useToast = () => useContext(ToastCtx)

/** Copia al portapapeles con feedback (la Clipboard API requiere HTTPS o localhost). */
export function CopyButton({ value, label = 'Copiar' }: { value: string; label?: string }) {
  const toast = useToast()
  return (
    <Button size="sm" variant="secondary" onClick={async () => {
      try { await navigator.clipboard.writeText(value); toast('Copiado', 'info') } catch { toast('No se pudo copiar', 'bad') }
    }}>{label}</Button>
  )
}

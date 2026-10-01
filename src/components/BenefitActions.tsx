import { MoreHorizontal } from 'lucide-react'
import { useState } from 'react'
import { ConfirmDialog, useToast } from '@/components/ui'
import { useAuth } from '@/lib/auth'
import { rpc } from '@/lib/supabase'
import { PERMISSIONS as P, type ScanResult } from '@/lib/types'

type Action = 'cancel' | 'restore' | 'rotate' | 'override'

/** Acciones administrativas sobre un beneficio (todas auditadas en el servidor). */
export function BenefitActions({ benefitId, status, onDone }: { benefitId: string; status: string; onDone: () => void }) {
  const { can } = useAuth()
  const toast = useToast()
  const [action, setAction] = useState<Action | null>(null)
  const [open, setOpen] = useState(false)

  const options: { key: Action; label: string; show: boolean }[] = [
    { key: 'override', label: 'Consumo excepcional…', show: can(P.benefitsOverride) && (status === 'PENDING' || status === 'EXPIRED') },
    { key: 'rotate', label: 'Regenerar QR (invalida el actual)', show: can(P.benefitsWrite) && status === 'PENDING' },
    { key: 'cancel', label: 'Cancelar beneficio', show: can(P.benefitsWrite) && (status === 'PENDING' || status === 'EXPIRED') },
    { key: 'restore', label: 'Restaurar a pendiente', show: can(P.benefitsWrite) && (status === 'CANCELLED' || status === 'EXPIRED') },
  ]
  const visible = options.filter((o) => o.show)
  if (visible.length === 0) return null

  const texts: Record<Action, { title: string; message: string; confirm: string; danger?: boolean }> = {
    cancel: { title: 'Cancelar beneficio', message: 'El QR dejará de funcionar. Se puede restaurar después.', confirm: 'Cancelar beneficio', danger: true },
    restore: { title: 'Restaurar beneficio', message: 'Vuelve a PENDIENTE. Solo funcionará en su día y horario.', confirm: 'Restaurar' },
    rotate: { title: 'Regenerar QR', message: 'Se genera un nuevo token y el QR anterior (capturas incluidas) deja de funcionar. El asistente verá el nuevo QR en su portal.', confirm: 'Regenerar' },
    override: { title: 'Consumo excepcional', message: 'Registra el consumo ignorando día y horario. Úselo solo con autorización: queda auditado con su nombre y el motivo.', confirm: 'Registrar consumo', danger: true },
  }

  const run = async (reason: string) => {
    if (action === 'cancel') await rpc('cancel_benefit', { p_benefit_id: benefitId, p_reason: reason })
    if (action === 'restore') await rpc('restore_benefit', { p_benefit_id: benefitId, p_reason: reason })
    if (action === 'rotate') await rpc('regenerate_benefit_token', { p_benefit_id: benefitId, p_reason: reason })
    if (action === 'override') {
      const r = await rpc<ScanResult>('benefit_override_redeem', { p_benefit_id: benefitId, p_reason: reason, p_idempotency_key: `override-${crypto.randomUUID()}` })
      if (!r.ok) throw new Error(r.message)
    }
    toast('Acción registrada')
    onDone()
  }

  return (
    <div className="relative inline-block">
      <button className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-ink" aria-label="Acciones del beneficio" aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}>
        <MoreHorizontal className="size-4" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <ul className="absolute right-0 z-20 mt-1 w-64 overflow-hidden rounded-xl border border-line bg-surface-2 py-1 shadow-xl">
            {visible.map((o) => (
              <li key={o.key}>
                <button className="w-full px-4 py-2 text-left text-sm hover:bg-surface" onClick={() => { setAction(o.key); setOpen(false) }}>{o.label}</button>
              </li>
            ))}
          </ul>
        </>
      )}
      {action && (
        <ConfirmDialog open title={texts[action].title} message={texts[action].message} confirmLabel={texts[action].confirm}
          danger={texts[action].danger} requireReason onConfirm={run} onClose={() => setAction(null)} />
      )}
    </div>
  )
}

import { useState } from 'react'
import { Button, Field, Input } from './ui'
import type { ScanResult } from '@/lib/types'

/** Cantidad explícita para empresa; una unidad para los pases individuales anteriores. */
export function DeliveryForm({ result, onConfirm, onCancel }: { result: ScanResult; onConfirm: (quantity: number) => void; onCancel: () => void }) {
  const [quantity, setQuantity] = useState('')
  const maximum = result.company?.remaining ?? 1
  const amount = result.company ? Number(quantity) : 1
  const valid = Number.isInteger(amount) && amount >= 1 && amount <= maximum && (!result.company || /^\d+$/.test(quantity))
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (valid) onConfirm(amount) }}>
      {result.company && <Field label="Cantidad de bebidas a entregar" hint={`Máximo disponible: ${maximum}`}>
        <Input type="number" inputMode="numeric" min={1} max={maximum} step={1} required autoFocus value={quantity}
          onChange={(e) => setQuantity(e.target.value)} className="text-xl" placeholder="Indica la cantidad" />
      </Field>}
      <div className="grid grid-cols-2 gap-3">
        <Button type="button" variant="secondary" size="lg" onClick={onCancel}>Cancelar</Button>
        <Button type="submit" variant="success" size="lg" disabled={!valid}>Confirmar {valid ? amount : ''}</Button>
      </div>
    </form>
  )
}

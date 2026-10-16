// @vitest-environment jsdom
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeliveryForm } from '../../src/components/DeliveryForm'
import type { ScanResult } from '../../src/lib/types'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('confirmación de cantidad por operador', () => {
  let host: HTMLDivElement, root: Root
  const confirm = vi.fn()
  const result: ScanResult = { ok: true, code: 'VALID', message: '', server_time: '', benefit: null, attendee: null, consumption: null,
    company: { id: 'company', effi_id: 'ID', name: 'Empresa', quota: 5, delivered: 2, remaining: 3 } }
  beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); confirm.mockClear() })
  afterEach(async () => { await act(async () => root.unmount()); host.remove() })
  const render = async (data = result) => act(async () => root.render(createElement(DeliveryForm, { result: data, onConfirm: confirm, onCancel: vi.fn() })))
  const change = async (value: string) => act(async () => {
    const input = host.querySelector('input')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  const submit = async () => act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })

  it('no entrega al escanear ni con cantidad vacía, mayor al saldo, negativa o decimal', async () => {
    await render()
    expect(confirm).not.toHaveBeenCalled()
    expect(host.querySelector('button[type="submit"]')!.hasAttribute('disabled')).toBe(true)
    for (const amount of ['', '4', '-1', '1.5', '0']) { await change(amount); await submit() }
    expect(confirm).not.toHaveBeenCalled()
  })

  it('solo envía la cantidad válida después de confirmar', async () => {
    await render()
    await change('2')
    expect(confirm).not.toHaveBeenCalled()
    await submit()
    expect(confirm).toHaveBeenCalledExactlyOnceWith(2)
  })

  it('los pases individuales existentes confirman exactamente una unidad', async () => {
    await render({ ...result, company: undefined })
    expect(host.querySelector('input')).toBeNull()
    await submit()
    expect(confirm).toHaveBeenCalledExactlyOnceWith(1)
  })
})

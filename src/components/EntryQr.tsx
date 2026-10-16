import { Link } from 'react-router'
import QRCode from 'qrcode'
import { useState } from 'react'
import { QrCode } from './QrCode'
import { Button, Card, ErrorBox } from './ui'
import { config } from '@/lib/config'

/** QR general de entrada para colocar en la feria; no contiene un beneficio personal. */
export function EntryQr() {
  const [error, setError] = useState<unknown>(null)
  const path = '/claim'
  const url = `${config.publicAppUrl}${path}`
  const download = async () => {
    setError(null)
    try {
      const svg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 4, color: { dark: '#000000', light: '#ffffff' } })
      const objectUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
      const link = document.createElement('a')
      link.href = objectUrl
      link.download = 'effi-drink-pass-acceso-clientes.svg'
      link.click()
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
    } catch (err) { setError(err) }
  }
  return (
    <Card title="QR de entrada para clientes">
      <div className="flex flex-col items-center gap-5 sm:flex-row">
        <div className="shrink-0">
          <QrCode value={url} size={220} label="Escanea para consultar tu beneficio de bebida" />
        </div>
        <div className="space-y-3 text-sm">
          <p className="font-semibold">Escanea para consultar tu beneficio de bebida</p>
          <p className="text-muted">Este QR abre la consulta por nombre fiscal, identificación o ID Effi de la empresa. Si tiene saldo hoy, muestra el QR para que el operador registre la cantidad de bebidas entregadas.</p>
          <p className="break-all text-xs text-faint">{url}</p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void download()}>Descargar QR</Button>
            <Link to={path}><Button variant="secondary">Abrir acceso del cliente</Button></Link>
          </div>
          <ErrorBox error={error} />
        </div>
      </div>
    </Card>
  )
}

import QRCode from 'qrcode'
import { useEffect, useState } from 'react'

/** Renderiza un QR como SVG (nítido a cualquier tamaño, alto contraste para lectores). */
export function QrCode({ value, size = 280, label }: { value: string; size?: number; label: string }) {
  const [svg, setSvg] = useState<string>('')
  useEffect(() => {
    let alive = true
    QRCode.toString(value, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, color: { dark: '#000000', light: '#ffffff' } })
      .then((s) => alive && setSvg(s))
      .catch(() => alive && setSvg(''))
    return () => {
      alive = false
    }
  }, [value])
  return (
    <div
      role="img"
      aria-label={label}
      className="rounded-2xl bg-white p-3 shadow-2xl [&>svg]:h-full [&>svg]:w-full"
      style={{ width: size, height: size, maxWidth: '100%', aspectRatio: '1' }}
      // El SVG lo genera la librería qrcode a partir de un token base64url validado: no contiene HTML de usuario.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

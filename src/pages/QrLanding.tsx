import { ScanLine, ShieldCheck } from 'lucide-react'
import { Link, Navigate, useParams } from 'react-router'
import { extractToken } from '@shared/qr.ts'
import { PublicShell } from '@/components/layout'
import { Button, EmptyState, Spinner } from '@/components/ui'
import { useAuth } from '@/lib/auth'
import { PERMISSIONS as P } from '@/lib/types'

/**
 * /qr/:token — lo que abre la cámara nativa del teléfono al leer el QR.
 * · Staff con permiso de validación → scanner con el token (siempre en modo confirmación).
 * · Cualquier otra persona → mensaje genérico. No se consulta ni revela nada (anti-enumeración).
 */
export default function QrLanding() {
  const { token = '' } = useParams()
  const { loading, can } = useAuth()
  // Solo se acepta un token con formato válido; cualquier otra cosa se trata como QR desconocido.
  const valid = extractToken(token)

  // Esperar a que cargue la sesión para no mostrar el mensaje genérico a staff legítimo.
  if (loading) return <Spinner />
  if (valid && (can(P.benefitsValidate) || can(P.benefitsRedeem))) {
    return <Navigate to={`/admin/scanner?token=${encodeURIComponent(valid)}`} replace />
  }
  return (
    <PublicShell>
      <EmptyState title="Pase de bebida — Feria Effix 2026" icon={<ShieldCheck className="size-12 text-brand" />}>
        <p>Este código es un beneficio personal de bebida. Debe ser escaneado por el personal autorizado en la barra.</p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <Link to="/my-benefits"><Button>Ver mis beneficios</Button></Link>
          {/* Tras el login, `next` devuelve al staff a este mismo QR para continuar al scanner. */}
          <Link to={`/login?staff=1&next=${encodeURIComponent(`/qr/${token}`)}`}><Button variant="secondary" icon={<ScanLine className="size-4" />}>Soy staff</Button></Link>
        </div>
      </EmptyState>
    </PublicShell>
  )
}

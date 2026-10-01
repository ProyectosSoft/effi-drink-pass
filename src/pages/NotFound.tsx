import { Link } from 'react-router'
import { PublicShell } from '@/components/layout'
import { Button, EmptyState } from '@/components/ui'

export function NotFound() {
  return (
    <PublicShell>
      <EmptyState title="Página no encontrada">
        <p className="mb-4">La dirección no existe o fue movida.</p>
        <Link to="/"><Button>Ir al inicio</Button></Link>
      </EmptyState>
    </PublicShell>
  )
}

import { useQuery } from '@tanstack/react-query'
import { CalendarDays, QrCode, ScanLine, ShieldCheck } from 'lucide-react'
import { Link } from 'react-router'
import { PublicShell } from '@/components/layout'
import { Button } from '@/components/ui'
import { useAuth } from '@/lib/auth'
import { fmtEventDate, hhmm } from '@/lib/format'
import { query, supabase } from '@/lib/supabase'
import type { EventDay } from '@/lib/types'

/**
 * Página de inicio pública (/). Presenta el servicio, enlaza al login de asistentes y de staff
 * y lista los días activos del evento (lectura pública de `event_days`).
 */
export function Landing() {
  const { session } = useAuth()
  // Días activos del evento; si la consulta falla o está vacía, la sección simplemente no se muestra.
  const days = useQuery({
    queryKey: ['public-event-days'],
    queryFn: async () => (await query<EventDay[]>(supabase.from('event_days').select('*').eq('active', true).order('date'))).data,
  })

  return (
    <PublicShell>
      <section className="relative -mx-4 overflow-hidden px-4 py-14 sm:mx-0 sm:px-0 sm:py-24">
        <div aria-hidden className="pointer-events-none absolute -top-40 left-1/2 size-[26rem] -translate-x-1/2 rounded-full bg-brand-2/20 blur-3xl sm:size-[36rem]" />
        <div className="relative mx-auto max-w-3xl text-center">
          <p className="mb-4 inline-flex rounded-full border border-line bg-surface px-3 py-1 text-xs text-muted">Feria Effix 2026</p>
          <h1 className="text-4xl font-extrabold tracking-tight text-balance sm:text-6xl">
            Tu bebida del día, <span className="brand-text">en un QR</span>.
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-base text-muted text-balance sm:text-lg">
            Ingresa con tu email, abre el beneficio de hoy y muéstralo en la barra. Un QR por día, válido solo en su fecha.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link to={session ? '/my-benefits' : '/login'}><Button size="lg" icon={<QrCode className="size-5" />}>Ver mis beneficios</Button></Link>
            {/* staff=1 hace que el login muestre directamente el acceso con contraseña. */}
            <Link to="/login?staff=1"><Button size="lg" variant="secondary" icon={<ScanLine className="size-5" />}>Soy staff</Button></Link>
          </div>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        {[
          { icon: <QrCode className="size-6" />, title: 'Un QR por día', text: 'Cada día elegible tiene su propio código. No contiene datos personales.' },
          { icon: <ShieldCheck className="size-6" />, title: 'Seguro', text: 'Validado en tiempo real por el servidor; un beneficio solo se puede usar una vez.' },
          { icon: <CalendarDays className="size-6" />, title: 'Hora oficial', text: 'La fecha y hora las define el servidor (hora de Colombia).' },
        ].map((f) => (
          <div key={f.title} className="card p-5">
            <div className="mb-3 text-brand">{f.icon}</div>
            <h3 className="font-semibold">{f.title}</h3>
            <p className="mt-1 text-sm text-muted">{f.text}</p>
          </div>
        ))}
      </section>

      {days.data && days.data.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-3 text-lg font-semibold">Días del evento</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {days.data.map((d) => (
              <div key={d.id} className="card p-4">
                <p className="text-sm font-semibold">{d.name}</p>
                <p className="text-sm text-muted">{fmtEventDate(d.date)}</p>
                <p className="mt-1 text-xs text-faint">{hhmm(d.start_time)} – {hhmm(d.end_time)}</p>
              </div>
            ))}
          </div>
        </section>
      )}
    </PublicShell>
  )
}

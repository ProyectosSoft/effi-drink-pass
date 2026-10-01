-- ═══════════════════════════════════════════════════════════════════════════
-- Desactiva los asistentes DEMO antes de la operación real.
-- Los beneficios/consumos NO se borran (historial inmutable por diseño):
-- se cancelan los beneficios pendientes y se desactivan los asistentes.
-- ═══════════════════════════════════════════════════════════════════════════
update public.benefits b set status = 'CANCELLED', cancelled_at = now(), cancel_reason = 'Datos demo retirados'
  from public.attendees a
 where a.id = b.attendee_id and a.is_demo and b.status in ('PENDING', 'EXPIRED');

update public.attendees set activo = false where is_demo;

select count(*) as asistentes_demo_desactivados from public.attendees where is_demo and not activo;

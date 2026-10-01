-- ═══════════════════════════════════════════════════════════════════════════
-- SOLO PRUEBAS / STAGING: muestra los tokens QR de los asistentes DEMO (is_demo = true)
-- para probar el scanner o la API desde Postman (variable qr_token).
-- Ejecutar en el SQL Editor como postgres. Nunca exponga tokens de asistentes reales.
-- ═══════════════════════════════════════════════════════════════════════════
select a.nombres || ' ' || a.apellidos as asistente,
       d.date                          as dia,
       b.id                            as benefit_id,
       b.status,
       private.benefit_token(b.id, b.token_salt) as qr_token
from public.benefits b
join public.attendees a on a.id = b.attendee_id and a.is_demo
join public.event_days d on d.id = b.event_day_id
order by d.date, a.apellidos;

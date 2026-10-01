-- ═══════════════════════════════════════════════════════════════════════════
-- DATOS DE DEMOSTRACIÓN — SOLO DESARROLLO LOCAL (`supabase start` / `supabase db reset`).
-- NO ejecutar en producción. Todo asistente demo tiene is_demo = true y email @demo.invalid
-- (dominio reservado que nunca recibe correo real).
-- Las fechas del evento son de EJEMPLO: ajústelas en /admin/settings al calendario oficial.
-- ═══════════════════════════════════════════════════════════════════════════

insert into public.event_days (date, name, start_time, end_time) values
  ('2026-10-15', 'Día 1 (EJEMPLO)', '08:00', '20:00'),
  ('2026-10-16', 'Día 2 (EJEMPLO)', '08:00', '20:00'),
  ('2026-10-17', 'Día 3 (EJEMPLO)', '08:00', '20:00'),
  ('2026-10-18', 'Día 4 (EJEMPLO)', '08:00', '20:00'),
  ('2026-10-19', 'Día 5 (EJEMPLO)', '08:00', '18:00')
on conflict (date) do nothing;

insert into public.attendees (nombres, apellidos, email, effi_id, effi_username, tipo_acceso, empresa, is_demo, metadata) values
  ('Demo Juan',   'Pérez',  'juan.perez@demo.invalid',  'DEMO-123456', 'demo.juan',  'VIP',     'Empresa Demo SAS', true, '{"origen":"seed"}'),
  ('Demo María',  'Gómez',  'maria.gomez@demo.invalid', 'DEMO-223344', 'demo.maria', 'GENERAL', 'Comercial Demo',   true, '{"origen":"seed"}'),
  ('Demo Carlos', 'Ruiz',   'carlos.ruiz@demo.invalid', null,          null,         'EXPOSITOR','Stand Demo 12',   true, '{"origen":"seed","nota":"sin ID Effi"}')
on conflict do nothing;

-- Elegibilidad: todos los días para Juan y María; solo días 2 y 3 para Carlos.
-- Los beneficios (y sus QR) se generan automáticamente por trigger.
insert into public.attendee_event_days (attendee_id, event_day_id)
select a.id, d.id from public.attendees a cross join public.event_days d
where a.is_demo and (a.effi_username in ('demo.juan', 'demo.maria') or (a.email = 'carlos.ruiz@demo.invalid' and d.date in ('2026-10-16', '2026-10-17')))
on conflict do nothing;

-- Historial de consulta: conserva las fuentes y sus políticas RLS.
create view public.consumption_history with (security_invoker = true) as
select c.id, 'individual'::text as source, c.attendee_id, c.event_day_id,
       c.consumed_at as recorded_at, c.event_date, c.effi_id,
       btrim(coalesce(c.nombres, '') || ' ' || coalesce(c.apellidos, '')) as display_name,
       1::integer as quantity, c.operator_label,
       case when c.integration_id is not null then 'API' else 'QR' end as channel,
       case when c.is_override then c.override_reason else null end as reason
from public.consumption_details c
where public.has_permission('consumptions:read')
union all
select x.id, 'company'::text, null::uuid, p.event_day_id,
       x.delivered_at, d.date, c.effi_id, c.name, x.quantity, x.operator_label,
       case when x.is_manual then 'Manual' else 'QR' end, x.manual_reason
from public.company_drink_deliveries x
join public.company_drink_days p on p.id = x.company_day_id
join public.drink_companies c on c.id = p.company_id
join public.event_days d on d.id = p.event_day_id
where public.has_permission('consumptions:read');
revoke all on public.consumption_history from public, anon, authenticated;
grant select on public.consumption_history to authenticated;

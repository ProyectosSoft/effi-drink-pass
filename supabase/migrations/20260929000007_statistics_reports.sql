-- ═══════════════════════════════════════════════════════════════════════════
-- EFFI DRINK PASS · 0007 · Estadísticas, reportes y vistas de lectura
-- ═══════════════════════════════════════════════════════════════════════════

-- Filtros admitidos (todos opcionales):
--   event_day_id, date_from, date_to (fecha Bogotá del consumo), operator_id,
--   status (PENDING|CONSUMED|EXPIRED|CANCELLED, estado efectivo), effi_id,
--   effi_username, empresa (contiene), tipo_acceso
create or replace function private.statistics(p_filters jsonb)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  f        jsonb := coalesce(p_filters, '{}'::jsonb);
  v_day    uuid := nullif(f ->> 'event_day_id', '')::uuid;
  v_from   date := nullif(f ->> 'date_from', '')::date;
  v_to     date := nullif(f ->> 'date_to', '')::date;
  v_op     uuid := nullif(f ->> 'operator_id', '')::uuid;
  v_status text := upper(nullif(f ->> 'status', ''));
  v_effi   text := nullif(btrim(f ->> 'effi_id'), '');
  v_user   text := nullif(lower(btrim(f ->> 'effi_username')), '');
  v_emp    text := nullif(lower(btrim(f ->> 'empresa')), '');
  v_tipo   text := nullif(upper(btrim(f ->> 'tipo_acceso')), '');
  v_now    timestamptz := private.app_now();
  v_today  date := private.bogota_today();
  v_result jsonb;
begin
  with fa as (
    select a.* from public.attendees a
    where (v_effi is null or a.effi_id = v_effi)
      and (v_user is null or lower(a.effi_username) = v_user)
      and (v_emp is null or lower(a.empresa) like '%' || v_emp || '%')
      and (v_tipo is null or a.tipo_acceso = v_tipo)
  ),
  fb as (
    select * from (
      select b.id, b.attendee_id, b.event_day_id, b.status, fa.tipo_acceso,
             private.effective_status(b.status, b.expiration_at) as eff_status
      from public.benefits b join fa on fa.id = b.attendee_id
      where (v_day is null or b.event_day_id = v_day)
    ) x where v_status is null or x.eff_status = v_status
  ),
  fc as (
    select c.*, fb.tipo_acceso, (c.consumed_at at time zone 'America/Bogota') as local_ts
    from public.consumptions c join fb on fb.id = c.benefit_id
    where (v_from is null or (c.consumed_at at time zone 'America/Bogota')::date >= v_from)
      and (v_to is null or (c.consumed_at at time zone 'America/Bogota')::date <= v_to)
      and (v_op is null or c.operator_id = v_op)
  )
  select jsonb_build_object(
    'generated_at', v_now,
    'today', v_today,
    'filters', f,
    'totals', jsonb_build_object(
      'attendees',          (select count(*) from fa where fa.activo),
      'attendees_inactive', (select count(*) from fa where not fa.activo),
      'eligible_attendees', (select count(distinct aed.attendee_id) from public.attendee_event_days aed
                              join fa on fa.id = aed.attendee_id and fa.activo
                              where aed.eligible and (v_day is null or aed.event_day_id = v_day)),
      'benefits',           (select count(*) from fb),
      'consumed',           (select count(*) from fb where eff_status = 'CONSUMED'),
      'pending',            (select count(*) from fb where eff_status = 'PENDING'),
      'expired',            (select count(*) from fb where eff_status = 'EXPIRED'),
      'cancelled',          (select count(*) from fb where eff_status = 'CANCELLED'),
      'consumptions',       (select count(*) from fc),
      'consumed_today',     (select count(*) from fc where fc.local_ts::date = v_today)
    ),
    'by_day', coalesce((
      select jsonb_agg(jsonb_build_object(
               'event_day_id', d.id, 'date', d.date, 'name', d.name,
               'benefits', coalesce(s.total, 0), 'consumed', coalesce(s.consumed, 0),
               'pending', coalesce(s.pending, 0), 'expired', coalesce(s.expired, 0),
               'cancelled', coalesce(s.cancelled, 0)) order by d.date)
      from public.event_days d
      left join (
        select event_day_id, count(*) total,
               count(*) filter (where eff_status = 'CONSUMED') consumed,
               count(*) filter (where eff_status = 'PENDING') pending,
               count(*) filter (where eff_status = 'EXPIRED') expired,
               count(*) filter (where eff_status = 'CANCELLED') cancelled
        from fb group by event_day_id) s on s.event_day_id = d.id
      where v_day is null or d.id = v_day), '[]'::jsonb),
    'by_hour', coalesce((
      select jsonb_agg(jsonb_build_object('hour', h, 'count', coalesce(cnt, 0)) order by h)
      from generate_series(0, 23) h
      left join (select extract(hour from local_ts)::int hr, count(*) cnt from fc group by 1) x on x.hr = h), '[]'::jsonb),
    'by_operator', coalesce((
      select jsonb_agg(jsonb_build_object('operator_id', o.operator_id, 'integration_id', o.integration_id,
                                          'operator', o.label, 'count', o.cnt) order by o.cnt desc)
      from (
        select fc.operator_id, fc.integration_id,
               coalesce(nullif(btrim(p.nombres || ' ' || p.apellidos), ''), i.name, '—') label, count(*) cnt
        from fc
        left join public.profiles p on p.id = fc.operator_id
        left join public.api_integrations i on i.id = fc.integration_id
        group by 1, 2, 3) o), '[]'::jsonb),
    'by_access_type', coalesce((
      select jsonb_agg(jsonb_build_object('tipo_acceso', t.tipo_acceso, 'count', t.cnt) order by t.cnt desc)
      from (select tipo_acceso, count(*) cnt from fc group by 1) t), '[]'::jsonb),
    'by_date', coalesce((
      select jsonb_agg(jsonb_build_object('date', dt, 'count', cnt) order by dt)
      from (select local_ts::date dt, count(*) cnt from fc group by 1) z), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

create or replace function public.get_statistics(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform private.require_permission('statistics:read');
  return private.statistics(p_filters);
end;
$$;

create or replace function public.api_statistics(p_actor jsonb, p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform private.api_assert_scope(p_actor, 'statistics:read');
  return private.statistics(p_filters);
end;
$$;

-- ───────────────────────────── Reportes (CSV en el cliente) ─────────────────
-- p_kind: daily_consumptions | hourly_consumptions | operator_consumptions |
--         benefits_pending | benefits_consumed | benefits_expired | eligible_attendees
create or replace function public.get_report(p_kind text, p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  f      jsonb := coalesce(p_filters, '{}'::jsonb);
  v_day  uuid := nullif(f ->> 'event_day_id', '')::uuid;
  v_from date := nullif(f ->> 'date_from', '')::date;
  v_to   date := nullif(f ->> 'date_to', '')::date;
  v_rows jsonb;
begin
  perform private.require_permission('reports:read');

  if p_kind = 'daily_consumptions' then
    select coalesce(jsonb_agg(r order by r ->> 'fecha'), '[]'::jsonb) into v_rows from (
      select jsonb_build_object('fecha', (c.consumed_at at time zone 'America/Bogota')::date,
                                'dia_evento', d.name, 'consumos', count(*),
                                'excepciones', count(*) filter (where c.is_override)) r
      from public.consumptions c join public.event_days d on d.id = c.event_day_id
      where (v_day is null or c.event_day_id = v_day)
        and (v_from is null or (c.consumed_at at time zone 'America/Bogota')::date >= v_from)
        and (v_to is null or (c.consumed_at at time zone 'America/Bogota')::date <= v_to)
      group by (c.consumed_at at time zone 'America/Bogota')::date, d.name) q;
  elsif p_kind = 'hourly_consumptions' then
    select coalesce(jsonb_agg(r order by r ->> 'fecha', (r ->> 'hora')::int), '[]'::jsonb) into v_rows from (
      select jsonb_build_object('fecha', (c.consumed_at at time zone 'America/Bogota')::date,
                                'hora', extract(hour from c.consumed_at at time zone 'America/Bogota')::int,
                                'consumos', count(*)) r
      from public.consumptions c
      where (v_day is null or c.event_day_id = v_day)
        and (v_from is null or (c.consumed_at at time zone 'America/Bogota')::date >= v_from)
        and (v_to is null or (c.consumed_at at time zone 'America/Bogota')::date <= v_to)
      group by (c.consumed_at at time zone 'America/Bogota')::date,
               extract(hour from c.consumed_at at time zone 'America/Bogota')) q;
  elsif p_kind = 'operator_consumptions' then
    select coalesce(jsonb_agg(r order by r ->> 'fecha', r ->> 'operador'), '[]'::jsonb) into v_rows from (
      select jsonb_build_object(
               'fecha', (c.consumed_at at time zone 'America/Bogota')::date,
               'operador', coalesce(nullif(btrim(p.nombres || ' ' || p.apellidos), ''), i.name, '—'),
               'email_operador', p.email,
               'tipo', case when c.integration_id is not null then 'integración' else 'staff' end,
               'consumos', count(*)) r
      from public.consumptions c
      left join public.profiles p on p.id = c.operator_id
      left join public.api_integrations i on i.id = c.integration_id
      where (v_day is null or c.event_day_id = v_day)
        and (v_from is null or (c.consumed_at at time zone 'America/Bogota')::date >= v_from)
        and (v_to is null or (c.consumed_at at time zone 'America/Bogota')::date <= v_to)
      group by (c.consumed_at at time zone 'America/Bogota')::date, p.nombres, p.apellidos, p.email, i.name,
               c.integration_id is not null) q;
  elsif p_kind in ('benefits_pending', 'benefits_consumed', 'benefits_expired') then
    select coalesce(jsonb_agg(r order by r ->> 'fecha_dia', r ->> 'apellidos'), '[]'::jsonb) into v_rows from (
      select jsonb_build_object(
               'fecha_dia', d.date, 'dia', d.name,
               'nombres', a.nombres, 'apellidos', a.apellidos, 'email', a.email,
               'effi_id', a.effi_id, 'effi_username', a.effi_username,
               'tipo_acceso', a.tipo_acceso, 'empresa', a.empresa,
               'estado', private.effective_status(b.status, b.expiration_at),
               'consumido_en', to_char(b.consumed_at at time zone 'America/Bogota', 'YYYY-MM-DD HH24:MI:SS'),
               'operador', coalesce(nullif(btrim(p.nombres || ' ' || p.apellidos), ''), i.name),
               'excepcion', c.is_override) r
      from public.benefits b
      join public.attendees a on a.id = b.attendee_id
      join public.event_days d on d.id = b.event_day_id
      left join public.consumptions c on c.benefit_id = b.id
      left join public.profiles p on p.id = c.operator_id
      left join public.api_integrations i on i.id = c.integration_id
      where (v_day is null or b.event_day_id = v_day)
        and private.effective_status(b.status, b.expiration_at) = upper(split_part(p_kind, '_', 2))
      limit 100000) q;
  elsif p_kind = 'eligible_attendees' then
    select coalesce(jsonb_agg(r order by r ->> 'apellidos', r ->> 'nombres'), '[]'::jsonb) into v_rows from (
      select jsonb_build_object(
               'nombres', a.nombres, 'apellidos', a.apellidos, 'email', a.email, 'telefono', a.telefono,
               'effi_id', a.effi_id, 'effi_username', a.effi_username,
               'tipo_acceso', a.tipo_acceso, 'empresa', a.empresa,
               'dias_elegibles', string_agg(to_char(d.date, 'YYYY-MM-DD'), ' | ' order by d.date),
               'cuenta_vinculada', a.auth_user_id is not null) r
      from public.attendees a
      join public.attendee_event_days aed on aed.attendee_id = a.id and aed.eligible
      join public.event_days d on d.id = aed.event_day_id
      where a.activo and (v_day is null or aed.event_day_id = v_day)
      group by a.id
      limit 100000) q;
  else
    raise exception using errcode = '22023', message = 'UNKNOWN_REPORT';
  end if;

  return v_rows;
end;
$$;

-- ───────────────────────────── Vistas de lectura (respetan RLS del invocador) ─
create view public.consumption_details with (security_invoker = true) as
select c.id, c.benefit_id, c.attendee_id, c.event_day_id, c.operator_id, c.integration_id,
       c.consumed_at, c.is_override, c.override_reason, c.metadata,
       a.nombres, a.apellidos, a.effi_id, a.effi_username, a.tipo_acceso, a.empresa,
       d.date as event_date, d.name as event_day_name,
       coalesce(c.operator_label, nullif(btrim(p.nombres || ' ' || p.apellidos), ''), i.name) as operator_label
from public.consumptions c
left join public.attendees a on a.id = c.attendee_id
left join public.event_days d on d.id = c.event_day_id
left join public.profiles p on p.id = c.operator_id
left join public.api_integrations i on i.id = c.integration_id;

create view public.benefit_details with (security_invoker = true) as
select b.id, b.attendee_id, b.event_day_id, b.status,
       case when b.status = 'PENDING' and now() >= b.expiration_at then 'EXPIRED' else b.status::text end as effective_status,
       b.generated_at, b.consumed_at, b.consumed_by, b.consumed_by_integration, b.expiration_at,
       b.cancelled_at, b.cancel_reason, b.updated_at,
       a.nombres, a.apellidos, a.email, a.effi_id, a.effi_username, a.tipo_acceso, a.empresa, a.activo as attendee_activo,
       d.date as event_date, d.name as event_day_name
from public.benefits b
join public.attendees a on a.id = b.attendee_id
join public.event_days d on d.id = b.event_day_id;

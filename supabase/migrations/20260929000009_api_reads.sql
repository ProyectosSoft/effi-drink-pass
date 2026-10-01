-- ═══════════════════════════════════════════════════════════════════════════
-- EFFI DRINK PASS · 0009 · Lecturas de la API pública v1 (solo service_role)
-- Representaciones estables del contrato /api/v1 (ver docs/openapi.yaml).
-- Nunca se exponen token_hash, token_salt, credential_hash ni auth_user_id.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function private.api_attendee_json(a public.attendees, p_with_days boolean default false)
returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', a.id, 'nombres', a.nombres, 'apellidos', a.apellidos, 'email', a.email, 'telefono', a.telefono,
    'effi_id', a.effi_id, 'effi_username', a.effi_username, 'tipo_acceso', a.tipo_acceso, 'empresa', a.empresa,
    'activo', a.activo, 'metadata', a.metadata, 'has_account', a.auth_user_id is not null,
    'created_at', a.created_at, 'updated_at', a.updated_at)
  || case when p_with_days then jsonb_build_object('event_days', coalesce((
       select jsonb_agg(jsonb_build_object('event_day_id', d.id, 'date', d.date, 'name', d.name, 'eligible', aed.eligible)
                        order by d.date)
       from public.attendee_event_days aed join public.event_days d on d.id = aed.event_day_id
       where aed.attendee_id = a.id), '[]'::jsonb)) else '{}'::jsonb end
$$;

create or replace function private.api_benefit_json(b public.benefits)
returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', b.id, 'attendee_id', b.attendee_id,
    'event_day', (select jsonb_build_object('id', d.id, 'date', d.date, 'name', d.name,
                                            'start_time', d.start_time, 'end_time', d.end_time)
                  from public.event_days d where d.id = b.event_day_id),
    'status', b.status,
    'effective_status', private.effective_status(b.status, b.expiration_at),
    'generated_at', b.generated_at, 'expiration_at', b.expiration_at,
    'consumed_at', b.consumed_at, 'cancelled_at', b.cancelled_at, 'cancel_reason', b.cancel_reason,
    'updated_at', b.updated_at)
$$;

create or replace function private.api_consumption_json(c public.consumptions)
returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', c.id, 'benefit_id', c.benefit_id, 'attendee_id', c.attendee_id, 'event_day_id', c.event_day_id,
    'event_date', (select d.date from public.event_days d where d.id = c.event_day_id),
    'consumed_at', c.consumed_at,
    'operator', jsonb_build_object(
       'type', case when c.integration_id is not null then 'integration' else 'staff' end,
       'id', coalesce(c.operator_id, c.integration_id), 'label', c.operator_label),
    'is_override', c.is_override, 'override_reason', c.override_reason, 'metadata', c.metadata,
    'created_at', c.created_at)
$$;

create or replace function private.page_meta(p_page int, p_size int, p_total bigint)
returns jsonb
language sql immutable
set search_path = ''
as $$
  select jsonb_build_object('page', p_page, 'page_size', p_size, 'total', p_total,
                            'total_pages', greatest(ceil(p_total::numeric / p_size)::int, 1))
$$;

create or replace function private.clamp_page(p_page int, p_size int)
returns int[]
language sql immutable
set search_path = ''
as $$ select array[greatest(coalesce(p_page, 1), 1), least(greatest(coalesce(p_size, 50), 1), 200)] $$;

-- ───────────────────────────── Event days ───────────────────────────────────
create or replace function private.api_event_day_json(d public.event_days)
returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object('id', d.id, 'date', d.date, 'name', d.name, 'active', d.active,
                            'start_time', d.start_time, 'end_time', d.end_time,
                            'is_today', d.date = private.bogota_today())
$$;

create or replace function public.api_list_event_days(p_actor jsonb)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform private.api_assert_scope(p_actor, 'event-days:read');
  return jsonb_build_object('data', coalesce((
    select jsonb_agg(private.api_event_day_json(d) order by d.date) from public.event_days d), '[]'::jsonb));
end;
$$;

create or replace function public.api_get_event_day(p_actor jsonb, p_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v public.event_days;
begin
  perform private.api_assert_scope(p_actor, 'event-days:read');
  select * into v from public.event_days where id = p_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  return jsonb_build_object('data', private.api_event_day_json(v));
end;
$$;

-- ───────────────────────────── Attendees ────────────────────────────────────
-- Filtros: effi_id, effi_username, email (exactos), q (nombre/empresa contiene),
--          tipo_acceso, empresa, activo, event_day_id (elegible ese día), updated_since
create or replace function public.api_list_attendees(p_actor jsonb, p_filters jsonb, p_page int, p_page_size int)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  f       jsonb := coalesce(p_filters, '{}'::jsonb);
  v_pg    int[] := private.clamp_page(p_page, p_page_size);
  v_q     text := nullif(lower(btrim(f ->> 'q')), '');
  v_total bigint;
  v_data  jsonb;
begin
  perform private.api_assert_scope(p_actor, 'attendees:read');
  with fa as (
    select a.id, row_number() over (order by a.apellidos, a.nombres, a.id) as ord
    from public.attendees a
    where (f ->> 'effi_id' is null or a.effi_id = f ->> 'effi_id')
      and (f ->> 'effi_username' is null or lower(a.effi_username) = lower(f ->> 'effi_username'))
      and (f ->> 'email' is null or lower(a.email) = lower(f ->> 'email'))
      and (f ->> 'tipo_acceso' is null or a.tipo_acceso = upper(f ->> 'tipo_acceso'))
      and (f ->> 'empresa' is null or lower(a.empresa) like '%' || lower(f ->> 'empresa') || '%')
      and (f ->> 'activo' is null or a.activo = (f ->> 'activo')::boolean)
      and (f ->> 'updated_since' is null or a.updated_at >= (f ->> 'updated_since')::timestamptz)
      and (f ->> 'event_day_id' is null or exists (
            select 1 from public.attendee_event_days aed
            where aed.attendee_id = a.id and aed.eligible and aed.event_day_id = (f ->> 'event_day_id')::uuid))
      and (v_q is null or lower(a.nombres || ' ' || a.apellidos) like '%' || v_q || '%'
                       or lower(coalesce(a.empresa, '')) like '%' || v_q || '%')
  )
  select (select count(*) from fa),
         coalesce((select jsonb_agg(private.api_attendee_json(a) order by fa.ord)
                   from fa join public.attendees a on a.id = fa.id
                   where fa.ord > (v_pg[1] - 1) * v_pg[2] and fa.ord <= v_pg[1] * v_pg[2]), '[]'::jsonb)
    into v_total, v_data;
  return jsonb_build_object('data', v_data, 'meta', private.page_meta(v_pg[1], v_pg[2], v_total));
end;
$$;

create or replace function public.api_get_attendee(p_actor jsonb, p_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v public.attendees;
begin
  perform private.api_assert_scope(p_actor, 'attendees:read');
  select * into v from public.attendees where id = p_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  return jsonb_build_object('data', private.api_attendee_json(v, true));
end;
$$;

-- ───────────────────────────── Benefits ─────────────────────────────────────
-- Filtros: attendee_id, event_day_id, date, status (estado efectivo), effi_id
create or replace function public.api_list_benefits(p_actor jsonb, p_filters jsonb, p_page int, p_page_size int)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  f       jsonb := coalesce(p_filters, '{}'::jsonb);
  v_pg    int[] := private.clamp_page(p_page, p_page_size);
  v_total bigint;
  v_data  jsonb;
begin
  perform private.api_assert_scope(p_actor, 'benefits:read');
  with fb as (
    select b.id, row_number() over (order by d.date, b.created_at, b.id) as ord
    from public.benefits b
    join public.event_days d on d.id = b.event_day_id
    join public.attendees a on a.id = b.attendee_id
    where (f ->> 'attendee_id' is null or b.attendee_id = (f ->> 'attendee_id')::uuid)
      and (f ->> 'event_day_id' is null or b.event_day_id = (f ->> 'event_day_id')::uuid)
      and (f ->> 'date' is null or d.date = (f ->> 'date')::date)
      and (f ->> 'effi_id' is null or a.effi_id = f ->> 'effi_id')
      and (f ->> 'status' is null or private.effective_status(b.status, b.expiration_at) = upper(f ->> 'status'))
  )
  select (select count(*) from fb),
         coalesce((select jsonb_agg(private.api_benefit_json(b) order by fb.ord)
                   from fb join public.benefits b on b.id = fb.id
                   where fb.ord > (v_pg[1] - 1) * v_pg[2] and fb.ord <= v_pg[1] * v_pg[2]), '[]'::jsonb)
    into v_total, v_data;
  return jsonb_build_object('data', v_data, 'meta', private.page_meta(v_pg[1], v_pg[2], v_total));
end;
$$;

create or replace function public.api_get_benefit(p_actor jsonb, p_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v public.benefits;
begin
  perform private.api_assert_scope(p_actor, 'benefits:read');
  select * into v from public.benefits where id = p_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  return jsonb_build_object('data', private.api_benefit_json(v) || jsonb_build_object(
    'consumption', (select private.api_consumption_json(c) from public.consumptions c where c.benefit_id = v.id)));
end;
$$;

create or replace function public.api_attendee_benefits(p_actor jsonb, p_attendee_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform private.api_assert_scope(p_actor, 'benefits:read');
  if not exists (select 1 from public.attendees where id = p_attendee_id) then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  return jsonb_build_object('data', coalesce((
    select jsonb_agg(private.api_benefit_json(b) order by d.date)
    from public.benefits b join public.event_days d on d.id = b.event_day_id
    where b.attendee_id = p_attendee_id), '[]'::jsonb));
end;
$$;

-- ───────────────────────────── Consumptions ─────────────────────────────────
-- Filtros: attendee_id, event_day_id, operator_id, integration_id, effi_id, from, to (timestamps ISO)
create or replace function public.api_list_consumptions(p_actor jsonb, p_filters jsonb, p_page int, p_page_size int)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  f       jsonb := coalesce(p_filters, '{}'::jsonb);
  v_pg    int[] := private.clamp_page(p_page, p_page_size);
  v_total bigint;
  v_data  jsonb;
begin
  perform private.api_assert_scope(p_actor, 'consumptions:read');
  with fc as (
    select c.id, row_number() over (order by c.consumed_at desc, c.id) as ord
    from public.consumptions c
    join public.attendees a on a.id = c.attendee_id
    where (f ->> 'attendee_id' is null or c.attendee_id = (f ->> 'attendee_id')::uuid)
      and (f ->> 'event_day_id' is null or c.event_day_id = (f ->> 'event_day_id')::uuid)
      and (f ->> 'operator_id' is null or c.operator_id = (f ->> 'operator_id')::uuid)
      and (f ->> 'integration_id' is null or c.integration_id = (f ->> 'integration_id')::uuid)
      and (f ->> 'effi_id' is null or a.effi_id = f ->> 'effi_id')
      and (f ->> 'from' is null or c.consumed_at >= (f ->> 'from')::timestamptz)
      and (f ->> 'to' is null or c.consumed_at < (f ->> 'to')::timestamptz)
  )
  select (select count(*) from fc),
         coalesce((select jsonb_agg(private.api_consumption_json(c) order by fc.ord)
                   from fc join public.consumptions c on c.id = fc.id
                   where fc.ord > (v_pg[1] - 1) * v_pg[2] and fc.ord <= v_pg[1] * v_pg[2]), '[]'::jsonb)
    into v_total, v_data;
  return jsonb_build_object('data', v_data, 'meta', private.page_meta(v_pg[1], v_pg[2], v_total));
end;
$$;

create or replace function public.api_get_consumption(p_actor jsonb, p_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v public.consumptions;
begin
  perform private.api_assert_scope(p_actor, 'consumptions:read');
  select * into v from public.consumptions where id = p_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  return jsonb_build_object('data', private.api_consumption_json(v));
end;
$$;

-- ───────────────────────────── Privilegios ──────────────────────────────────
-- Las funciones api_* solo para service_role; las privadas para nadie.
-- (Las default privileges por esquema no pueden quitar el EXECUTE global de PUBLIC,
--  por eso se revoca explícitamente.)
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig, n.nspname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname = 'public' and p.proname like 'api\_%') or n.nspname = 'private'
  loop
    execute format('revoke execute on function %s from public', r.sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke execute on function %s from anon, authenticated', r.sig);
    end if;
    if r.nspname = 'public' and exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', r.sig);
    end if;
  end loop;
end $$;

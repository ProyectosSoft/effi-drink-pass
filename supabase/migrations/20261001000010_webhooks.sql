-- ═══════════════════════════════════════════════════════════════════════════
-- EFFI DRINK PASS · 0010 · Webhooks salientes
-- Outbox (0001) → fan-out a suscripciones → entregas con reintentos.
-- La entrega la hace la Edge Function "webhooks" (programada); el consumo en
-- barra nunca espera a un tercero. Entrega at-least-once, firmada con HMAC.
-- ═══════════════════════════════════════════════════════════════════════════

create table public.webhook_subscriptions (
  id             uuid primary key default gen_random_uuid(),
  integration_id uuid not null references public.api_integrations (id) on delete restrict,
  url            text not null check (url ~ '^https://[^\s/?#]+' and length(url) <= 500),
  events         text[] not null check (cardinality(events) > 0 and events <@ array['benefit.consumed']),
  description    text check (length(description) <= 300),
  active         boolean not null default true,
  secret_hint    text not null,
  created_by     uuid references public.profiles (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index webhook_subscriptions_integration_idx on public.webhook_subscriptions (integration_id);
create trigger webhook_subscriptions_touch before update on public.webhook_subscriptions
  for each row execute function private.touch_updated_at();

-- El secreto de firma debe poder leerse para firmar: vive en el esquema privado.
create table private.webhook_secrets (
  subscription_id uuid primary key references public.webhook_subscriptions (id) on delete cascade,
  secret          text not null
);

create table private.webhook_deliveries (
  id               bigint generated always as identity primary key,
  event_id         bigint not null references private.event_outbox (id),
  subscription_id  uuid not null references public.webhook_subscriptions (id) on delete cascade,
  status           text not null default 'pending' check (status in ('pending', 'sending', 'delivered', 'failed')),
  attempts         integer not null default 0,
  next_attempt_at  timestamptz not null default now(),
  locked_until     timestamptz,
  last_status_code integer,
  last_error       text,
  delivered_at     timestamptz,
  created_at       timestamptz not null default now(),
  unique (event_id, subscription_id)
);
create index webhook_deliveries_due_idx on private.webhook_deliveries (next_attempt_at)
  where status in ('pending', 'sending');
create index webhook_deliveries_sub_idx on private.webhook_deliveries (subscription_id, id desc);

-- Máximo de intentos y espera tras cada fallo (≈ 10 h en total).
create or replace function private.webhook_backoff(p_attempt int)
returns interval
language sql immutable
set search_path = ''
as $$
  select (array['30 seconds', '2 minutes', '10 minutes', '30 minutes', '1 hour', '3 hours', '6 hours']::interval[])
         [least(greatest(p_attempt, 1), 7)]
$$;

create or replace function private.webhook_max_attempts()
returns int language sql immutable set search_path = '' as $$ select 8 $$;

-- ───────────────────────────── Fan-out ──────────────────────────────────────
create or replace function private.webhooks_fan_out()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into private.webhook_deliveries (event_id, subscription_id)
  select new.id, s.id
  from public.webhook_subscriptions s
  join public.api_integrations i on i.id = s.integration_id and i.active
  where s.active and new.event_type = any (s.events)
  on conflict do nothing;
  update private.event_outbox set dispatched_at = now() where id = new.id;
  return null;
end;
$$;

create trigger event_outbox_fan_out after insert on private.event_outbox
  for each row execute function private.webhooks_fan_out();

-- ───────────────────────────── Administración (integrations:manage) ─────────
create or replace function private.assert_webhook_allowed(p_integration_id uuid, p_url text)
returns void
language plpgsql stable
set search_path = ''
as $$
declare
  v_host text := lower(substring(p_url from '^https://([^/:?#]+)'));
begin
  if not exists (select 1 from public.api_integrations where id = p_integration_id) then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  -- El evento incluye datos de consumo: la integración debe poder leerlos.
  if not exists (select 1 from public.api_integrations where id = p_integration_id and 'consumptions:read' = any (allowed_scopes)) then
    raise exception using errcode = '22023', message = 'WEBHOOK_REQUIRES_CONSUMPTIONS_SCOPE';
  end if;
  -- Solo HTTPS hacia hosts públicos con nombre (sin IPs literales ni nombres internos).
  if v_host is null or p_url !~ '^https://'
     or v_host ~ '^[0-9.]+$' or v_host like '[%' or v_host in ('localhost')
     or v_host ~ '\.(local|internal|localhost|lan|home|corp)$' or position('.' in v_host) = 0 then
    raise exception using errcode = '22023', message = 'INVALID_WEBHOOK_URL';
  end if;
end;
$$;

create or replace function public.create_webhook_subscription(
  p_integration_id uuid, p_url text, p_events text[] default array['benefit.consumed'], p_description text default null
)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_secret text := 'whsec_' || private.random_token(32);
  v_id     uuid;
begin
  perform private.require_permission('integrations:manage');
  perform private.assert_webhook_allowed(p_integration_id, btrim(p_url));
  insert into public.webhook_subscriptions (integration_id, url, events, description, secret_hint, created_by)
  values (p_integration_id, btrim(p_url), p_events, nullif(btrim(p_description), ''), right(v_secret, 4), public.current_profile_id())
  returning id into v_id;
  insert into private.webhook_secrets (subscription_id, secret) values (v_id, v_secret);
  perform private.write_audit('CREATE_WEBHOOK', 'webhook_subscription', v_id::text, true,
    jsonb_build_object('integration_id', p_integration_id, 'url', p_url, 'events', to_jsonb(p_events)));
  -- El secreto se devuelve UNA sola vez.
  return jsonb_build_object('id', v_id, 'secret', v_secret);
end;
$$;

create or replace function public.update_webhook_subscription(
  p_id uuid, p_url text, p_events text[], p_description text, p_active boolean
)
returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_integration uuid;
begin
  perform private.require_permission('integrations:manage');
  select integration_id into v_integration from public.webhook_subscriptions where id = p_id for update;
  if v_integration is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  perform private.assert_webhook_allowed(v_integration, btrim(p_url));
  update public.webhook_subscriptions
     set url = btrim(p_url), events = p_events, description = nullif(btrim(p_description), ''), active = p_active
   where id = p_id;
  perform private.write_audit('UPDATE_WEBHOOK', 'webhook_subscription', p_id::text, true,
    jsonb_build_object('url', p_url, 'events', to_jsonb(p_events), 'active', p_active));
end;
$$;

create or replace function public.rotate_webhook_secret(p_id uuid)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_secret text := 'whsec_' || private.random_token(32);
begin
  perform private.require_permission('integrations:manage');
  update private.webhook_secrets set secret = v_secret where subscription_id = p_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  update public.webhook_subscriptions set secret_hint = right(v_secret, 4) where id = p_id;
  perform private.write_audit('ROTATE_WEBHOOK_SECRET', 'webhook_subscription', p_id::text, true, '{}'::jsonb);
  return jsonb_build_object('id', p_id, 'secret', v_secret);
end;
$$;

create or replace function public.list_webhook_deliveries(p_subscription_id uuid, p_limit int default 50)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform private.require_permission('integrations:manage');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', d.id, 'event_id', d.event_id, 'event_type', e.event_type, 'status', d.status, 'attempts', d.attempts,
      'next_attempt_at', d.next_attempt_at, 'last_status_code', d.last_status_code, 'last_error', d.last_error,
      'delivered_at', d.delivered_at, 'created_at', d.created_at) order by d.id desc)
    from (select * from private.webhook_deliveries where subscription_id = p_subscription_id
          order by id desc limit least(greatest(coalesce(p_limit, 50), 1), 200)) d
    join private.event_outbox e on e.id = d.event_id), '[]'::jsonb);
end;
$$;

create or replace function public.retry_webhook_delivery(p_delivery_id bigint)
returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  perform private.require_permission('integrations:manage');
  update private.webhook_deliveries
     set status = 'pending', next_attempt_at = now(), locked_until = null, attempts = 0
   where id = p_delivery_id and status = 'failed';
  if not found then
    raise exception using errcode = '23514', message = 'INVALID_STATUS_TRANSITION';
  end if;
  perform private.write_audit('RETRY_WEBHOOK_DELIVERY', 'webhook_delivery', p_delivery_id::text, true, '{}'::jsonb);
end;
$$;

-- ───────────────────────────── Despachador (solo service_role) ──────────────
-- Toma un lote de entregas vencidas con SKIP LOCKED (varios despachadores pueden
-- correr en paralelo sin duplicarse) y las arrienda por p_lease_seconds.
create or replace function public.webhooks_claim(p_limit int default 20, p_lease_seconds int default 60)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_rows jsonb;
begin
  with due as (
    select d.id
    from private.webhook_deliveries d
    join public.webhook_subscriptions s on s.id = d.subscription_id and s.active
    join public.api_integrations i on i.id = s.integration_id and i.active
    where d.status in ('pending', 'sending')
      and d.next_attempt_at <= now()
      and (d.locked_until is null or d.locked_until < now())
    order by d.next_attempt_at
    limit least(greatest(coalesce(p_limit, 20), 1), 100)
    for update of d skip locked
  ), claimed as (
    update private.webhook_deliveries d
       set status = 'sending', attempts = d.attempts + 1,
           locked_until = now() + make_interval(secs => greatest(p_lease_seconds, 10))
      from due where d.id = due.id
    returning d.id, d.event_id, d.subscription_id, d.attempts
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'delivery_id', c.id, 'attempt', c.attempts, 'url', s.url, 'secret', ws.secret,
           'event_id', e.id, 'event_type', e.event_type, 'occurred_at', e.occurred_at, 'payload', e.payload)
         order by c.id), '[]'::jsonb)
    into v_rows
  from claimed c
  join public.webhook_subscriptions s on s.id = c.subscription_id
  join private.webhook_secrets ws on ws.subscription_id = s.id
  join private.event_outbox e on e.id = c.event_id;
  return v_rows;
end;
$$;

create or replace function public.webhooks_report(p_delivery_id bigint, p_ok boolean, p_status_code int, p_error text)
returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_attempts int;
  v_status   text;
begin
  select attempts into v_attempts from private.webhook_deliveries where id = p_delivery_id for update;
  if v_attempts is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  v_status := case when p_ok then 'delivered'
                   when v_attempts >= private.webhook_max_attempts() then 'failed'
                   else 'pending' end;
  update private.webhook_deliveries
     set status = v_status,
         locked_until = null,
         last_status_code = p_status_code,
         last_error = case when p_ok then null else left(p_error, 500) end,
         delivered_at = case when p_ok then now() else delivered_at end,
         next_attempt_at = case when v_status = 'pending' then now() + private.webhook_backoff(v_attempts) else next_attempt_at end
   where id = p_delivery_id;
  return v_status;
end;
$$;

-- ───────────────────────────── RLS y privilegios ────────────────────────────
alter table public.webhook_subscriptions enable row level security;
create policy webhook_subscriptions_select on public.webhook_subscriptions for select to authenticated
  using ((select public.has_permission('integrations:manage')));

revoke all on public.webhook_subscriptions from anon, authenticated;
grant select on public.webhook_subscriptions to authenticated;
grant all on public.webhook_subscriptions to service_role;

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig, n.nspname, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname = 'public' and p.proname in ('create_webhook_subscription', 'update_webhook_subscription',
             'rotate_webhook_secret', 'list_webhook_deliveries', 'retry_webhook_delivery', 'webhooks_claim', 'webhooks_report'))
       or (n.nspname = 'private' and p.proname in ('webhook_backoff', 'webhook_max_attempts', 'webhooks_fan_out', 'assert_webhook_allowed'))
  loop
    execute format('revoke execute on function %s from public', r.sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke execute on function %s from anon, authenticated', r.sig);
    end if;
    if r.nspname = 'public' and r.proname not like 'webhooks\_%' and exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('grant execute on function %s to authenticated', r.sig);
    end if;
    if r.nspname = 'public' and exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', r.sig);
    end if;
  end loop;
end $$;

-- Cupos por empresa y día, independientes de los pases individuales existentes.
create table public.drink_companies (
  id uuid primary key default gen_random_uuid(),
  effi_id text not null unique check (length(effi_id) between 1 and 64),
  name text not null check (length(name) between 1 and 200),
  email text check (length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  user_count integer not null default 1 check (user_count between 1 and 100000),
  active boolean not null default true,
  updated_at timestamptz not null default now()
);
create unique index drink_companies_email_uq on public.drink_companies(lower(email)) where email is not null;

create table public.company_drink_days (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.drink_companies(id) on delete restrict,
  event_day_id uuid not null references public.event_days(id) on delete restrict,
  quota integer not null check (quota between 1 and 100000),
  delivered integer not null default 0 check (delivered >= 0 and delivered <= quota),
  eligible boolean not null default true,
  token_salt text not null default private.random_token(16),
  token_hash text not null unique,
  unique (company_id, event_day_id)
);

create table public.company_drink_deliveries (
  id uuid primary key default gen_random_uuid(),
  company_day_id uuid not null references public.company_drink_days(id) on delete restrict,
  quantity integer not null check (quantity between 1 and 100000),
  operator_id uuid not null references public.profiles(id) on delete restrict,
  operator_label text not null,
  delivered_at timestamptz not null,
  idempotency_key text not null,
  unique (operator_id, idempotency_key)
);
create index company_drink_deliveries_day_idx on public.company_drink_deliveries(company_day_id, delivered_at);
create trigger company_drink_deliveries_immutable before update or delete on public.company_drink_deliveries
  for each row execute function private.forbid_mutation();
create trigger company_drink_deliveries_no_truncate before truncate on public.company_drink_deliveries
  for each statement execute function private.forbid_mutation();

alter table public.drink_companies enable row level security;
alter table public.company_drink_days enable row level security;
alter table public.company_drink_deliveries enable row level security;
create policy company_read on public.drink_companies for select to authenticated
  using (public.has_permission('attendees:read'));
create policy company_day_read on public.company_drink_days for select to authenticated
  using (public.has_permission('attendees:read'));
create policy company_delivery_read on public.company_drink_deliveries for select to authenticated
  using (public.has_permission('consumptions:read'));
revoke all on public.drink_companies, public.company_drink_days, public.company_drink_deliveries from public, anon, authenticated;
grant select on public.drink_companies to authenticated;
grant select (id, company_id, event_day_id, quota, delivered, eligible) on public.company_drink_days to authenticated;
grant select on public.company_drink_deliveries to authenticated;

create view public.company_drink_balances with (security_invoker = true) as
select p.id, p.company_id, p.event_day_id, c.effi_id, c.name, c.active,
       d.date, d.name as day_name, p.quota, p.delivered, p.quota - p.delivered as remaining, p.eligible
from public.company_drink_days p join public.drink_companies c on c.id = p.company_id
join public.event_days d on d.id = p.event_day_id;
revoke all on public.company_drink_balances from public, anon, authenticated;
grant select on public.company_drink_balances to authenticated;

-- Solo se ejecuta desde las RPC de administración/importación autorizadas.
create function private.save_drink_company(p_data jsonb, p_event_day_ids uuid[], p_dry_run boolean default false)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare
  v_company public.drink_companies;
  v_id text := btrim(coalesce(p_data ->> 'effi_id', ''));
  v_name text := btrim(coalesce(p_data ->> 'name', ''));
  v_email text := nullif(lower(btrim(p_data ->> 'email')), '');
  v_count_text text := coalesce(nullif(btrim(p_data ->> 'user_count'), ''), '1');
  v_count integer;
  v_active boolean;
  v_day uuid;
  v_pass_id uuid;
  v_salt text;
begin
  if jsonb_typeof(p_data) is distinct from 'object' or length(v_id) not between 1 and 64
     or length(v_name) not between 1 and 200 or v_count_text !~ '^[0-9]{1,6}$' then
    raise exception 'INVALID_COMPANY';
  end if;
  v_count := v_count_text::integer;
  if v_count not between 1 and 100000 or (v_email is not null and
      (length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')) then
    raise exception 'INVALID_COMPANY';
  end if;
  -- Misma secuencia de bloqueo que el canje: empresa y después pase diario.
  select * into v_company from public.drink_companies where effi_id = v_id for update;
  v_active := coalesce((p_data ->> 'active')::boolean, v_company.active, true);
  if not (p_data ? 'email') then v_email := v_company.email; end if;
  if exists (select 1 from public.drink_companies where lower(email) = v_email and effi_id <> v_id) then
    raise exception 'COMPANY_EMAIL_CONFLICT';
  end if;
  if exists (select 1 from public.company_drink_days p join public.event_days d on d.id = p.event_day_id
      where p.company_id = v_company.id and d.date >= private.bogota_today() and p.delivered > v_count) then
    raise exception 'QUOTA_BELOW_DELIVERED';
  end if;
  if p_event_day_ids is not null and exists (
      select 1 from unnest(p_event_day_ids) x where not exists (select 1 from public.event_days d where d.id = x)) then
    raise exception 'UNKNOWN_EVENT_DAY';
  end if;
  if p_dry_run then return v_company.id; end if;

  insert into public.drink_companies(effi_id, name, email, user_count, active)
  values (v_id, v_name, v_email, v_count, v_active)
  on conflict (effi_id) do update set name = excluded.name, email = excluded.email,
    user_count = excluded.user_count, active = excluded.active, updated_at = now()
  returning * into v_company;
  update public.company_drink_days p set quota = v_count from public.event_days d
    where p.company_id = v_company.id and p.event_day_id = d.id and d.date >= private.bogota_today();
  if p_event_day_ids is not null then
    update public.company_drink_days set eligible = event_day_id = any(p_event_day_ids) where company_id = v_company.id;
    foreach v_day in array p_event_day_ids loop
      v_pass_id := gen_random_uuid();
      v_salt := private.random_token(16);
      insert into public.company_drink_days(id, company_id, event_day_id, quota, token_salt, token_hash)
      values (v_pass_id, v_company.id, v_day, v_count, v_salt,
        private.hash_token(private.benefit_token(v_pass_id, 'company:' || v_salt)))
      on conflict (company_id, event_day_id) do update set eligible = true;
    end loop;
  end if;
  perform private.write_audit('UPSERT_DRINK_COMPANY', 'company', v_company.id::text, true,
    jsonb_build_object('effi_id', v_id, 'user_count', v_count, 'active', v_active, 'event_day_ids', p_event_day_ids));
  return v_company.id;
end;
$$;

create function public.upsert_drink_company(p_data jsonb, p_event_day_ids uuid[] default null)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_permission('attendees:write');
  return private.save_drink_company(p_data, p_event_day_ids);
end;
$$;
revoke all on function public.upsert_drink_company(jsonb, uuid[]) from public, anon, authenticated;
grant execute on function public.upsert_drink_company(jsonb, uuid[]) to authenticated;

create function public.import_drink_companies(p_rows jsonb, p_event_day_ids uuid[], p_dry_run boolean default true)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_row jsonb; v_n integer := 0;
begin
  perform private.require_permission('attendees:import');
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) not between 1 and 500 then
    raise exception 'INVALID_COMPANY_BATCH';
  end if;
  if (select count(*) <> count(distinct btrim(x ->> 'effi_id')) from jsonb_array_elements(p_rows) x) then
    raise exception 'DUPLICATE_COMPANY_ID';
  end if;
  if (select count(nullif(lower(btrim(x ->> 'email')), '')) <>
      count(distinct nullif(lower(btrim(x ->> 'email')), '')) from jsonb_array_elements(p_rows) x) then
    raise exception 'COMPANY_EMAIL_CONFLICT';
  end if;
  for v_row in select value from jsonb_array_elements(p_rows) order by value ->> 'effi_id' loop
    perform private.save_drink_company(v_row, p_event_day_ids, p_dry_run);
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('total', v_n, 'dry_run', p_dry_run);
end;
$$;
revoke all on function public.import_drink_companies(jsonb, uuid[], boolean) from public, anon, authenticated;
grant execute on function public.import_drink_companies(jsonb, uuid[], boolean) to authenticated;

-- Consulta interna sin consumo ni datos de contacto. El emisor del token no decide el cupo.
create function private.company_drink_snapshot(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  p public.company_drink_days; c public.drink_companies; d public.event_days;
  v_code text; v_now timestamptz := private.app_now();
begin
  select * into p from public.company_drink_days where id = p_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'INVALID_QR', 'server_time', v_now, 'benefit', null, 'attendee', null, 'consumption', null);
  end if;
  select * into c from public.drink_companies where id = p.company_id;
  select * into d from public.event_days where id = p.event_day_id;
  v_code := case
    when not c.active then 'COMPANY_INACTIVE'
    when not p.eligible then 'NOT_ELIGIBLE'
    when not d.active then 'DAY_INACTIVE'
    when d.date > private.bogota_today() then 'NOT_TODAY'
    when d.date < private.bogota_today() or v_now >= private.day_expiration(d.date, d.end_time) then 'EXPIRED'
    when (v_now at time zone 'America/Bogota')::time < d.start_time then 'NOT_STARTED'
    when p.delivered >= p.quota then 'QUOTA_EXHAUSTED'
    else 'VALID' end;
  return jsonb_build_object('ok', v_code = 'VALID', 'code', v_code, 'message', v_code,
    'server_time', v_now, 'kind', 'company', 'attendee', null, 'consumption', null,
    'company', jsonb_build_object('id', c.id, 'name', c.name, 'effi_id', c.effi_id,
      'quota', p.quota, 'delivered', p.delivered, 'remaining', p.quota - p.delivered),
    'benefit', jsonb_build_object('id', p.id, 'status', case when p.delivered >= p.quota then 'CONSUMED' else 'PENDING' end,
      'consumed_at', null, 'event_day', jsonb_build_object('id', d.id, 'date', d.date, 'name', d.name,
        'start_time', d.start_time, 'end_time', d.end_time)));
end;
$$;

create function public.lookup_company_drink_pass(p_kind text, p_identifier text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_company_id uuid; v_pass public.company_drink_days; v_result jsonb; v_rate jsonb;
begin
  v_rate := private.rate_limit_hit('public-company:' || coalesce(private.request_ip(), 'unknown'), 60, 60);
  if not (v_rate ->> 'allowed')::boolean then
    return jsonb_build_object('available', false, 'code', 'RATE_LIMITED');
  end if;
  if p_kind is null or p_kind not in ('email', 'effi_id') or length(btrim(p_identifier)) not between 1 and 254 then
    return jsonb_build_object('available', false, 'code', 'NOT_AVAILABLE');
  end if;
  if p_kind = 'email' then
    select id into v_company_id from public.drink_companies where lower(email) = lower(btrim(p_identifier));
  else
    select id into v_company_id from public.drink_companies where effi_id = btrim(p_identifier);
  end if;
  select p.* into v_pass from public.company_drink_days p join public.event_days d on d.id = p.event_day_id
    where p.company_id = v_company_id and d.date = private.bogota_today();
  if not found then return jsonb_build_object('available', false, 'code', 'NOT_AVAILABLE'); end if;
  v_result := private.company_drink_snapshot(v_pass.id);
  return jsonb_build_object('available', v_result ->> 'code' = 'VALID', 'code', v_result ->> 'code',
    'company', v_result -> 'company', 'event_day', v_result #> '{benefit,event_day}',
    'token', case when v_result ->> 'code' = 'VALID' then private.benefit_token(v_pass.id, 'company:' || v_pass.token_salt) else null end);
end;
$$;
revoke all on function public.lookup_company_drink_pass(text, text) from public, anon, authenticated;
grant execute on function public.lookup_company_drink_pass(text, text) to anon, authenticated;

create function public.drink_pass_validate(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_id uuid; v_rl jsonb;
begin
  if not (public.has_permission('benefits:validate') or public.has_permission('benefits:redeem')) then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  v_rl := private.staff_rate_limit();
  if not (v_rl ->> 'allowed')::boolean then return private.rate_limited_response(v_rl); end if;
  select id into v_id from public.company_drink_days where token_hash = private.hash_token(btrim(p_token));
  if found then return private.company_drink_snapshot(v_id); end if;
  return private.process_benefit('validate', p_token, null);
end;
$$;
revoke all on function public.drink_pass_validate(text) from public, anon, authenticated;
grant execute on function public.drink_pass_validate(text) to authenticated;

create function public.drink_pass_redeem(p_token text, p_quantity integer, p_idempotency_key text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_pass public.company_drink_days; v_company_id uuid; v_result jsonb; v_delivery public.company_drink_deliveries;
  v_actor jsonb; v_scope text; v_fingerprint text; v_idem record; v_rate jsonb;
begin
  perform private.require_permission('benefits:redeem');
  if p_quantity is null or p_quantity not between 1 and 100000 then raise exception 'INVALID_QUANTITY'; end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 8 and 255 then raise exception 'INVALID_IDEMPOTENCY_KEY'; end if;
  v_rate := private.staff_rate_limit();
  if not (v_rate ->> 'allowed')::boolean then return private.rate_limited_response(v_rate); end if;
  v_actor := private.actor();
  -- Espacio de claves independiente del canje individual; cantidad forma parte de la huella.
  v_scope := 'company:' || auth.uid()::text;
  v_fingerprint := private.sha256_hex(coalesce(btrim(p_token), '') || ':' || p_quantity::text);
  delete from private.idempotency_keys where scope = v_scope and key = p_idempotency_key and expires_at < now();
  insert into private.idempotency_keys(scope, key, fingerprint) values (v_scope, p_idempotency_key, v_fingerprint)
    on conflict (scope, key) do nothing;
  if not found then
    select * into v_idem from private.idempotency_keys where scope = v_scope and key = p_idempotency_key;
    if v_idem.fingerprint <> v_fingerprint then
      return jsonb_build_object('ok', false, 'code', 'IDEMPOTENCY_KEY_REUSED', 'server_time', private.app_now(), 'benefit', null, 'attendee', null, 'consumption', null);
    end if;
    return v_idem.response || jsonb_build_object('idempotent_replay', true);
  end if;
  select * into v_pass from public.company_drink_days where token_hash = private.hash_token(btrim(p_token));
  if not found then
    -- Compatibilidad: los pases individuales siguen admitiendo exactamente una bebida.
    if p_quantity <> 1 then raise exception 'INDIVIDUAL_QUANTITY_ONE'; end if;
    v_result := private.process_benefit('redeem', p_token, null, p_idempotency_key);
  else
    v_company_id := v_pass.company_id;
    perform 1 from public.drink_companies where id = v_company_id for update;
    select * into v_pass from public.company_drink_days where id = v_pass.id for update;
    -- Estabilizar el horario durante la decisión y el descuento.
    perform 1 from public.event_days where id = v_pass.event_day_id for share;
    v_result := private.company_drink_snapshot(v_pass.id);
    if v_result ->> 'code' = 'VALID' then
      if p_quantity > v_pass.quota - v_pass.delivered then
        v_result := v_result || jsonb_build_object('ok', false, 'code', 'INSUFFICIENT_QUOTA', 'message', 'La cantidad supera el saldo disponible.');
      else
        update public.company_drink_days set delivered = delivered + p_quantity
          where id = v_pass.id and delivered + p_quantity <= quota returning * into v_pass;
        insert into public.company_drink_deliveries(company_day_id, quantity, operator_id, operator_label, delivered_at, idempotency_key)
        values (v_pass.id, p_quantity, (v_actor ->> 'profile_id')::uuid,
          coalesce(v_actor ->> 'label', 'Operador'), private.app_now(), p_idempotency_key) returning * into v_delivery;
        v_result := private.company_drink_snapshot(v_pass.id) || jsonb_build_object('ok', true, 'code', 'APPROVED',
          'message', 'Entrega registrada', 'quantity', p_quantity, 'consumption', jsonb_build_object(
            'id', v_delivery.id, 'consumed_at', v_delivery.delivered_at, 'operator', v_delivery.operator_label,
            'is_override', false, 'quantity', p_quantity));
      end if;
    end if;
    perform private.write_audit('COMPANY_DRINK_DELIVERY', 'company_day', v_pass.id::text,
      v_result ->> 'code' = 'APPROVED', jsonb_build_object('quantity', p_quantity, 'code', v_result ->> 'code',
        'company_id', v_company_id, 'idempotency_key', p_idempotency_key));
  end if;
  update private.idempotency_keys set response = v_result where scope = v_scope and key = p_idempotency_key;
  return v_result;
end;
$$;
revoke all on function public.drink_pass_redeem(text, integer, text) from public, anon, authenticated;
grant execute on function public.drink_pass_redeem(text, integer, text) to authenticated;

revoke all on function private.save_drink_company(jsonb, uuid[], boolean) from public, anon, authenticated;
revoke all on function private.company_drink_snapshot(uuid) from public, anon, authenticated;

create function public.get_company_drink_statistics()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_result jsonb;
begin
  perform private.require_permission('statistics:read');
  select jsonb_build_object('date', private.bogota_today(),
    'companies', count(*), 'quota', coalesce(sum(p.quota), 0),
    'delivered', coalesce(sum(p.delivered), 0),
    'remaining', coalesce(sum(case when c.active and p.eligible and d.active then p.quota - p.delivered else 0 end), 0))
  into v_result from public.company_drink_days p join public.drink_companies c on c.id = p.company_id
    join public.event_days d on d.id = p.event_day_id where d.date = private.bogota_today();
  return v_result;
end;
$$;
revoke all on function public.get_company_drink_statistics() from public, anon, authenticated;
grant execute on function public.get_company_drink_statistics() to authenticated;

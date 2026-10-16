alter table public.drink_companies add column identification text check (length(identification) between 1 and 64);

create or replace function private.save_drink_company(p_data jsonb, p_event_day_ids uuid[], p_dry_run boolean default false)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare
  v_company public.drink_companies;
  v_id text := btrim(coalesce(p_data ->> 'effi_id', ''));
  v_name text := btrim(coalesce(p_data ->> 'name', ''));
  v_email text := nullif(lower(btrim(p_data ->> 'email')), '');
  v_count_text text := coalesce(nullif(btrim(p_data ->> 'user_count'), ''), '1');
  v_identification text := nullif(btrim(p_data ->> 'identification'), '');
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
  if v_identification is not null and (length(v_identification) > 64 or v_identification !~ '^[a-zA-Z0-9.[:space:]-]+$' or regexp_replace(v_identification, '[.[:space:]-]', '', 'g') = '') then
    raise exception 'INVALID_COMPANY';
  end if;
  -- Misma secuencia de bloqueo que el canje: empresa y después pase diario.
  select * into v_company from public.drink_companies where effi_id = v_id for update;
  v_active := coalesce((p_data ->> 'active')::boolean, v_company.active, true);
  if not (p_data ? 'identification') then v_identification := v_company.identification; end if;
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

  insert into public.drink_companies(effi_id, name, email, user_count, active, identification)
  values (v_id, v_name, v_email, v_count, v_active, v_identification)
  on conflict (effi_id) do update set identification = excluded.identification, name = excluded.name, email = excluded.email,
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

create or replace function public.lookup_company_drink_pass(p_kind text, p_identifier text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_company_id uuid; v_pass public.company_drink_days; v_result jsonb; v_rate jsonb; v_matches integer;
begin
  v_rate := private.rate_limit_hit('public-company:' || coalesce(private.request_ip(), 'unknown'), 60, 60);
  if not (v_rate ->> 'allowed')::boolean then
    return jsonb_build_object('available', false, 'code', 'RATE_LIMITED');
  end if;
  if p_kind is null or p_kind not in ('email', 'effi_id', 'name', 'identification') or length(btrim(p_identifier)) not between 1 and 254 then
    return jsonb_build_object('available', false, 'code', 'NOT_AVAILABLE');
  end if;
  if p_kind = 'email' then
    select id into v_company_id from public.drink_companies where lower(email) = lower(btrim(p_identifier));
  elsif p_kind in ('name', 'identification') then
    select count(*), (array_agg(id))[1] into v_matches, v_company_id
      from public.drink_companies
      where case when p_kind = 'name' then
        lower(regexp_replace(btrim(name), '[[:space:]]+', ' ', 'g')) = lower(regexp_replace(btrim(p_identifier), '[[:space:]]+', ' ', 'g'))
      else
        lower(regexp_replace(identification, '[.[:space:]-]', '', 'g')) = nullif(lower(regexp_replace(p_identifier, '[.[:space:]-]', '', 'g')), '')
      end;
    if v_matches > 1 then return jsonb_build_object('available', false, 'code', 'AMBIGUOUS_COMPANY'); end if;
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


-- ═══════════════════════════════════════════════════════════════════════════
-- EFFI DRINK PASS · 0004 · Beneficios, tokens QR, validación y consumo atómico
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────── Tokens QR ────────────────────────────────────
-- token = base64url( HMAC-SHA256( secreto_servidor, benefit_id || ':' || salt_aleatorio ) )
-- · 256 bits, impredecible sin el secreto, único por beneficio (y por rotación).
-- · En la base de datos solo existe sha256(token) → token_hash.
-- · El QR contiene únicamente el token (o una URL …/qr/<token>), nunca datos personales.
create or replace function private.benefit_token(p_benefit_id uuid, p_salt text)
returns text
language sql stable security definer
set search_path = ''
as $$
  select rtrim(translate(encode(extensions.hmac(
           convert_to(p_benefit_id::text || ':' || p_salt, 'UTF8'),
           convert_to((select s.value from private.secrets s where s.name = 'qr_hmac_secret'), 'UTF8'),
           'sha256'), 'base64'), E'+/\n', '-_'), '=')
$$;

create or replace function private.hash_token(p_token text)
returns text
language sql immutable
set search_path = ''
as $$ select private.sha256_hex(p_token) $$;

create or replace function private.is_token_format(p_token text)
returns boolean
language sql immutable
set search_path = ''
as $$ select p_token is not null and p_token ~ '^[A-Za-z0-9_-]{43}$' $$;

create or replace function private.day_expiration(p_date date, p_end time)
returns timestamptz
language sql immutable
set search_path = ''
as $$ select (p_date + p_end) at time zone 'America/Bogota' $$;

-- ───────────────────────────── Triggers de beneficios ───────────────────────
create or replace function private.benefits_before_insert()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_day public.event_days;
begin
  select * into v_day from public.event_days where id = new.event_day_id;
  if not found then
    raise exception using errcode = '23503', message = 'EVENT_DAY_NOT_FOUND';
  end if;
  new.status        := 'PENDING';
  new.consumed_at   := null;
  new.consumed_by   := null;
  new.token_salt    := encode(extensions.gen_random_bytes(16), 'hex');
  new.token_hash    := private.hash_token(private.benefit_token(new.id, new.token_salt));
  new.expiration_at := private.day_expiration(v_day.date, v_day.end_time);
  new.generated_at  := now();
  return new;
end;
$$;

create trigger benefits_before_insert before insert on public.benefits
  for each row execute function private.benefits_before_insert();

-- Máquina de estados: CONSUMED es terminal; attendee/día inmutables.
create or replace function private.benefits_state_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.attendee_id <> old.attendee_id or new.event_day_id <> old.event_day_id or new.id <> old.id then
    raise exception using errcode = '42501', message = 'BENEFIT_OWNER_IMMUTABLE';
  end if;

  if old.status = 'CONSUMED' then
    if new.status <> 'CONSUMED'
       or new.consumed_at is distinct from old.consumed_at
       or new.consumed_by is distinct from old.consumed_by
       or new.consumed_by_integration is distinct from old.consumed_by_integration
       or new.token_hash <> old.token_hash then
      raise exception using errcode = '23514', message = 'BENEFIT_ALREADY_CONSUMED';
    end if;
  end if;

  if new.status <> old.status and not (
       (old.status = 'PENDING'   and new.status in ('CONSUMED', 'EXPIRED', 'CANCELLED'))
    or (old.status = 'EXPIRED'   and new.status in ('CONSUMED', 'PENDING', 'CANCELLED'))
    or (old.status = 'CANCELLED' and new.status = 'PENDING')) then
    raise exception using errcode = '23514', message = 'INVALID_STATUS_TRANSITION',
      detail = format('%s → %s', old.status, new.status);
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger benefits_state_guard before update on public.benefits
  for each row execute function private.benefits_state_guard();
create trigger benefits_no_delete before delete on public.benefits
  for each row execute function private.forbid_mutation();

-- Mantener expiration_at sincronizado si cambia el horario del día.
create or replace function private.event_days_sync_expiration()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.date is distinct from old.date or new.end_time is distinct from old.end_time then
    update public.benefits
       set expiration_at = private.day_expiration(new.date, new.end_time)
     where event_day_id = new.id and status in ('PENDING', 'EXPIRED');
  end if;
  return new;
end;
$$;

create trigger event_days_sync_expiration after update on public.event_days
  for each row execute function private.event_days_sync_expiration();

-- Generación automática: al quedar elegible un asistente para un día, se crea su beneficio.
create or replace function private.attendee_days_generate_benefit()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.eligible then
    insert into public.benefits (attendee_id, event_day_id, token_hash, token_salt, expiration_at)
    values (new.attendee_id, new.event_day_id, 'pending', 'pending', now())
    on conflict (attendee_id, event_day_id) do nothing;
  end if;
  return new;
end;
$$;

create trigger attendee_event_days_generate after insert or update of eligible on public.attendee_event_days
  for each row execute function private.attendee_days_generate_benefit();

-- ───────────────────────────── Estado efectivo ──────────────────────────────
-- PENDING cuyo día ya terminó se considera EXPIRED aunque aún no se haya persistido.
create or replace function private.effective_status(p_status public.benefit_status, p_expiration timestamptz)
returns text
language sql stable
set search_path = ''
as $$
  select case when p_status = 'PENDING' and private.app_now() >= p_expiration then 'EXPIRED' else p_status::text end
$$;

create or replace function private.result_message(p_code text)
returns text
language sql immutable
set search_path = ''
as $$
  select case p_code
    when 'APPROVED'               then 'BENEFICIO APROBADO'
    when 'VALID'                  then 'QR VÁLIDO'
    when 'ALREADY_CONSUMED'       then 'BENEFICIO YA CONSUMIDO'
    when 'INVALID_QR'             then 'QR INVÁLIDO'
    when 'BENEFIT_NOT_FOUND'      then 'BENEFICIO NO ENCONTRADO'
    when 'NOT_TODAY'              then 'QR NO VÁLIDO PARA HOY'
    when 'NOT_STARTED'            then 'FUERA DE HORARIO'
    when 'NOT_ELIGIBLE'           then 'USUARIO NO ELEGIBLE'
    when 'ATTENDEE_INACTIVE'      then 'USUARIO INACTIVO'
    when 'EXPIRED'                then 'BENEFICIO EXPIRADO'
    when 'CANCELLED'              then 'BENEFICIO CANCELADO'
    when 'DAY_INACTIVE'           then 'DÍA NO HABILITADO'
    when 'RATE_LIMITED'           then 'DEMASIADOS INTENTOS'
    when 'IDEMPOTENCY_KEY_REUSED' then 'IDEMPOTENCY-KEY REUTILIZADA CON OTROS PARÁMETROS'
    else p_code
  end
$$;

-- ───────────────────────────── Núcleo: validar / consumir ───────────────────
-- ÚNICO punto del sistema que cambia un beneficio a CONSUMED.
-- Garantías contra doble consumo (defensa en profundidad):
--   1. SELECT … FOR UPDATE serializa a operadores concurrentes sobre la misma fila.
--   2. UPDATE … WHERE status = 'PENDING' (condicional) — solo una transacción lo logra.
--   3. UNIQUE(consumptions.benefit_id) — imposible insertar dos consumos.
--   4. Trigger de máquina de estados — CONSUMED es terminal.
-- El chequeo de permisos lo hace el llamador (funciones públicas / Edge Function).
create or replace function private.process_benefit(
  p_mode            text,               -- 'validate' | 'redeem'
  p_token           text,
  p_benefit_id      uuid,
  p_idempotency_key text default null,
  p_override_reason text default null,  -- no nulo = consumo excepcional (ya autorizado)
  p_metadata        jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_actor       jsonb := private.actor();
  v_now         timestamptz := private.app_now();
  v_today       date := (private.app_now() at time zone 'America/Bogota')::date;
  v_local_time  time := (private.app_now() at time zone 'America/Bogota')::time;
  v_override    boolean := p_override_reason is not null;
  v_scope       text;
  v_fingerprint text;
  v_idem        record;
  v_benefit_id  uuid;
  v_token_hash  text;
  v_benefit     public.benefits;
  v_att         public.attendees;
  v_day         public.event_days;
  v_eligible    boolean;
  v_code        text;
  v_consumption public.consumptions;
  v_cons_json   jsonb;
  v_result      jsonb;
  v_action      text;
begin
  if p_mode not in ('validate', 'redeem') then
    raise exception using errcode = '22023', message = 'INVALID_MODE';
  end if;
  if p_idempotency_key is not null and (length(p_idempotency_key) not between 8 and 255) then
    raise exception using errcode = '22023', message = 'INVALID_IDEMPOTENCY_KEY';
  end if;

  -- 1) Idempotencia (solo consumo). El INSERT bloquea a un duplicado concurrente
  --    hasta que la primera transacción termine; luego se devuelve su respuesta.
  if p_mode = 'redeem' and p_idempotency_key is not null then
    v_scope := coalesce(v_actor ->> 'credential_id', v_actor ->> 'profile_id', v_actor ->> 'auth_user_id', 'system');
    v_fingerprint := private.sha256_hex(concat_ws('|', p_mode, p_token, p_benefit_id::text, p_override_reason));
    delete from private.idempotency_keys where scope = v_scope and key = p_idempotency_key and expires_at < now();
    insert into private.idempotency_keys (scope, key, fingerprint)
    values (v_scope, p_idempotency_key, v_fingerprint)
    on conflict (scope, key) do nothing;
    if not found then
      select * into v_idem from private.idempotency_keys where scope = v_scope and key = p_idempotency_key;
      if v_idem.fingerprint <> v_fingerprint then
        return jsonb_build_object('ok', false, 'code', 'IDEMPOTENCY_KEY_REUSED',
          'message', private.result_message('IDEMPOTENCY_KEY_REUSED'), 'server_time', v_now);
      end if;
      return coalesce(v_idem.response, '{}'::jsonb) || jsonb_build_object('idempotent_replay', true);
    end if;
  end if;

  -- 2) Resolver el beneficio (por hash del token y/o por id).
  if p_token is not null then
    if private.is_token_format(btrim(p_token)) then
      v_token_hash := private.hash_token(btrim(p_token));
      select b.id into v_benefit_id from public.benefits b where b.token_hash = v_token_hash;
      if p_benefit_id is not null and v_benefit_id is distinct from p_benefit_id then
        v_benefit_id := null;
      end if;
    end if;
  else
    select b.id into v_benefit_id from public.benefits b where b.id = p_benefit_id;
  end if;

  if v_benefit_id is null then
    v_code := case when p_token is not null then 'INVALID_QR' else 'BENEFIT_NOT_FOUND' end;
  else
    -- 3) Bloqueo de la fila en consumo: los operadores concurrentes esperan aquí.
    if p_mode = 'redeem' then
      select * into v_benefit from public.benefits where id = v_benefit_id for update;
    else
      select * into v_benefit from public.benefits where id = v_benefit_id;
    end if;
    select * into v_att from public.attendees where id = v_benefit.attendee_id;
    select * into v_day from public.event_days where id = v_benefit.event_day_id;
    select coalesce((select aed.eligible from public.attendee_event_days aed
                      where aed.attendee_id = v_att.id and aed.event_day_id = v_day.id), false)
      into v_eligible;

    -- 4) Reglas de negocio (orden deliberado: el estado terminal informa primero).
    v_code := case
      when v_benefit.status = 'CONSUMED'  then 'ALREADY_CONSUMED'
      when v_benefit.status = 'CANCELLED' then 'CANCELLED'
      when not v_att.activo               then 'ATTENDEE_INACTIVE'
      when not v_eligible                 then 'NOT_ELIGIBLE'
      when v_override                     then 'OK'
      when not v_day.active               then 'DAY_INACTIVE'
      when v_day.date > v_today           then 'NOT_TODAY'
      when v_benefit.status = 'EXPIRED'
        or v_day.date < v_today
        or v_now >= private.day_expiration(v_day.date, v_day.end_time) then 'EXPIRED'
      when v_local_time < v_day.start_time then 'NOT_STARTED'
      else 'OK'
    end;

    if v_code = 'OK' then
      v_code := case when p_mode = 'validate' then 'VALID' else 'APPROVED' end;
    end if;

    -- 5) Consumo atómico.
    if v_code = 'APPROVED' then
      update public.benefits
         set status = 'CONSUMED',
             consumed_at = v_now,
             consumed_by = nullif(v_actor ->> 'profile_id', '')::uuid,
             consumed_by_integration = nullif(v_actor ->> 'integration_id', '')::uuid
       where id = v_benefit.id
         and (status = 'PENDING' or (v_override and status = 'EXPIRED'))
      returning * into v_benefit;

      if not found then
        v_code := 'ALREADY_CONSUMED';
        select * into v_benefit from public.benefits where id = v_benefit_id;
      else
        insert into public.consumptions (
          benefit_id, attendee_id, event_day_id, operator_id, integration_id, credential_id, operator_label,
          consumed_at, is_override, override_reason, metadata)
        values (
          v_benefit.id, v_benefit.attendee_id, v_benefit.event_day_id,
          nullif(v_actor ->> 'profile_id', '')::uuid,
          nullif(v_actor ->> 'integration_id', '')::uuid,
          nullif(v_actor ->> 'credential_id', '')::uuid,
          left(v_actor ->> 'label', 200),
          v_now, v_override, p_override_reason,
          coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('channel', coalesce(v_actor ->> 'channel', v_actor ->> 'type')))
        returning * into v_consumption;

        perform private.enqueue_event('benefit.consumed', jsonb_build_object(
          'benefit_id', v_benefit.id, 'attendee_id', v_benefit.attendee_id,
          'effi_id', v_att.effi_id, 'event_day', v_day.date,
          'consumption_id', v_consumption.id, 'consumed_at', v_now, 'is_override', v_override));
      end if;
    elsif p_mode = 'redeem' and v_code = 'EXPIRED' and v_benefit.status = 'PENDING' then
      -- Persistir la expiración detectada.
      update public.benefits set status = 'EXPIRED' where id = v_benefit.id returning * into v_benefit;
    end if;
  end if;

  -- 6) Respuesta. Para QR inválido no se revela nada (anti-enumeración).
  if v_benefit.id is not null and v_benefit.status = 'CONSUMED' then
    select jsonb_build_object(
             'id', c.id, 'consumed_at', c.consumed_at, 'is_override', c.is_override,
             'operator', coalesce(nullif(btrim(p.nombres || ' ' || p.apellidos), ''), i.name))
      into v_cons_json
    from public.consumptions c
    left join public.profiles p on p.id = c.operator_id
    left join public.api_integrations i on i.id = c.integration_id
    where c.benefit_id = v_benefit.id;
  end if;

  v_result := jsonb_build_object(
    'ok',          v_code in ('VALID', 'APPROVED'),
    'code',        v_code,
    'message',     private.result_message(v_code),
    'mode',        p_mode,
    'server_time', v_now,
    'today',       v_today,
    'benefit', case when v_benefit.id is null then null else jsonb_build_object(
        'id', v_benefit.id,
        'status', v_benefit.status,
        'consumed_at', v_benefit.consumed_at,
        'expiration_at', v_benefit.expiration_at,
        'event_day', jsonb_build_object('id', v_day.id, 'date', v_day.date, 'name', v_day.name,
                                        'start_time', v_day.start_time, 'end_time', v_day.end_time)) end,
    'attendee', case when v_benefit.id is null then null else jsonb_build_object(
        'id', v_att.id, 'nombres', v_att.nombres, 'apellidos', v_att.apellidos,
        'effi_id', v_att.effi_id, 'effi_username', v_att.effi_username,
        'tipo_acceso', v_att.tipo_acceso, 'empresa', v_att.empresa) end,
    'consumption', v_cons_json
  );

  -- 7) Auditoría.
  v_action := case
    when p_mode = 'validate' then 'VALIDATE_QR'
    when v_code = 'APPROVED' and v_override then 'OVERRIDE_REDEEM'
    when v_code = 'APPROVED' then 'REDEEM_BENEFIT'
    else 'FAILED_REDEEM' end;
  perform private.write_audit(v_action, 'benefit', v_benefit.id::text, v_code in ('VALID', 'APPROVED'),
    jsonb_build_object(
      'code', v_code,
      'override_reason', p_override_reason,
      'token_hash_prefix', left(v_token_hash, 12),
      'idempotency_key', p_idempotency_key,
      'attendee_id', v_benefit.attendee_id,
      'event_day', v_day.date));

  if v_scope is not null then
    update private.idempotency_keys set response = v_result where scope = v_scope and key = p_idempotency_key;
  end if;

  return v_result;
end;
$$;

-- ───────────────────────────── API pública para staff (frontend) ────────────
create or replace function private.staff_rate_limit()
returns jsonb
language sql volatile
set search_path = ''
as $$ select private.rate_limit_hit('staff-scan:' || auth.uid()::text, 180, 60) $$;

create or replace function private.rate_limited_response(p_rl jsonb)
returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object('ok', false, 'code', 'RATE_LIMITED', 'message', private.result_message('RATE_LIMITED'),
                            'retry_after', p_rl -> 'retry_after', 'server_time', private.app_now())
$$;

create or replace function public.benefit_validate(p_token text default null, p_benefit_id uuid default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_rl jsonb;
begin
  perform private.require_permission('benefits:validate');
  if p_token is null and p_benefit_id is null then
    raise exception using errcode = '22023', message = 'TOKEN_OR_ID_REQUIRED';
  end if;
  v_rl := private.staff_rate_limit();
  if not (v_rl ->> 'allowed')::boolean then
    return private.rate_limited_response(v_rl);
  end if;
  return private.process_benefit('validate', p_token, p_benefit_id);
end;
$$;

create or replace function public.benefit_redeem(
  p_token           text default null,
  p_benefit_id      uuid default null,
  p_idempotency_key text default null,
  p_metadata        jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_rl jsonb;
begin
  perform private.require_permission('benefits:redeem');
  if p_token is null and p_benefit_id is null then
    raise exception using errcode = '22023', message = 'TOKEN_OR_ID_REQUIRED';
  end if;
  if pg_column_size(p_metadata) > 2048 then
    raise exception using errcode = '22023', message = 'METADATA_TOO_LARGE';
  end if;
  v_rl := private.staff_rate_limit();
  if not (v_rl ->> 'allowed')::boolean then
    return private.rate_limited_response(v_rl);
  end if;
  return private.process_benefit('redeem', p_token, p_benefit_id, p_idempotency_key, null, p_metadata);
end;
$$;

-- Consumo excepcional (fuera de día/horario o expirado). Requiere permiso especial y motivo.
create or replace function public.benefit_override_redeem(
  p_benefit_id      uuid,
  p_reason          text,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  perform private.require_permission('benefits:override');
  if p_reason is null or length(btrim(p_reason)) < 5 then
    raise exception using errcode = '22023', message = 'REASON_REQUIRED';
  end if;
  return private.process_benefit('redeem', null, p_benefit_id, p_idempotency_key, left(btrim(p_reason), 500));
end;
$$;

-- ───────────────────────────── Portal del asistente ─────────────────────────
create or replace function public.get_my_benefits()
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_att   public.attendees;
  v_now   timestamptz := private.app_now();
  v_today date := private.bogota_today();
  v_time  time := (private.app_now() at time zone 'America/Bogota')::time;
begin
  select * into v_att from public.attendees where auth_user_id = auth.uid();
  if not found then
    return jsonb_build_object('attendee', null, 'benefits', '[]'::jsonb, 'today', v_today, 'server_time', v_now);
  end if;

  return jsonb_build_object(
    'today', v_today,
    'server_time', v_now,
    'attendee', jsonb_build_object(
      'id', v_att.id, 'nombres', v_att.nombres, 'apellidos', v_att.apellidos, 'email', v_att.email,
      'effi_id', v_att.effi_id, 'effi_username', v_att.effi_username,
      'tipo_acceso', v_att.tipo_acceso, 'empresa', v_att.empresa, 'activo', v_att.activo),
    'benefits', coalesce((
      select jsonb_agg(jsonb_build_object(
        'event_day', jsonb_build_object('id', d.id, 'date', d.date, 'name', d.name,
                                        'start_time', d.start_time, 'end_time', d.end_time),
        'benefit_id', b.id,
        'status', b.status,
        'consumed_at', b.consumed_at,
        'eligible', coalesce(aed.eligible, false),
        'display_status', case
          when b.id is null or not coalesce(aed.eligible, false) or not v_att.activo then 'NOT_AVAILABLE'
          when b.status = 'CONSUMED' then 'CONSUMED'
          when b.status = 'CANCELLED' then 'NOT_AVAILABLE'
          when b.status = 'EXPIRED' or v_now >= b.expiration_at or d.date < v_today then 'EXPIRED'
          when d.date = v_today and d.active and v_time >= d.start_time then 'AVAILABLE'
          else 'UPCOMING' end
      ) order by d.date)
      from public.event_days d
      left join public.attendee_event_days aed on aed.event_day_id = d.id and aed.attendee_id = v_att.id
      left join public.benefits b on b.event_day_id = d.id and b.attendee_id = v_att.id
      where d.active and (aed.id is not null or b.id is not null)), '[]'::jsonb)
  );
end;
$$;

-- Devuelve el token (recalculado) SOLO al dueño del beneficio y solo si aún es utilizable.
create or replace function public.get_my_benefit_token(p_benefit_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_b   public.benefits;
  v_att public.attendees;
  v_day public.event_days;
begin
  select b.* into v_b
  from public.benefits b join public.attendees a on a.id = b.attendee_id
  where b.id = p_benefit_id and a.auth_user_id = auth.uid();
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  select * into v_att from public.attendees where id = v_b.attendee_id;
  select * into v_day from public.event_days where id = v_b.event_day_id;

  if v_b.status <> 'PENDING' or private.app_now() >= v_b.expiration_at or not v_att.activo
     or not exists (select 1 from public.attendee_event_days
                    where attendee_id = v_att.id and event_day_id = v_day.id and eligible) then
    return jsonb_build_object('available', false, 'status',
      private.effective_status(v_b.status, v_b.expiration_at));
  end if;

  return jsonb_build_object(
    'available', true,
    'benefit_id', v_b.id,
    'token', private.benefit_token(v_b.id, v_b.token_salt),
    'event_day', jsonb_build_object('date', v_day.date, 'name', v_day.name,
                                    'start_time', v_day.start_time, 'end_time', v_day.end_time));
end;
$$;

-- ───────────────────────────── Administración de beneficios ─────────────────
create or replace function public.generate_benefits(p_attendee_ids uuid[] default null)
returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  perform private.require_permission('benefits:write');
  v_count := private.generate_benefits(p_attendee_ids);
  perform private.write_audit('GENERATE_BENEFITS', 'benefit', null, true,
    jsonb_build_object('created', v_count, 'attendee_ids', to_jsonb(p_attendee_ids)));
  return v_count;
end;
$$;

create or replace function private.generate_benefits(p_attendee_ids uuid[] default null)
returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  insert into public.benefits (attendee_id, event_day_id, token_hash, token_salt, expiration_at)
  select aed.attendee_id, aed.event_day_id, 'pending', 'pending', now()
  from public.attendee_event_days aed
  join public.attendees a on a.id = aed.attendee_id and a.activo
  join public.event_days d on d.id = aed.event_day_id and d.active
  where aed.eligible and (p_attendee_ids is null or aed.attendee_id = any (p_attendee_ids))
  on conflict (attendee_id, event_day_id) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.cancel_benefit(p_benefit_id uuid, p_reason text)
returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  perform private.require_permission('benefits:write');
  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception using errcode = '22023', message = 'REASON_REQUIRED';
  end if;
  update public.benefits
     set status = 'CANCELLED', cancelled_at = now(), cancelled_by = public.current_profile_id(),
         cancel_reason = left(btrim(p_reason), 500)
   where id = p_benefit_id and status in ('PENDING', 'EXPIRED');
  if not found then
    raise exception using errcode = '23514', message = 'INVALID_STATUS_TRANSITION';
  end if;
  perform private.write_audit('CANCEL_BENEFIT', 'benefit', p_benefit_id::text, true, jsonb_build_object('reason', p_reason));
end;
$$;

create or replace function public.restore_benefit(p_benefit_id uuid, p_reason text)
returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  perform private.require_permission('benefits:write');
  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception using errcode = '22023', message = 'REASON_REQUIRED';
  end if;
  update public.benefits
     set status = 'PENDING', cancelled_at = null, cancelled_by = null, cancel_reason = null
   where id = p_benefit_id and status in ('CANCELLED', 'EXPIRED');
  if not found then
    raise exception using errcode = '23514', message = 'INVALID_STATUS_TRANSITION';
  end if;
  perform private.write_audit('RESTORE_BENEFIT', 'benefit', p_benefit_id::text, true, jsonb_build_object('reason', p_reason));
end;
$$;

-- Rota el token: el QR anterior (p. ej. una captura filtrada) deja de funcionar.
create or replace function public.regenerate_benefit_token(p_benefit_id uuid, p_reason text default null)
returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_salt text := encode(extensions.gen_random_bytes(16), 'hex');
begin
  perform private.require_permission('benefits:write');
  update public.benefits
     set token_salt = v_salt, token_hash = private.hash_token(private.benefit_token(id, v_salt))
   where id = p_benefit_id and status = 'PENDING';
  if not found then
    raise exception using errcode = '23514', message = 'INVALID_STATUS_TRANSITION';
  end if;
  perform private.write_audit('REGENERATE_TOKEN', 'benefit', p_benefit_id::text, true, jsonb_build_object('reason', p_reason));
end;
$$;

-- Persiste EXPIRED en beneficios cuyo día terminó (el estado efectivo ya lo refleja).
create or replace function public.expire_benefits()
returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if auth.uid() is not null then
    perform private.require_permission('benefits:write');
  end if;
  update public.benefits set status = 'EXPIRED'
   where status = 'PENDING' and expiration_at <= private.app_now();
  get diagnostics v_count = row_count;
  perform private.write_audit('EXPIRE_BENEFITS', 'benefit', null, true, jsonb_build_object('expired', v_count));
  return v_count;
end;
$$;

-- Hora oficial del servidor (para que el cliente muestre la misma referencia).
create or replace function public.server_time()
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object('now', private.app_now(), 'today', private.bogota_today(),
                            'timezone', 'America/Bogota',
                            'local_time', to_char(private.app_now() at time zone 'America/Bogota', 'HH24:MI:SS'))
$$;

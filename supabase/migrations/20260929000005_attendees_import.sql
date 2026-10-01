-- ═══════════════════════════════════════════════════════════════════════════
-- EFFI DRINK PASS · 0005 · Asistentes, elegibilidad, días, configuración e importación
-- Todas las escrituras pasan por funciones (validación + auditoría); RLS no
-- concede INSERT/UPDATE/DELETE directos a los clientes.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────── Asistentes ───────────────────────────────────
-- p_data: {nombres, apellidos, email, telefono, effi_id, effi_username, tipo_acceso, empresa, activo, metadata}
-- p_partial = true (PATCH): solo se modifican las claves presentes en p_data.
-- p_event_day_ids: si no es null, define exactamente los días elegibles.
create or replace function private.upsert_attendee(
  p_id            uuid,
  p_data          jsonb,
  p_partial       boolean default true,
  p_event_day_ids uuid[] default null
)
returns uuid
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_id  uuid;
  v_cur public.attendees;
  v_key text;
begin
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception using errcode = '22023', message = 'INVALID_BODY';
  end if;
  for v_key in select jsonb_object_keys(p_data) loop
    if v_key not in ('nombres', 'apellidos', 'email', 'telefono', 'effi_id', 'effi_username',
                     'tipo_acceso', 'empresa', 'activo', 'metadata') then
      raise exception using errcode = '22023', message = 'UNKNOWN_FIELD', detail = v_key;
    end if;
  end loop;

  if p_id is null then
    if coalesce(btrim(p_data ->> 'nombres'), '') = '' then
      raise exception using errcode = '22023', message = 'NOMBRES_REQUIRED';
    end if;
    insert into public.attendees (nombres, apellidos, email, telefono, effi_id, effi_username,
                                  tipo_acceso, empresa, activo, metadata)
    values (p_data ->> 'nombres', coalesce(p_data ->> 'apellidos', ''), p_data ->> 'email', p_data ->> 'telefono',
            p_data ->> 'effi_id', p_data ->> 'effi_username', p_data ->> 'tipo_acceso', p_data ->> 'empresa',
            coalesce((p_data ->> 'activo')::boolean, true), coalesce(p_data -> 'metadata', '{}'::jsonb))
    returning id into v_id;
  else
    select * into v_cur from public.attendees where id = p_id for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'NOT_FOUND';
    end if;
    if not p_partial and coalesce(btrim(p_data ->> 'nombres'), '') = '' then
      raise exception using errcode = '22023', message = 'NOMBRES_REQUIRED';
    end if;
    update public.attendees set
      nombres       = case when p_partial and not p_data ? 'nombres'       then v_cur.nombres       else p_data ->> 'nombres' end,
      apellidos     = case when p_partial and not p_data ? 'apellidos'     then v_cur.apellidos     else coalesce(p_data ->> 'apellidos', '') end,
      email         = case when p_partial and not p_data ? 'email'         then v_cur.email         else p_data ->> 'email' end,
      telefono      = case when p_partial and not p_data ? 'telefono'      then v_cur.telefono      else p_data ->> 'telefono' end,
      effi_id       = case when p_partial and not p_data ? 'effi_id'       then v_cur.effi_id       else p_data ->> 'effi_id' end,
      effi_username = case when p_partial and not p_data ? 'effi_username' then v_cur.effi_username else p_data ->> 'effi_username' end,
      tipo_acceso   = case when p_partial and not p_data ? 'tipo_acceso'   then v_cur.tipo_acceso   else p_data ->> 'tipo_acceso' end,
      empresa       = case when p_partial and not p_data ? 'empresa'       then v_cur.empresa       else p_data ->> 'empresa' end,
      activo        = case when p_partial and not p_data ? 'activo'        then v_cur.activo        else coalesce((p_data ->> 'activo')::boolean, true) end,
      metadata      = case when p_partial and not p_data ? 'metadata'      then v_cur.metadata      else coalesce(p_data -> 'metadata', '{}'::jsonb) end
    where id = p_id
    returning id into v_id;
  end if;

  if p_event_day_ids is not null then
    perform private.set_attendee_days(v_id, p_event_day_ids);
  end if;
  return v_id;
end;
$$;

create or replace function private.set_attendee_days(p_attendee_id uuid, p_event_day_ids uuid[])
returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if exists (select 1 from unnest(p_event_day_ids) x where x not in (select id from public.event_days)) then
    raise exception using errcode = '22023', message = 'UNKNOWN_EVENT_DAY';
  end if;
  update public.attendee_event_days set eligible = false
   where attendee_id = p_attendee_id and eligible and not (event_day_id = any (p_event_day_ids));
  insert into public.attendee_event_days (attendee_id, event_day_id, eligible)
  select p_attendee_id, d, true from unnest(p_event_day_ids) as d
  on conflict (attendee_id, event_day_id) do update set eligible = true
    where public.attendee_event_days.eligible = false;
end;
$$;

create or replace function public.upsert_attendee(
  p_id            uuid,
  p_data          jsonb,
  p_partial       boolean default true,
  p_event_day_ids uuid[] default null
)
returns uuid
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  perform private.require_permission('attendees:write');
  return private.upsert_attendee(p_id, p_data, p_partial, p_event_day_ids);
end;
$$;

create or replace function public.set_attendee_days(p_attendee_id uuid, p_event_day_ids uuid[])
returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  perform private.require_permission('attendees:write');
  if not exists (select 1 from public.attendees where id = p_attendee_id) then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  perform private.set_attendee_days(p_attendee_id, coalesce(p_event_day_ids, '{}'));
end;
$$;

-- Asigna un día a todos los asistentes activos (opcionalmente filtrando por tipo de acceso).
create or replace function public.assign_day_to_attendees(p_event_day_id uuid, p_tipo_acceso text default null)
returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  perform private.require_permission('attendees:write');
  if not exists (select 1 from public.event_days where id = p_event_day_id) then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  insert into public.attendee_event_days (attendee_id, event_day_id, eligible)
  select a.id, p_event_day_id, true from public.attendees a
  where a.activo and (p_tipo_acceso is null or a.tipo_acceso = upper(btrim(p_tipo_acceso)))
  on conflict (attendee_id, event_day_id) do update set eligible = true
    where public.attendee_event_days.eligible = false;
  get diagnostics v_count = row_count;
  perform private.write_audit('ASSIGN_DAY_BULK', 'event_day', p_event_day_id::text, true,
    jsonb_build_object('tipo_acceso', p_tipo_acceso, 'affected', v_count));
  return v_count;
end;
$$;

-- ───────────────────────────── Días del evento ──────────────────────────────
create or replace function public.upsert_event_day(
  p_id uuid, p_date date, p_name text, p_start_time time, p_end_time time, p_active boolean default true
)
returns uuid
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_permission('event-days:write');
  if p_id is null then
    insert into public.event_days (date, name, start_time, end_time, active)
    values (p_date, btrim(p_name), p_start_time, p_end_time, p_active)
    returning id into v_id;
  else
    update public.event_days
       set date = p_date, name = btrim(p_name), start_time = p_start_time, end_time = p_end_time, active = p_active
     where id = p_id returning id into v_id;
    if v_id is null then
      raise exception using errcode = 'P0002', message = 'NOT_FOUND';
    end if;
  end if;
  return v_id;
end;
$$;

-- ───────────────────────────── Configuración ────────────────────────────────
create or replace function public.update_setting(p_key text, p_value jsonb)
returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  perform private.require_permission('settings:manage');
  if p_key = 'scanner_default_mode' and p_value #>> '{}' not in ('auto', 'confirm') then
    raise exception using errcode = '22023', message = 'INVALID_VALUE';
  end if;
  if p_key = 'scanner_auto_return_seconds' and (jsonb_typeof(p_value) <> 'number' or (p_value #>> '{}')::numeric not between 1 and 30) then
    raise exception using errcode = '22023', message = 'INVALID_VALUE';
  end if;
  update public.app_settings set value = p_value, updated_at = now(), updated_by = public.current_profile_id()
   where key = p_key;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
end;
$$;

-- ───────────────────────────── Importación masiva ───────────────────────────
-- p_rows: [{row, nombres, apellidos, email, telefono, effi_id, effi_username, tipo_acceso, empresa}, …] (máx. 1000)
-- p_mode: 'insert_only' (duplicados se omiten) | 'upsert' (duplicados se actualizan)
-- p_dry_run: true = solo previsualiza (no escribe nada)
-- Coincidencia de duplicados: effi_id → email → effi_username.
-- En actualización, las celdas vacías NO borran datos existentes.
create or replace function public.import_attendees(
  p_rows          jsonb,
  p_mode          text default 'upsert',
  p_dry_run       boolean default true,
  p_event_day_ids uuid[] default null,
  p_file_name     text default null
)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_row        jsonb;
  v_idx        int := 0;
  v_rownum     int;
  v_data       jsonb;
  v_errors     jsonb;
  v_warnings   jsonb;
  v_action     text;
  v_match_id   uuid;
  v_m_effi     uuid;
  v_m_email    uuid;
  v_m_user     uuid;
  v_id         uuid;
  v_seen       jsonb := '{}'::jsonb;
  v_results    jsonb := '[]'::jsonb;
  v_ins int := 0; v_upd int := 0; v_skip int := 0; v_err int := 0;
  v_email      text;
  v_effi_id    text;
  v_user       text;
  v_tipo       text;
  v_ids        text[];
  v_k          text;
begin
  perform private.require_permission('attendees:import');
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception using errcode = '22023', message = 'ROWS_MUST_BE_ARRAY';
  end if;
  if jsonb_array_length(p_rows) > 1000 then
    raise exception using errcode = '22023', message = 'BATCH_TOO_LARGE', detail = 'Máximo 1000 filas por lote';
  end if;
  if p_mode not in ('insert_only', 'upsert') then
    raise exception using errcode = '22023', message = 'INVALID_MODE';
  end if;
  if p_event_day_ids is not null and exists (
       select 1 from unnest(p_event_day_ids) x where x not in (select id from public.event_days)) then
    raise exception using errcode = '22023', message = 'UNKNOWN_EVENT_DAY';
  end if;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_idx      := v_idx + 1;
    v_rownum   := coalesce((v_row ->> 'row')::int, v_idx);
    v_errors   := '[]'::jsonb;
    v_warnings := '[]'::jsonb;
    v_match_id := null;
    v_id       := null;

    v_email   := nullif(lower(btrim(v_row ->> 'email')), '');
    v_effi_id := nullif(btrim(v_row ->> 'effi_id'), '');
    v_user    := nullif(btrim(v_row ->> 'effi_username'), '');
    v_tipo    := upper(nullif(btrim(v_row ->> 'tipo_acceso'), ''));

    v_data := jsonb_strip_nulls(jsonb_build_object(
      'nombres',       nullif(btrim(v_row ->> 'nombres'), ''),
      'apellidos',     nullif(btrim(v_row ->> 'apellidos'), ''),
      'email',         v_email,
      'telefono',      nullif(btrim(v_row ->> 'telefono'), ''),
      'effi_id',       v_effi_id,
      'effi_username', v_user,
      'tipo_acceso',   v_tipo,
      'empresa',       nullif(btrim(v_row ->> 'empresa'), '')));

    -- Validaciones de formato
    if v_data ->> 'nombres' is null then
      v_errors := v_errors || '["nombres es obligatorio"]'::jsonb;
    elsif length(v_data ->> 'nombres') > 120 then
      v_errors := v_errors || '["nombres excede 120 caracteres"]'::jsonb;
    end if;
    if length(coalesce(v_data ->> 'apellidos', '')) > 120 then
      v_errors := v_errors || '["apellidos excede 120 caracteres"]'::jsonb;
    end if;
    if v_email is not null and (v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 254) then
      v_errors := v_errors || '["email inválido"]'::jsonb;
    end if;
    if v_tipo is not null and v_tipo !~ '^[A-Z0-9][A-Z0-9 _-]{0,39}$' then
      v_errors := v_errors || '["tipo_acceso inválido (A-Z, 0-9, espacio, _ o -; máx. 40)"]'::jsonb;
    end if;
    if length(coalesce(v_effi_id, '')) > 64 then
      v_errors := v_errors || '["effi_id excede 64 caracteres"]'::jsonb;
    end if;
    if length(coalesce(v_user, '')) > 120 then
      v_errors := v_errors || '["effi_username excede 120 caracteres"]'::jsonb;
    end if;
    if length(coalesce(v_data ->> 'telefono', '')) > 40 then
      v_errors := v_errors || '["telefono excede 40 caracteres"]'::jsonb;
    end if;
    if length(coalesce(v_data ->> 'empresa', '')) > 200 then
      v_errors := v_errors || '["empresa excede 200 caracteres"]'::jsonb;
    end if;
    if v_email is null then
      v_warnings := v_warnings || '["sin email: el asistente no podrá iniciar sesión en el portal"]'::jsonb;
    end if;
    if v_email is null and v_effi_id is null and v_user is null then
      v_warnings := v_warnings || '["sin identificadores: no se puede detectar si es duplicado"]'::jsonb;
    end if;

    -- Duplicados dentro del mismo lote
    v_ids := array_remove(array['effi_id:' || v_effi_id, 'email:' || v_email, 'user:' || lower(v_user)], null);
    foreach v_k in array v_ids loop
      if v_seen ? v_k then
        v_errors := v_errors || jsonb_build_array(format('duplicado en el archivo (%s, fila %s)', split_part(v_k, ':', 1), v_seen ->> v_k));
      end if;
    end loop;
    foreach v_k in array v_ids loop
      if not v_seen ? v_k then
        v_seen := v_seen || jsonb_build_object(v_k, v_rownum);
      end if;
    end loop;

    -- Coincidencias con asistentes existentes
    if jsonb_array_length(v_errors) = 0 then
      select id into v_m_effi  from public.attendees where v_effi_id is not null and effi_id = v_effi_id;
      select id into v_m_email from public.attendees where v_email is not null and lower(email) = v_email;
      select id into v_m_user  from public.attendees where v_user is not null and lower(effi_username) = lower(v_user);
      v_match_id := coalesce(v_m_effi, v_m_email, v_m_user);
      if (v_m_effi is not null and v_m_email is not null and v_m_effi <> v_m_email)
         or (v_m_effi is not null and v_m_user is not null and v_m_effi <> v_m_user)
         or (v_m_email is not null and v_m_user is not null and v_m_email <> v_m_user) then
        v_errors := v_errors || '["los identificadores coinciden con asistentes distintos"]'::jsonb;
      end if;
      v_m_effi := null; v_m_email := null; v_m_user := null;
    end if;

    if jsonb_array_length(v_errors) > 0 then
      v_action := 'error';
    elsif v_match_id is null then
      v_action := 'insert';
    elsif p_mode = 'insert_only' then
      v_action := 'skip';
      v_warnings := v_warnings || '["ya existe; omitido (modo solo insertar)"]'::jsonb;
    else
      v_action := 'update';
    end if;

    -- Escritura (subtransacción por fila: un error no aborta el lote)
    if not p_dry_run and v_action in ('insert', 'update') then
      begin
        if v_action = 'insert' then
          v_id := private.upsert_attendee(null, v_data, false, null);
        else
          -- Parcial: solo las columnas con valor en el archivo (v_data ya no tiene nulos).
          v_id := private.upsert_attendee(v_match_id, v_data, true, null);
        end if;
        if p_event_day_ids is not null and cardinality(p_event_day_ids) > 0 then
          insert into public.attendee_event_days (attendee_id, event_day_id, eligible)
          select v_id, d, true from unnest(p_event_day_ids) d
          on conflict (attendee_id, event_day_id) do update set eligible = true
            where public.attendee_event_days.eligible = false;
        end if;
      exception when others then
        v_action := 'error';
        v_errors := v_errors || jsonb_build_array(case sqlstate
          when '23505' then 'conflicto de unicidad (email, effi_id o effi_username ya usado)'
          when '23514' then 'dato inválido (' || sqlerrm || ')'
          else sqlerrm end);
        v_id := null;
      end;
    else
      v_id := v_match_id;
    end if;

    case v_action
      when 'insert' then v_ins := v_ins + 1;
      when 'update' then v_upd := v_upd + 1;
      when 'skip'   then v_skip := v_skip + 1;
      else v_err := v_err + 1;
    end case;

    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'row', v_rownum, 'action', v_action, 'attendee_id', v_id,
      'errors', v_errors, 'warnings', v_warnings));
  end loop;

  if not p_dry_run then
    perform private.write_audit('IMPORT_ATTENDEES', 'attendee', null, v_err = 0, jsonb_build_object(
      'file_name', p_file_name, 'mode', p_mode, 'total', v_idx,
      'inserted', v_ins, 'updated', v_upd, 'skipped', v_skip, 'errors', v_err,
      'event_day_ids', to_jsonb(p_event_day_ids)));
  end if;

  return jsonb_build_object(
    'dry_run', p_dry_run,
    'summary', jsonb_build_object('total', v_idx, 'insert', v_ins, 'update', v_upd, 'skip', v_skip, 'error', v_err),
    'rows', v_results);
end;
$$;

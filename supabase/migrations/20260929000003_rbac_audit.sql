-- ═══════════════════════════════════════════════════════════════════════════
-- EFFI DRINK PASS · 0003 · Roles, permisos, actor y auditoría
-- Los nombres de permiso son también los scopes de la API (mismo vocabulario).
-- ═══════════════════════════════════════════════════════════════════════════

insert into public.permissions (name, description, integration_assignable) values
  ('attendees:read',      'Consultar asistentes',                                   true),
  ('attendees:write',     'Crear/actualizar asistentes y su elegibilidad',          true),
  ('attendees:import',    'Carga masiva de asistentes (CSV/XLSX)',                  false),
  ('event-days:read',     'Consultar días del evento',                              true),
  ('event-days:write',    'Crear/editar días del evento',                           false),
  ('benefits:read',       'Consultar beneficios',                                   true),
  ('benefits:write',      'Generar, cancelar, restaurar y rotar beneficios',        true),
  ('benefits:validate',   'Validar un QR/beneficio sin consumirlo',                 true),
  ('benefits:redeem',     'Consumir (redimir) beneficios',                          true),
  ('benefits:override',   'Consumo excepcional fuera de día/horario (auditado)',    false),
  ('consumptions:read',   'Consultar consumos',                                     true),
  ('statistics:read',     'Consultar estadísticas',                                 true),
  ('reports:read',        'Generar y exportar reportes',                            false),
  ('audit:read',          'Consultar la auditoría',                                 false),
  ('users:manage',        'Gestionar usuarios del staff',                           false),
  ('roles:manage',        'Gestionar roles y permisos',                             false),
  ('integrations:manage', 'Gestionar integraciones y credenciales de API',          false),
  ('settings:manage',     'Gestionar la configuración del sistema',                 false)
on conflict (name) do nothing;

insert into public.roles (name, description, is_system) values
  ('super_admin', 'Control total del sistema',                                 true),
  ('admin',       'Administración del evento (sin gestión de roles)',          true),
  ('supervisor',  'Supervisa la operación: consulta, consume y hace excepciones', true),
  ('operator',    'Operador de barra: escanea y entrega bebidas',              true),
  ('viewer',      'Solo lectura: dashboard y reportes',                        true)
on conflict (name) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on
     r.name = 'super_admin'
  or (r.name = 'admin' and p.name <> 'roles:manage')
  or (r.name = 'supervisor' and p.name in (
        'attendees:read', 'event-days:read', 'benefits:read', 'benefits:validate', 'benefits:redeem',
        'benefits:override', 'consumptions:read', 'statistics:read', 'reports:read'))
  or (r.name = 'operator' and p.name in ('event-days:read', 'benefits:validate', 'benefits:redeem'))
  or (r.name = 'viewer' and p.name in (
        'attendees:read', 'event-days:read', 'benefits:read', 'consumptions:read', 'statistics:read', 'reports:read'))
on conflict do nothing;

-- ───────────────────────────── Identidad del usuario actual ─────────────────
create or replace function public.current_profile_id()
returns uuid
language sql stable security definer
set search_path = ''
as $$
  select p.id from public.profiles p where p.auth_user_id = auth.uid() and p.activo
$$;

create or replace function public.current_attendee_id()
returns uuid
language sql stable security definer
set search_path = ''
as $$
  select a.id from public.attendees a where a.auth_user_id = auth.uid()
$$;

create or replace function public.has_permission(p_permission text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    join public.user_roles ur      on ur.user_id = p.id
    join public.roles r            on r.id = ur.role_id and r.active
    join public.role_permissions rp on rp.role_id = r.id
    join public.permissions pe     on pe.id = rp.permission_id
    where p.auth_user_id = auth.uid()
      and p.activo
      and pe.name = p_permission
  )
$$;

create or replace function public.is_super_admin()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    join public.user_roles ur on ur.user_id = p.id
    join public.roles r on r.id = ur.role_id and r.active
    where p.auth_user_id = auth.uid() and p.activo and r.name = 'super_admin'
  )
$$;

create or replace function private.require_permission(p_permission text)
returns void
language plpgsql stable
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.has_permission(p_permission) then
    raise exception using errcode = '42501', message = 'FORBIDDEN',
      detail = format('Se requiere el permiso %s', p_permission);
  end if;
end;
$$;

-- ───────────────────────────── Actor de la operación ────────────────────────
-- Las funciones api_* (solo service_role, invocadas por la Edge Function) fijan
-- app.actor con la integración autenticada. Las llamadas directas del frontend
-- se resuelven con auth.uid().
create or replace function private.set_actor(p_actor jsonb)
returns void
language sql volatile
set search_path = ''
as $$ select set_config('app.actor', p_actor::text, true) $$;

create or replace function private.actor()
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_ctx   text := nullif(current_setting('app.actor', true), '');
  v_uid   uuid := auth.uid();
  v_prof  record;
begin
  if v_ctx is not null then
    return v_ctx::jsonb;
  end if;
  if v_uid is not null then
    select p.id, btrim(p.nombres || ' ' || p.apellidos) as label
      into v_prof from public.profiles p where p.auth_user_id = v_uid;
    return jsonb_build_object(
      'type',         'user',
      'profile_id',   v_prof.id,
      'auth_user_id', v_uid,
      'label',        coalesce(v_prof.label, auth.jwt() ->> 'email'),
      'ip',           private.request_ip(),
      'user_agent',   private.request_user_agent()
    );
  end if;
  return jsonb_build_object('type', 'system', 'label', current_user);
end;
$$;

create or replace function private.write_audit(
  p_action        text,
  p_resource_type text default null,
  p_resource_id   text default null,
  p_success       boolean default true,
  p_metadata      jsonb default '{}'::jsonb
)
returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_actor jsonb := private.actor();
begin
  insert into public.audit_logs (
    actor_type, actor_profile_id, actor_auth_user_id, actor_label,
    integration_id, credential_id, action, resource_type, resource_id,
    success, ip, user_agent, request_id, metadata
  ) values (
    coalesce(v_actor ->> 'type', 'system'),
    nullif(v_actor ->> 'profile_id', '')::uuid,
    nullif(v_actor ->> 'auth_user_id', '')::uuid,
    left(v_actor ->> 'label', 200),
    nullif(v_actor ->> 'integration_id', '')::uuid,
    nullif(v_actor ->> 'credential_id', '')::uuid,
    p_action, p_resource_type, p_resource_id, p_success,
    left(v_actor ->> 'ip', 64),
    left(v_actor ->> 'user_agent', 400),
    left(v_actor ->> 'request_id', 100),
    coalesce(p_metadata, '{}'::jsonb)
  );
end;
$$;

-- Trigger genérico de auditoría por fila: args = (acción INSERT, acción UPDATE, tipo de recurso)
create or replace function private.audit_row()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old     jsonb;
  v_new     jsonb;
  v_changes jsonb := '{}'::jsonb;
  v_key     text;
begin
  if tg_op = 'INSERT' then
    v_new := to_jsonb(new) - 'created_at' - 'updated_at';
    perform private.write_audit(tg_argv[0], tg_argv[2], v_new ->> 'id', true, jsonb_build_object('new', v_new));
    return new;
  end if;

  v_old := to_jsonb(old);
  v_new := to_jsonb(new);
  for v_key in select jsonb_object_keys(v_new) loop
    if v_key not in ('updated_at', 'created_at') and (v_old -> v_key) is distinct from (v_new -> v_key) then
      v_changes := v_changes || jsonb_build_object(v_key, jsonb_build_object('from', v_old -> v_key, 'to', v_new -> v_key));
    end if;
  end loop;
  if v_changes <> '{}'::jsonb then
    perform private.write_audit(tg_argv[1], tg_argv[2], v_new ->> 'id', true, jsonb_build_object('changes', v_changes));
  end if;
  return new;
end;
$$;

create trigger attendees_audit after insert or update on public.attendees
  for each row execute function private.audit_row('CREATE_ATTENDEE', 'UPDATE_ATTENDEE', 'attendee');
create trigger attendee_event_days_audit after insert or update on public.attendee_event_days
  for each row execute function private.audit_row('SET_ELIGIBILITY', 'SET_ELIGIBILITY', 'attendee_event_day');
create trigger event_days_audit after insert or update on public.event_days
  for each row execute function private.audit_row('CREATE_EVENT_DAY', 'UPDATE_EVENT_DAY', 'event_day');
create trigger profiles_audit after insert or update on public.profiles
  for each row execute function private.audit_row('CREATE_USER', 'UPDATE_USER', 'profile');
create trigger app_settings_audit after insert or update on public.app_settings
  for each row execute function private.audit_row('UPDATE_SETTINGS', 'UPDATE_SETTINGS', 'setting');

-- ───────────────────────────── Sesión: vinculación y acceso ─────────────────
-- Vincula la cuenta de Auth con el perfil de staff y/o el asistente cuyo email
-- coincide, SOLO si el email está verificado por Supabase Auth.
create or replace function public.on_login()
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_uid       uuid := auth.uid();
  v_email     text;
  v_confirmed timestamptz;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'UNAUTHENTICATED';
  end if;

  select lower(u.email), u.email_confirmed_at into v_email, v_confirmed
  from auth.users u where u.id = v_uid;

  if v_email is not null and v_confirmed is not null then
    update public.profiles set auth_user_id = v_uid
     where lower(email) = v_email and auth_user_id is null;
    update public.attendees set auth_user_id = v_uid
     where lower(email) = v_email and auth_user_id is null;
  end if;

  perform private.write_audit('LOGIN', 'auth_user', v_uid::text, true,
    jsonb_build_object('email', v_email, 'email_confirmed', v_confirmed is not null));

  return public.my_access();
end;
$$;

create or replace function public.my_access()
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_profile jsonb;
  v_att     jsonb;
begin
  if v_uid is null then
    return jsonb_build_object('authenticated', false);
  end if;

  select jsonb_build_object('id', p.id, 'nombres', p.nombres, 'apellidos', p.apellidos, 'email', p.email, 'activo', p.activo)
    into v_profile from public.profiles p where p.auth_user_id = v_uid;

  select jsonb_build_object('id', a.id, 'nombres', a.nombres, 'apellidos', a.apellidos, 'activo', a.activo)
    into v_att from public.attendees a where a.auth_user_id = v_uid;

  return jsonb_build_object(
    'authenticated', true,
    'auth_user_id',  v_uid,
    'profile',       v_profile,
    'attendee',      v_att,
    'roles', coalesce((
      select jsonb_agg(r.name order by r.name)
      from public.profiles p
      join public.user_roles ur on ur.user_id = p.id
      join public.roles r on r.id = ur.role_id and r.active
      where p.auth_user_id = v_uid and p.activo), '[]'::jsonb),
    'permissions', coalesce((
      select jsonb_agg(distinct pe.name)
      from public.profiles p
      join public.user_roles ur on ur.user_id = p.id
      join public.roles r on r.id = ur.role_id and r.active
      join public.role_permissions rp on rp.role_id = r.id
      join public.permissions pe on pe.id = rp.permission_id
      where p.auth_user_id = v_uid and p.activo), '[]'::jsonb)
  );
end;
$$;

-- ───────────────────────────── Gestión de staff ─────────────────────────────
-- El staff se pre-registra por email; al iniciar sesión (magic link / password)
-- con ese email verificado, on_login() vincula la cuenta.
create or replace function public.upsert_staff_profile(
  p_id        uuid,
  p_email     text,
  p_nombres   text,
  p_apellidos text default '',
  p_telefono  text default null,
  p_activo    boolean default true
)
returns uuid
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_permission('users:manage');

  if p_id is not null and p_id = public.current_profile_id() and not p_activo then
    raise exception using errcode = '22023', message = 'CANNOT_DEACTIVATE_SELF';
  end if;

  if p_id is not null and not p_activo and private.is_last_super_admin(p_id) then
    raise exception using errcode = '22023', message = 'LAST_SUPER_ADMIN';
  end if;

  if p_id is null then
    insert into public.profiles (email, nombres, apellidos, telefono, activo)
    values (p_email, p_nombres, coalesce(p_apellidos, ''), p_telefono, p_activo)
    returning id into v_id;
  else
    update public.profiles
       set email = p_email, nombres = p_nombres, apellidos = coalesce(p_apellidos, ''),
           telefono = p_telefono, activo = p_activo
     where id = p_id
    returning id into v_id;
    if v_id is null then
      raise exception using errcode = 'P0002', message = 'NOT_FOUND';
    end if;
  end if;
  return v_id;
end;
$$;

create or replace function private.is_last_super_admin(p_profile_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select exists (
      select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
      where ur.user_id = p_profile_id and r.name = 'super_admin')
    and (
      select count(*) from public.user_roles ur
      join public.roles r on r.id = ur.role_id
      join public.profiles p on p.id = ur.user_id
      where r.name = 'super_admin' and p.activo) <= 1
$$;

create or replace function public.set_user_roles(p_profile_id uuid, p_role_ids uuid[])
returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_is_super boolean := public.is_super_admin();
  v_super_id uuid := (select id from public.roles where name = 'super_admin');
  v_before   text[];
  v_after    text[];
  v_missing  text;
begin
  perform private.require_permission('users:manage');
  p_role_ids := coalesce(p_role_ids, '{}');

  if not exists (select 1 from public.profiles where id = p_profile_id) then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;

  -- Solo un super_admin puede otorgar o retirar el rol super_admin.
  if not v_is_super and (
       v_super_id = any (p_role_ids)
    or exists (select 1 from public.user_roles where user_id = p_profile_id and role_id = v_super_id)) then
    raise exception using errcode = '42501', message = 'ONLY_SUPER_ADMIN_CAN_MANAGE_SUPER_ADMIN';
  end if;

  -- Anti-escalamiento: no se puede otorgar un permiso que uno mismo no tiene.
  if not v_is_super then
    select pe.name into v_missing
    from public.role_permissions rp
    join public.permissions pe on pe.id = rp.permission_id
    where rp.role_id = any (p_role_ids) and not public.has_permission(pe.name)
    limit 1;
    if v_missing is not null then
      raise exception using errcode = '42501', message = 'PRIVILEGE_ESCALATION',
        detail = format('No puede otorgar el permiso %s', v_missing);
    end if;
  end if;

  -- No dejar el sistema sin super_admin.
  if not (v_super_id = any (p_role_ids)) and private.is_last_super_admin(p_profile_id) then
    raise exception using errcode = '22023', message = 'LAST_SUPER_ADMIN';
  end if;

  select coalesce(array_agg(r.name order by r.name), '{}') into v_before
  from public.user_roles ur join public.roles r on r.id = ur.role_id where ur.user_id = p_profile_id;

  delete from public.user_roles where user_id = p_profile_id and not (role_id = any (p_role_ids));
  insert into public.user_roles (user_id, role_id, created_by)
  select p_profile_id, rid, public.current_profile_id() from unnest(p_role_ids) as rid
  on conflict do nothing;

  select coalesce(array_agg(r.name order by r.name), '{}') into v_after
  from public.user_roles ur join public.roles r on r.id = ur.role_id where ur.user_id = p_profile_id;

  if v_before is distinct from v_after then
    perform private.write_audit('CHANGE_ROLE', 'profile', p_profile_id::text, true,
      jsonb_build_object('from', to_jsonb(v_before), 'to', to_jsonb(v_after)));
  end if;
end;
$$;

create or replace function public.upsert_role(p_id uuid, p_name text, p_description text, p_active boolean default true)
returns uuid
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_system boolean;
begin
  perform private.require_permission('roles:manage');
  if p_id is null then
    insert into public.roles (name, description, active) values (lower(btrim(p_name)), p_description, p_active)
    returning id into v_id;
    perform private.write_audit('CREATE_ROLE', 'role', v_id::text, true, jsonb_build_object('name', p_name));
  else
    select is_system into v_system from public.roles where id = p_id;
    if v_system is null then
      raise exception using errcode = 'P0002', message = 'NOT_FOUND';
    end if;
    if v_system and (select name from public.roles where id = p_id) <> lower(btrim(p_name)) then
      raise exception using errcode = '22023', message = 'SYSTEM_ROLE_NAME_IMMUTABLE';
    end if;
    if (select name from public.roles where id = p_id) = 'super_admin' and not p_active then
      raise exception using errcode = '22023', message = 'SUPER_ADMIN_ROLE_IMMUTABLE';
    end if;
    update public.roles set name = lower(btrim(p_name)), description = p_description, active = p_active
     where id = p_id returning id into v_id;
    perform private.write_audit('UPDATE_ROLE', 'role', v_id::text, true,
      jsonb_build_object('name', p_name, 'active', p_active));
  end if;
  return v_id;
end;
$$;

create or replace function public.set_role_permissions(p_role_id uuid, p_permissions text[])
returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_name   text;
  v_before text[];
  v_after  text[];
begin
  perform private.require_permission('roles:manage');
  select name into v_name from public.roles where id = p_role_id;
  if v_name is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  if v_name = 'super_admin' then
    raise exception using errcode = '22023', message = 'SUPER_ADMIN_ROLE_IMMUTABLE';
  end if;
  if exists (select 1 from unnest(coalesce(p_permissions, '{}')) x where x not in (select name from public.permissions)) then
    raise exception using errcode = '22023', message = 'UNKNOWN_PERMISSION';
  end if;

  select coalesce(array_agg(pe.name order by pe.name), '{}') into v_before
  from public.role_permissions rp join public.permissions pe on pe.id = rp.permission_id where rp.role_id = p_role_id;

  delete from public.role_permissions rp
   using public.permissions pe
   where rp.role_id = p_role_id and pe.id = rp.permission_id and not (pe.name = any (coalesce(p_permissions, '{}')));
  insert into public.role_permissions (role_id, permission_id)
  select p_role_id, pe.id from public.permissions pe where pe.name = any (coalesce(p_permissions, '{}'))
  on conflict do nothing;

  select coalesce(array_agg(pe.name order by pe.name), '{}') into v_after
  from public.role_permissions rp join public.permissions pe on pe.id = rp.permission_id where rp.role_id = p_role_id;

  perform private.write_audit('CHANGE_ROLE_PERMISSIONS', 'role', p_role_id::text, true,
    jsonb_build_object('role', v_name, 'from', to_jsonb(v_before), 'to', to_jsonb(v_after)));
end;
$$;

-- Registro de eventos iniciados por el cliente (lista blanca, sin datos arbitrarios peligrosos).
create or replace function public.log_client_event(p_action text, p_metadata jsonb default '{}'::jsonb)
returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'UNAUTHENTICATED';
  end if;
  if p_action not in ('LOGOUT', 'EXPORT_REPORT', 'VIEW_QR', 'SCANNER_OPENED') then
    raise exception using errcode = '22023', message = 'ACTION_NOT_ALLOWED';
  end if;
  if pg_column_size(p_metadata) > 4096 then
    raise exception using errcode = '22023', message = 'METADATA_TOO_LARGE';
  end if;
  perform private.write_audit(p_action, 'client', null, true, coalesce(p_metadata, '{}'::jsonb));
end;
$$;

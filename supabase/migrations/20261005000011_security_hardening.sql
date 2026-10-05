-- ═══════════════════════════════════════════════════════════════════════════
-- EFFI DRINK PASS · 0011 · Endurecimiento de seguridad (auditoría 2026-10-05)
--
--  1. upsert_staff_profile: un usuario sin super_admin ya no puede editar perfiles
--     con más privilegios que él (evita tomar una cuenta super_admin cambiando su email).
--  2. on_login / log_client_event: límite de frecuencia por usuario (audit_logs no se
--     puede borrar; sin límite, cualquier cuenta registrada podía inflarla).
--     log_client_event solo admite eventos de staff, salvo LOGOUT.
--  3. Catálogo RBAC (roles, permisos) y app_settings: visibles solo para el staff.
--  4. request_ip: prioriza cabeceras que el cliente no puede falsificar.
--  5. Webhooks: validación de URL más estricta (userinfo, punto final, .arpa) y
--     entregas solo mientras la integración conserve el scope consumptions:read.
--  6. api_benefit_process: tamaño máximo de metadata, igual que el canal de staff.
--
-- `create or replace` conserva los GRANT existentes de cada función.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────── 1. Gestión de staff ──────────────────────────
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
  v_id      uuid;
  v_missing text;
begin
  perform private.require_permission('users:manage');

  if p_id is not null and p_id = public.current_profile_id() and not p_activo then
    raise exception using errcode = '22023', message = 'CANNOT_DEACTIVATE_SELF';
  end if;

  if p_id is not null and not p_activo and private.is_last_super_admin(p_id) then
    raise exception using errcode = '22023', message = 'LAST_SUPER_ADMIN';
  end if;

  -- Editar un perfil existente equivale a controlar su cuenta: si el perfil aún no está
  -- vinculado, cambiar el email decide QUIÉN lo vinculará en on_login(). Por eso, quien
  -- no es super_admin solo puede editar perfiles que no tengan más privilegios que él.
  if p_id is not null and not public.is_super_admin() then
    if exists (select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
               where ur.user_id = p_id and r.name = 'super_admin') then
      raise exception using errcode = '42501', message = 'ONLY_SUPER_ADMIN_CAN_MANAGE_SUPER_ADMIN';
    end if;
    select pe.name into v_missing
    from public.user_roles ur
    join public.roles r             on r.id = ur.role_id and r.active
    join public.role_permissions rp on rp.role_id = r.id
    join public.permissions pe      on pe.id = rp.permission_id
    where ur.user_id = p_id and not public.has_permission(pe.name)
    limit 1;
    if v_missing is not null then
      raise exception using errcode = '42501', message = 'PRIVILEGE_ESCALATION',
        detail = format('El perfil tiene el permiso %s, que usted no tiene', v_missing);
    end if;
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

-- ───────────────────────────── 2. Eventos de sesión y cliente ───────────────
-- Vincula la cuenta por email verificado y audita LOGIN. El vínculo y la respuesta
-- se dan siempre; solo la fila de auditoría se limita (10 por minuto y usuario).
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

  -- Solo con email VERIFICADO: así nadie se apropia de un perfil pre-registrado.
  if v_email is not null and v_confirmed is not null then
    update public.profiles set auth_user_id = v_uid
     where lower(email) = v_email and auth_user_id is null;
    update public.attendees set auth_user_id = v_uid
     where lower(email) = v_email and auth_user_id is null;
  end if;

  if (private.rate_limit_hit('login:' || v_uid::text, 10, 60) ->> 'allowed')::boolean then
    perform private.write_audit('LOGIN', 'auth_user', v_uid::text, true,
      jsonb_build_object('email', v_email, 'email_confirmed', v_confirmed is not null));
  end if;

  return public.my_access();
end;
$$;

-- Registro de eventos iniciados por el cliente (lista blanca, tamaño y frecuencia acotados).
-- Cualquier cuenta puede registrar LOGOUT; el resto de eventos son exclusivos del staff.
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
  if p_action <> 'LOGOUT' and public.current_profile_id() is null then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if pg_column_size(p_metadata) > 4096 then
    raise exception using errcode = '22023', message = 'METADATA_TOO_LARGE';
  end if;
  if not (private.rate_limit_hit('client-event:' || auth.uid()::text, 30, 60) ->> 'allowed')::boolean then
    raise exception using errcode = '54000', message = 'RATE_LIMITED';
  end if;
  perform private.write_audit(p_action, 'client', null, true, coalesce(p_metadata, '{}'::jsonb));
end;
$$;

-- ───────────────────────────── 3. Catálogo RBAC y configuración ─────────────
-- Antes: using (true) → cualquier cuenta registrada (incluidos asistentes) veía el mapa
-- completo de privilegios y la configuración. Ahora solo el staff activo.
drop policy if exists roles_select on public.roles;
create policy roles_select on public.roles for select to authenticated
  using ((select public.current_profile_id()) is not null);

drop policy if exists permissions_select on public.permissions;
create policy permissions_select on public.permissions for select to authenticated
  using ((select public.current_profile_id()) is not null);

drop policy if exists role_permissions_select on public.role_permissions;
create policy role_permissions_select on public.role_permissions for select to authenticated
  using ((select public.current_profile_id()) is not null);

drop policy if exists app_settings_select on public.app_settings;
create policy app_settings_select on public.app_settings for select to authenticated
  using ((select public.current_profile_id()) is not null);

-- ───────────────────────────── 4. IP del cliente ────────────────────────────
-- cf-connecting-ip la fija Cloudflare (delante de Supabase) y el cliente no puede
-- falsificarla; el primer valor de x-forwarded-for sí, por eso queda como último recurso.
create or replace function private.request_ip()
returns text
language sql stable
set search_path = ''
as $$
  select left(coalesce(
    nullif(btrim(private.request_header('cf-connecting-ip')), ''),
    nullif(btrim(private.request_header('x-real-ip')), ''),
    nullif(btrim(split_part(private.request_header('x-forwarded-for'), ',', 1)), '')
  ), 64)
$$;

-- ───────────────────────────── 5. Webhooks ──────────────────────────────────
create or replace function private.assert_webhook_allowed(p_integration_id uuid, p_url text)
returns void
language plpgsql stable
set search_path = ''
as $$
declare
  -- Autoridad completa (puede incluir userinfo "u@" y puerto) y host sin puerto ni puntos finales.
  v_authority text := lower(substring(p_url from '^https://([^/?#]+)'));
  v_host      text := rtrim(split_part(v_authority, ':', 1), '.');
begin
  if not exists (select 1 from public.api_integrations where id = p_integration_id) then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  -- El evento incluye datos de consumo: la integración debe poder leerlos.
  if not exists (select 1 from public.api_integrations where id = p_integration_id and 'consumptions:read' = any (allowed_scopes)) then
    raise exception using errcode = '22023', message = 'WEBHOOK_REQUIRES_CONSUMPTIONS_SCOPE';
  end if;
  -- Solo HTTPS hacia hosts públicos con nombre: sin credenciales en la URL, sin IPs
  -- literales y sin nombres internos. (El despachador además resuelve el DNS y bloquea
  -- IPs privadas antes de cada entrega.)
  if v_authority is null or v_authority = '' or position('@' in v_authority) > 0
     or v_host = '' or v_host ~ '^[0-9.]+$' or v_host like '[%' or v_host = 'localhost'
     or v_host ~ '\.(local|internal|localhost|lan|home|corp|arpa)$' or position('.' in v_host) = 0 then
    raise exception using errcode = '22023', message = 'INVALID_WEBHOOK_URL';
  end if;
end;
$$;

-- Fan-out: solo a integraciones activas que conservan consumptions:read (si un admin
-- retira el scope, sus webhooks dejan de recibir datos de consumo de inmediato).
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
                                and 'consumptions:read' = any (i.allowed_scopes)
  where s.active and new.event_type = any (s.events)
  on conflict do nothing;
  update private.event_outbox set dispatched_at = now() where id = new.id;
  return null;
end;
$$;

-- Despachador: mismas reglas que el fan-out, también para entregas ya encoladas.
-- Toma un lote vencido con SKIP LOCKED (varios despachadores en paralelo sin duplicar)
-- y lo arrienda p_lease_seconds.
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
                                  and 'consumptions:read' = any (i.allowed_scopes)
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

-- ───────────────────────────── 6. Consumo vía API ───────────────────────────
-- Misma cota de metadata que el canal de staff (benefit_redeem): consumos y auditoría son inmutables.
create or replace function public.api_benefit_process(
  p_actor           jsonb,
  p_mode            text,
  p_token           text,
  p_benefit_id      uuid,
  p_idempotency_key text default null,
  p_metadata        jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  perform private.api_assert_scope(p_actor, case when p_mode = 'validate' then 'benefits:validate' else 'benefits:redeem' end);
  if pg_column_size(coalesce(p_metadata, '{}'::jsonb)) > 2048 then
    raise exception using errcode = '22023', message = 'METADATA_TOO_LARGE';
  end if;
  perform private.set_actor(p_actor);
  return private.process_benefit(p_mode, p_token, p_benefit_id, p_idempotency_key, null, p_metadata);
end;
$$;

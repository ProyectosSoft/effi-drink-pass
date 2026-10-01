-- ═══════════════════════════════════════════════════════════════════════════
-- EFFI DRINK PASS · 0006 · Integraciones externas y funciones para la Edge Function API
-- Credenciales: client_id público + client_secret (256 bits) del que solo se guarda SHA-256.
-- Uso: OAuth2 client_credentials (recomendado) o cabecera X-API-Key.
-- Las funciones api_* solo son ejecutables por service_role (la Edge Function).
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function private.assert_assignable_scopes(p_scopes text[])
returns void
language plpgsql stable
set search_path = ''
as $$
declare
  v_bad text;
begin
  select s into v_bad from unnest(coalesce(p_scopes, '{}')) s
  where not exists (select 1 from public.permissions p where p.name = s and p.integration_assignable)
  limit 1;
  if v_bad is not null then
    raise exception using errcode = '22023', message = 'INVALID_SCOPE', detail = v_bad;
  end if;
end;
$$;

-- ───────────────────────────── Gestión (staff con integrations:manage) ──────
create or replace function public.create_integration(
  p_name text, p_description text, p_allowed_scopes text[], p_contact_email text default null
)
returns uuid
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_permission('integrations:manage');
  perform private.assert_assignable_scopes(p_allowed_scopes);
  insert into public.api_integrations (name, description, allowed_scopes, contact_email, created_by)
  values (btrim(p_name), p_description, coalesce(p_allowed_scopes, '{}'), nullif(btrim(p_contact_email), ''),
          public.current_profile_id())
  returning id into v_id;
  perform private.write_audit('CREATE_INTEGRATION', 'integration', v_id::text, true,
    jsonb_build_object('name', p_name, 'allowed_scopes', to_jsonb(p_allowed_scopes)));
  return v_id;
end;
$$;

create or replace function public.update_integration(
  p_id uuid, p_name text, p_description text, p_allowed_scopes text[], p_contact_email text, p_active boolean
)
returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_old public.api_integrations;
begin
  perform private.require_permission('integrations:manage');
  perform private.assert_assignable_scopes(p_allowed_scopes);
  select * into v_old from public.api_integrations where id = p_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  update public.api_integrations
     set name = btrim(p_name), description = p_description, allowed_scopes = coalesce(p_allowed_scopes, '{}'),
         contact_email = nullif(btrim(p_contact_email), ''), active = p_active
   where id = p_id;
  -- Reducir el techo de scopes recorta también las credenciales existentes.
  update public.api_credentials
     set scopes = array(select s from unnest(scopes) s where s = any (coalesce(p_allowed_scopes, '{}')))
   where integration_id = p_id and not (scopes <@ coalesce(p_allowed_scopes, '{}'));
  perform private.write_audit(
    case when v_old.active and not p_active then 'DISABLE_INTEGRATION'
         when not v_old.active and p_active then 'ENABLE_INTEGRATION'
         else 'UPDATE_INTEGRATION' end,
    'integration', p_id::text, true,
    jsonb_build_object('name', p_name, 'allowed_scopes', to_jsonb(p_allowed_scopes), 'active', p_active));
end;
$$;

create or replace function private.issue_credential(
  p_integration_id uuid, p_scopes text[], p_expires_at timestamptz, p_rotated_from uuid
)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_int    public.api_integrations;
  v_secret text := 'edp_sk_' || private.random_token(32);
  v_client text := 'edp_ci_' || encode(extensions.gen_random_bytes(12), 'hex');
  v_id     uuid;
begin
  select * into v_int from public.api_integrations where id = p_integration_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  if p_scopes is null or cardinality(p_scopes) = 0 then
    raise exception using errcode = '22023', message = 'SCOPES_REQUIRED';
  end if;
  perform private.assert_assignable_scopes(p_scopes);
  if not (p_scopes <@ v_int.allowed_scopes) then
    raise exception using errcode = '22023', message = 'SCOPE_NOT_ALLOWED_FOR_INTEGRATION';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception using errcode = '22023', message = 'INVALID_EXPIRATION';
  end if;

  insert into public.api_credentials (integration_id, client_id, credential_hash, secret_hint, scopes,
                                      expires_at, created_by, rotated_from)
  values (p_integration_id, v_client, private.sha256_hex(v_secret), right(v_secret, 4),
          (select array_agg(distinct s order by s) from unnest(p_scopes) s),
          p_expires_at, public.current_profile_id(), p_rotated_from)
  returning id into v_id;

  -- El secreto se devuelve UNA sola vez. No se puede recuperar después.
  return jsonb_build_object('id', v_id, 'integration_id', p_integration_id, 'client_id', v_client,
                            'client_secret', v_secret, 'api_key', v_client || '.' || v_secret,
                            'scopes', to_jsonb(p_scopes), 'expires_at', p_expires_at);
end;
$$;

create or replace function public.create_api_credential(
  p_integration_id uuid, p_scopes text[], p_expires_at timestamptz default null
)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_res jsonb;
begin
  perform private.require_permission('integrations:manage');
  v_res := private.issue_credential(p_integration_id, p_scopes, p_expires_at, null);
  perform private.write_audit('CREATE_API_KEY', 'api_credential', v_res ->> 'id', true,
    jsonb_build_object('integration_id', p_integration_id, 'client_id', v_res ->> 'client_id',
                       'scopes', to_jsonb(p_scopes), 'expires_at', p_expires_at));
  return v_res;
end;
$$;

create or replace function public.revoke_api_credential(p_credential_id uuid, p_reason text default null)
returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  perform private.require_permission('integrations:manage');
  update public.api_credentials
     set active = false, revoked_at = now(), revoked_by = public.current_profile_id(), revoke_reason = p_reason
   where id = p_credential_id and revoked_at is null;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND_OR_ALREADY_REVOKED';
  end if;
  perform private.write_audit('REVOKE_API_KEY', 'api_credential', p_credential_id::text, true,
    jsonb_build_object('reason', p_reason));
end;
$$;

-- Rotación: emite una credencial nueva con los mismos scopes/expiración y revoca la anterior.
create or replace function public.rotate_api_credential(p_credential_id uuid)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_old public.api_credentials;
  v_res jsonb;
begin
  perform private.require_permission('integrations:manage');
  select * into v_old from public.api_credentials where id = p_credential_id for update;
  if not found or v_old.revoked_at is not null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND_OR_ALREADY_REVOKED';
  end if;
  v_res := private.issue_credential(v_old.integration_id, v_old.scopes,
             case when v_old.expires_at > now() then v_old.expires_at else null end, v_old.id);
  update public.api_credentials
     set active = false, revoked_at = now(), revoked_by = public.current_profile_id(), revoke_reason = 'rotated'
   where id = v_old.id;
  perform private.write_audit('ROTATE_API_KEY', 'api_credential', v_old.id::text, true,
    jsonb_build_object('new_credential_id', v_res ->> 'id', 'new_client_id', v_res ->> 'client_id'));
  return v_res;
end;
$$;

-- ───────────────────────────── Funciones para la Edge Function (service_role) ─
-- Autenticación + rate limit en una sola ida y vuelta.
-- p: { auth: {type:'client_secret', client_id, client_secret} | {type:'credential', credential_id}
--            | {type:'user', auth_user_id} | {type:'none'},
--      rate: {name, limit, window}, ip, user_agent, request_id, issuing_token: bool }
create or replace function public.api_begin_request(p jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_auth      jsonb := coalesce(p -> 'auth', '{"type":"none"}'::jsonb);
  v_type      text := v_auth ->> 'type';
  v_cred      public.api_credentials;
  v_int       public.api_integrations;
  v_principal jsonb;
  v_reason    text;
  v_rl        jsonb;
  v_bucket    text;
  v_prof      record;
begin
  if v_type = 'client_secret' then
    select * into v_cred from public.api_credentials where client_id = v_auth ->> 'client_id';
    if not found or v_cred.credential_hash <> private.sha256_hex(coalesce(v_auth ->> 'client_secret', '')) then
      v_reason := 'INVALID_CREDENTIALS';
    end if;
  elsif v_type = 'credential' then
    select * into v_cred from public.api_credentials where id = nullif(v_auth ->> 'credential_id', '')::uuid;
    if not found then
      v_reason := 'INVALID_CREDENTIALS';
    end if;
  end if;

  if v_type in ('client_secret', 'credential') and v_reason is null then
    select * into v_int from public.api_integrations where id = v_cred.integration_id;
    if not v_cred.active or v_cred.revoked_at is not null then
      v_reason := 'CREDENTIAL_REVOKED';
    elsif v_cred.expires_at is not null and v_cred.expires_at <= now() then
      v_reason := 'CREDENTIAL_EXPIRED';
    elsif not v_int.active then
      v_reason := 'INTEGRATION_DISABLED';
    else
      v_principal := jsonb_build_object(
        'type', 'integration', 'channel', 'api',
        'integration_id', v_int.id, 'credential_id', v_cred.id, 'client_id', v_cred.client_id,
        'label', v_int.name, 'scopes', to_jsonb(v_cred.scopes));
      -- last_used_at con granularidad de 1 minuto para no escribir en cada request.
      if v_cred.last_used_at is null or v_cred.last_used_at < now() - interval '1 minute'
         or coalesce(v_cred.last_used_ip, '') <> coalesce(p ->> 'ip', '') then
        update public.api_credentials set last_used_at = now(), last_used_ip = left(p ->> 'ip', 64)
         where id = v_cred.id;
      end if;
    end if;
  elsif v_type = 'user' then
    select pr.id, btrim(pr.nombres || ' ' || pr.apellidos) as label, pr.activo into v_prof
    from public.profiles pr where pr.auth_user_id = nullif(v_auth ->> 'auth_user_id', '')::uuid;
    if v_prof.id is null or not v_prof.activo then
      v_reason := 'USER_NOT_AUTHORIZED';
    else
      v_principal := jsonb_build_object(
        'type', 'user', 'channel', 'api', 'profile_id', v_prof.id,
        'auth_user_id', v_auth ->> 'auth_user_id', 'label', v_prof.label,
        'scopes', coalesce((
          select jsonb_agg(distinct pe.name)
          from public.user_roles ur
          join public.roles r on r.id = ur.role_id and r.active
          join public.role_permissions rp on rp.role_id = r.id
          join public.permissions pe on pe.id = rp.permission_id
          where ur.user_id = v_prof.id), '[]'::jsonb));
    end if;
  else
    v_principal := jsonb_build_object('type', 'anonymous', 'channel', 'api', 'scopes', '[]'::jsonb);
  end if;

  if v_principal is not null then
    v_principal := v_principal || jsonb_build_object('ip', p ->> 'ip', 'user_agent', p ->> 'user_agent',
                                                     'request_id', p ->> 'request_id');
  end if;

  if v_reason is not null then
    perform private.set_actor(jsonb_build_object('type', 'anonymous', 'label', coalesce(v_auth ->> 'client_id', v_type),
      'ip', p ->> 'ip', 'user_agent', p ->> 'user_agent', 'request_id', p ->> 'request_id'));
    perform private.write_audit('API_AUTH_FAILED', 'api_credential', v_cred.id::text, false,
      jsonb_build_object('reason', v_reason, 'client_id', v_auth ->> 'client_id', 'auth_type', v_type));
    -- Rate limit de fallos por IP (protección contra fuerza bruta).
    v_rl := private.rate_limit_hit('auth-fail:' || coalesce(p ->> 'ip', 'unknown'), 20, 300);
    return jsonb_build_object('ok', false, 'error', v_reason, 'rate', v_rl);
  end if;

  if p ? 'rate' then
    v_bucket := concat_ws(':', 'api', p -> 'rate' ->> 'name',
      coalesce(v_principal ->> 'credential_id', v_principal ->> 'profile_id', p ->> 'ip', 'unknown'));
    v_rl := private.rate_limit_hit(v_bucket, coalesce((p -> 'rate' ->> 'limit')::int, 300),
                                   coalesce((p -> 'rate' ->> 'window')::int, 60));
  end if;

  if coalesce((p ->> 'issuing_token')::boolean, false) then
    perform private.set_actor(v_principal);
    perform private.write_audit('API_TOKEN_ISSUED', 'api_credential', v_cred.id::text, true,
      jsonb_build_object('client_id', v_cred.client_id));
  end if;

  return jsonb_build_object('ok', true, 'principal', v_principal, 'rate', v_rl);
end;
$$;

-- Bloqueo previo por IP tras demasiados fallos de autenticación.
create or replace function public.api_auth_blocked(p_ip text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce((
    select r.hits >= 20 from private.rate_limits r
    where r.bucket = 'auth-fail:' || coalesce(p_ip, 'unknown')
      and r.window_start = to_timestamp(floor(extract(epoch from now()) / 300) * 300)), false)
$$;

create or replace function private.api_assert_scope(p_actor jsonb, p_scope text)
returns void
language plpgsql stable
set search_path = ''
as $$
begin
  if not coalesce((p_actor -> 'scopes') ? p_scope, false) then
    raise exception using errcode = '42501', message = 'INSUFFICIENT_SCOPE', detail = p_scope;
  end if;
end;
$$;

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
  perform private.set_actor(p_actor);
  return private.process_benefit(p_mode, p_token, p_benefit_id, p_idempotency_key, null, p_metadata);
end;
$$;

create or replace function public.api_upsert_attendee(
  p_actor jsonb, p_id uuid, p_data jsonb, p_partial boolean, p_event_day_ids uuid[] default null
)
returns uuid
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  perform private.api_assert_scope(p_actor, 'attendees:write');
  perform private.set_actor(p_actor);
  return private.upsert_attendee(p_id, p_data, p_partial, p_event_day_ids);
end;
$$;

create or replace function public.api_set_attendee_days(p_actor jsonb, p_attendee_id uuid, p_event_day_ids uuid[])
returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  perform private.api_assert_scope(p_actor, 'attendees:write');
  perform private.set_actor(p_actor);
  if not exists (select 1 from public.attendees where id = p_attendee_id) then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  perform private.set_attendee_days(p_attendee_id, coalesce(p_event_day_ids, '{}'));
end;
$$;

create or replace function public.api_generate_benefits(p_actor jsonb, p_attendee_ids uuid[] default null)
returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  perform private.api_assert_scope(p_actor, 'benefits:write');
  perform private.set_actor(p_actor);
  v_count := private.generate_benefits(p_attendee_ids);
  perform private.write_audit('GENERATE_BENEFITS', 'benefit', null, true,
    jsonb_build_object('created', v_count, 'attendee_ids', to_jsonb(p_attendee_ids)));
  return v_count;
end;
$$;

create or replace function public.api_audit(p_actor jsonb, p_action text, p_resource_type text,
                                            p_resource_id text, p_success boolean, p_metadata jsonb)
returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  perform private.set_actor(p_actor);
  perform private.write_audit(p_action, p_resource_type, p_resource_id, p_success, coalesce(p_metadata, '{}'::jsonb));
end;
$$;

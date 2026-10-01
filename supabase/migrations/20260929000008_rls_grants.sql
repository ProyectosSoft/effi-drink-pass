-- ═══════════════════════════════════════════════════════════════════════════
-- EFFI DRINK PASS · 0008 · Row Level Security y privilegios
-- Modelo: RLS habilitado en TODAS las tablas. Los clientes (anon/authenticated)
-- solo tienen políticas SELECT; toda escritura pasa por funciones SECURITY DEFINER
-- que validan permisos, reglas de negocio y registran auditoría.
-- service_role (solo Edge Functions) ejecuta las funciones api_*.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.profiles            enable row level security;
alter table public.roles               enable row level security;
alter table public.permissions         enable row level security;
alter table public.role_permissions    enable row level security;
alter table public.user_roles          enable row level security;
alter table public.attendees           enable row level security;
alter table public.event_days          enable row level security;
alter table public.attendee_event_days enable row level security;
alter table public.benefits            enable row level security;
alter table public.consumptions        enable row level security;
alter table public.api_integrations    enable row level security;
alter table public.api_credentials     enable row level security;
alter table public.audit_logs          enable row level security;
alter table public.app_settings        enable row level security;

-- ───────────────────────────── Políticas (solo lectura) ─────────────────────
create policy profiles_select on public.profiles for select to authenticated
  using (auth_user_id = (select auth.uid()) or (select public.has_permission('users:manage')));

create policy roles_select on public.roles for select to authenticated using (true);
create policy permissions_select on public.permissions for select to authenticated using (true);
create policy role_permissions_select on public.role_permissions for select to authenticated using (true);

create policy user_roles_select on public.user_roles for select to authenticated
  using (user_id = (select public.current_profile_id()) or (select public.has_permission('users:manage')));

-- Asistente: solo su propio registro. Staff: con attendees:read.
create policy attendees_select on public.attendees for select to authenticated
  using (auth_user_id = (select auth.uid()) or (select public.has_permission('attendees:read')));

-- Días del evento: información pública (fechas y horarios).
create policy event_days_select on public.event_days for select to anon, authenticated using (true);

create policy attendee_event_days_select on public.attendee_event_days for select to authenticated
  using (attendee_id = (select public.current_attendee_id()) or (select public.has_permission('attendees:read')));

create policy benefits_select on public.benefits for select to authenticated
  using (attendee_id = (select public.current_attendee_id()) or (select public.has_permission('benefits:read')));

create policy consumptions_select on public.consumptions for select to authenticated
  using (attendee_id = (select public.current_attendee_id()) or (select public.has_permission('consumptions:read')));

create policy api_integrations_select on public.api_integrations for select to authenticated
  using ((select public.has_permission('integrations:manage')));

create policy api_credentials_select on public.api_credentials for select to authenticated
  using ((select public.has_permission('integrations:manage')));

create policy audit_logs_select on public.audit_logs for select to authenticated
  using ((select public.has_permission('audit:read')));

create policy app_settings_select on public.app_settings for select to authenticated using (true);

-- ───────────────────────────── Privilegios de tabla ─────────────────────────
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select on public.event_days to anon, authenticated;
grant select on public.profiles, public.roles, public.permissions, public.role_permissions, public.user_roles,
               public.attendees, public.attendee_event_days, public.consumptions, public.api_integrations,
               public.audit_logs, public.app_settings, public.consumption_details, public.benefit_details
  to authenticated;

-- Columnas sensibles nunca legibles por clientes: token_hash, token_salt, credential_hash.
grant select (id, attendee_id, event_day_id, status, generated_at, consumed_at, consumed_by,
              consumed_by_integration, expiration_at, cancelled_at, cancelled_by, cancel_reason,
              created_at, updated_at)
  on public.benefits to authenticated;
grant select (id, integration_id, client_id, secret_hint, scopes, active, expires_at, last_used_at,
              last_used_ip, created_by, created_at, revoked_at, revoked_by, revoke_reason, rotated_from)
  on public.api_credentials to authenticated;

grant all on all tables    in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- ───────────────────────────── Privilegios de funciones ─────────────────────
revoke execute on all functions in schema public  from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;

-- Helpers usados por las políticas RLS
grant execute on function public.has_permission(text)   to authenticated;
grant execute on function public.current_profile_id()   to authenticated;
grant execute on function public.current_attendee_id()  to authenticated;
grant execute on function public.is_super_admin()       to authenticated;

-- Sesión
grant execute on function public.on_login()                      to authenticated;
grant execute on function public.my_access()                     to authenticated;
grant execute on function public.log_client_event(text, jsonb)   to authenticated;
grant execute on function public.server_time()                   to anon, authenticated;

-- Portal del asistente
grant execute on function public.get_my_benefits()               to authenticated;
grant execute on function public.get_my_benefit_token(uuid)      to authenticated;

-- Operación (cada función valida su permiso internamente)
grant execute on function public.benefit_validate(text, uuid)                         to authenticated;
grant execute on function public.benefit_redeem(text, uuid, text, jsonb)              to authenticated;
grant execute on function public.benefit_override_redeem(uuid, text, text)            to authenticated;
grant execute on function public.generate_benefits(uuid[])                            to authenticated;
grant execute on function public.cancel_benefit(uuid, text)                           to authenticated;
grant execute on function public.restore_benefit(uuid, text)                          to authenticated;
grant execute on function public.regenerate_benefit_token(uuid, text)                 to authenticated;
grant execute on function public.expire_benefits()                                    to authenticated;

-- Administración
grant execute on function public.upsert_attendee(uuid, jsonb, boolean, uuid[])        to authenticated;
grant execute on function public.set_attendee_days(uuid, uuid[])                      to authenticated;
grant execute on function public.assign_day_to_attendees(uuid, text)                  to authenticated;
grant execute on function public.upsert_event_day(uuid, date, text, time, time, boolean) to authenticated;
grant execute on function public.update_setting(text, jsonb)                          to authenticated;
grant execute on function public.import_attendees(jsonb, text, boolean, uuid[], text) to authenticated;
grant execute on function public.upsert_staff_profile(uuid, text, text, text, text, boolean) to authenticated;
grant execute on function public.set_user_roles(uuid, uuid[])                         to authenticated;
grant execute on function public.upsert_role(uuid, text, text, boolean)               to authenticated;
grant execute on function public.set_role_permissions(uuid, text[])                   to authenticated;
grant execute on function public.create_integration(text, text, text[], text)         to authenticated;
grant execute on function public.update_integration(uuid, text, text, text[], text, boolean) to authenticated;
grant execute on function public.create_api_credential(uuid, text[], timestamptz)     to authenticated;
grant execute on function public.revoke_api_credential(uuid, text)                    to authenticated;
grant execute on function public.rotate_api_credential(uuid)                          to authenticated;
grant execute on function public.get_statistics(jsonb)                                to authenticated;
grant execute on function public.get_report(text, jsonb)                              to authenticated;

-- Edge Function (service_role): funciones públicas (incluidas las api_*).
grant execute on all functions in schema public  to service_role;

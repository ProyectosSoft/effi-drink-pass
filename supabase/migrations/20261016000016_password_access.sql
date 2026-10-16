-- Resolución autorizada de cuentas para contraseñas temporales sin envío de correo.
create function public.password_access_target(p_email text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_user uuid; v_email text := lower(btrim(p_email)); v_rate jsonb;
begin
  perform private.require_permission('users:manage');
  if not public.is_super_admin() then raise exception 'FORBIDDEN'; end if;
  v_rate := private.rate_limit_hit('password-admin:' || auth.uid()::text, 20, 60);
  if not (v_rate ->> 'allowed')::boolean then raise exception 'RATE_LIMITED'; end if;
  if not exists(select 1 from public.profiles where lower(email) = v_email and activo)
     and not exists(select 1 from public.attendees where lower(email) = v_email and activo) then
    raise exception 'NOT_FOUND';
  end if;
  select id into v_user from auth.users where lower(email) = v_email;
  if v_user = auth.uid() then raise exception 'USE_ACCOUNT_PASSWORD'; end if;
  perform private.write_audit('ISSUE_TEMPORARY_PASSWORD', 'auth_user', coalesce(v_user::text, v_email), true, '{}'::jsonb);
  return jsonb_build_object('user_id', v_user, 'email', v_email);
end;
$$;
revoke all on function public.password_access_target(text) from public, anon, authenticated;
grant execute on function public.password_access_target(text) to authenticated;

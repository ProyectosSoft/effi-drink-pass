-- ═══════════════════════════════════════════════════════════════════════════
-- Crear el PRIMER Super Admin (una sola vez por proyecto).
-- Ejecutar en: Supabase Dashboard → SQL Editor (corre como postgres).
--
-- Pasos:
--   1. Cambie el email y el nombre de abajo.
--   2. Ejecute el script. Crea el perfil de staff y le asigna el rol super_admin.
--   3. Esa persona entra a /login → "Código por email" con ESE email.
--      Al verificar el código, on_login() vincula su cuenta automáticamente.
--   4. (Opcional) En "Mi cuenta" define una contraseña.
--
-- Los siguientes usuarios del staff se crean desde /admin/users (no con SQL).
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_email     text := 'admin@su-dominio.com';   -- ← CAMBIAR
  v_nombres   text := 'Nombre';                 -- ← CAMBIAR
  v_apellidos text := 'Apellido';               -- ← CAMBIAR
  v_profile   uuid;
begin
  if v_email = 'admin@su-dominio.com' then
    raise exception 'Edite el email del script antes de ejecutarlo';
  end if;

  insert into public.profiles (email, nombres, apellidos)
  values (v_email, v_nombres, v_apellidos)
  on conflict ((lower(email))) do update set activo = true
  returning id into v_profile;

  -- Si la persona ya había iniciado sesión antes, vincular de una vez.
  update public.profiles p set auth_user_id = u.id
    from auth.users u
   where p.id = v_profile and p.auth_user_id is null
     and lower(u.email) = lower(v_email) and u.email_confirmed_at is not null;

  insert into public.user_roles (user_id, role_id)
  select v_profile, r.id from public.roles r where r.name = 'super_admin'
  on conflict do nothing;

  perform private.write_audit('BOOTSTRAP_SUPER_ADMIN', 'profile', v_profile::text, true,
    jsonb_build_object('email', lower(v_email)));

  raise notice 'Super Admin listo: % (perfil %)', v_email, v_profile;
end $$;

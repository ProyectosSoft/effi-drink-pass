-- ═══════════════════════════════════════════════════════════════════════════
-- EFFI DRINK PASS · 0002 · Tablas del dominio
-- IDs internos UUID propios. effi_id / effi_username son SOLO identificadores
-- externos opcionales: nunca PK, nunca obligatorios.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────── Staff (administradores / operadores) ─────────
create table public.profiles (
  id           uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users (id) on delete set null,
  nombres      text not null check (length(nombres) between 1 and 120),
  apellidos    text not null default '' check (length(apellidos) <= 120),
  email        text not null check (length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  telefono     text check (length(telefono) <= 40),
  activo       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index profiles_email_uq on public.profiles (lower(email));

-- ───────────────────────────── RBAC ─────────────────────────────────────────
create table public.roles (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique check (name ~ '^[a-z][a-z0-9_]{1,49}$'),
  description text check (length(description) <= 300),
  active      boolean not null default true,
  is_system   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.permissions (
  id                     uuid primary key default gen_random_uuid(),
  name                   text not null unique check (name ~ '^[a-z-]+:[a-z-]+$'),
  description            text,
  -- ¿Puede asignarse como scope a una integración externa?
  integration_assignable boolean not null default false
);

create table public.role_permissions (
  role_id       uuid not null references public.roles (id) on delete cascade,
  permission_id uuid not null references public.permissions (id) on delete cascade,
  primary key (role_id, permission_id)
);

create table public.user_roles (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  role_id    uuid not null references public.roles (id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete set null,
  primary key (user_id, role_id)
);
create index user_roles_role_idx on public.user_roles (role_id);

-- ───────────────────────────── Asistentes ───────────────────────────────────
create table public.attendees (
  id            uuid primary key default gen_random_uuid(),
  -- Cuenta propia del asistente en ESTE sistema (Supabase Auth). Se vincula por email verificado.
  auth_user_id  uuid unique references auth.users (id) on delete set null,
  nombres       text not null check (length(nombres) between 1 and 120),
  apellidos     text not null default '' check (length(apellidos) <= 120),
  email         text check (length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  telefono      text check (length(telefono) <= 40),
  effi_id       text check (length(effi_id) <= 64),
  effi_username text check (length(effi_username) <= 120),
  tipo_acceso   text not null default 'GENERAL' check (tipo_acceso ~ '^[A-Z0-9][A-Z0-9 _-]{0,39}$'),
  empresa       text check (length(empresa) <= 200),
  activo        boolean not null default true,
  metadata      jsonb not null default '{}'::jsonb
                check (jsonb_typeof(metadata) = 'object' and pg_column_size(metadata) < 16384),
  is_demo       boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index attendees_email_uq         on public.attendees (lower(email)) where email is not null;
create unique index attendees_effi_id_uq       on public.attendees (effi_id) where effi_id is not null;
create unique index attendees_effi_username_uq on public.attendees (lower(effi_username)) where effi_username is not null;
create index attendees_tipo_acceso_idx on public.attendees (tipo_acceso);
create index attendees_empresa_idx     on public.attendees (lower(empresa));
create index attendees_nombre_idx      on public.attendees (lower(nombres || ' ' || apellidos));

create or replace function private.normalize_attendee()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.nombres       := btrim(regexp_replace(coalesce(new.nombres, ''), '\s+', ' ', 'g'));
  new.apellidos     := btrim(regexp_replace(coalesce(new.apellidos, ''), '\s+', ' ', 'g'));
  new.email         := nullif(lower(btrim(new.email)), '');
  new.telefono      := nullif(btrim(new.telefono), '');
  new.effi_id       := nullif(btrim(new.effi_id), '');
  new.effi_username := nullif(btrim(new.effi_username), '');
  new.tipo_acceso   := upper(coalesce(nullif(btrim(new.tipo_acceso), ''), 'GENERAL'));
  new.empresa       := nullif(btrim(regexp_replace(coalesce(new.empresa, ''), '\s+', ' ', 'g')), '');
  new.metadata      := coalesce(new.metadata, '{}'::jsonb);
  return new;
end;
$$;

create trigger attendees_normalize before insert or update on public.attendees
  for each row execute function private.normalize_attendee();
create trigger attendees_touch before update on public.attendees
  for each row execute function private.touch_updated_at();

create or replace function private.normalize_profile()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.nombres   := btrim(regexp_replace(coalesce(new.nombres, ''), '\s+', ' ', 'g'));
  new.apellidos := btrim(regexp_replace(coalesce(new.apellidos, ''), '\s+', ' ', 'g'));
  new.email     := lower(btrim(new.email));
  new.telefono  := nullif(btrim(new.telefono), '');
  return new;
end;
$$;

create trigger profiles_normalize before insert or update on public.profiles
  for each row execute function private.normalize_profile();
create trigger profiles_touch before update on public.profiles
  for each row execute function private.touch_updated_at();
create trigger roles_touch before update on public.roles
  for each row execute function private.touch_updated_at();

-- ───────────────────────────── Días del evento ──────────────────────────────
create table public.event_days (
  id         uuid primary key default gen_random_uuid(),
  date       date not null unique,
  name       text not null check (length(name) between 1 and 80),
  active     boolean not null default true,
  start_time time not null default '08:00',
  end_time   time not null default '20:00',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_time > start_time)
);
create trigger event_days_touch before update on public.event_days
  for each row execute function private.touch_updated_at();

create table public.attendee_event_days (
  id           uuid primary key default gen_random_uuid(),
  attendee_id  uuid not null references public.attendees (id) on delete cascade,
  event_day_id uuid not null references public.event_days (id) on delete restrict,
  eligible     boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (attendee_id, event_day_id)
);
create index attendee_event_days_day_idx on public.attendee_event_days (event_day_id) where eligible;
create trigger attendee_event_days_touch before update on public.attendee_event_days
  for each row execute function private.touch_updated_at();

-- ───────────────────────────── Integraciones externas ───────────────────────
create table public.api_integrations (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (length(name) between 2 and 100),
  description    text check (length(description) <= 500),
  contact_email  text check (length(contact_email) <= 254),
  active         boolean not null default true,
  -- Techo de scopes que pueden recibir las credenciales de esta integración.
  allowed_scopes text[] not null default '{}',
  created_by     uuid references public.profiles (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index api_integrations_name_uq on public.api_integrations (lower(name));
create trigger api_integrations_touch before update on public.api_integrations
  for each row execute function private.touch_updated_at();

create table public.api_credentials (
  id              uuid primary key default gen_random_uuid(),
  integration_id  uuid not null references public.api_integrations (id) on delete restrict,
  client_id       text not null unique,
  -- SHA-256 del client_secret (secreto de 256 bits aleatorios). El secreto no se guarda.
  credential_hash text not null,
  secret_hint     text not null,
  scopes          text[] not null,
  active          boolean not null default true,
  expires_at      timestamptz,
  last_used_at    timestamptz,
  last_used_ip    text,
  created_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  revoked_at      timestamptz,
  revoked_by      uuid references public.profiles (id) on delete set null,
  revoke_reason   text,
  rotated_from    uuid references public.api_credentials (id) on delete set null,
  check (not (active and revoked_at is not null))
);
create index api_credentials_integration_idx on public.api_credentials (integration_id);

-- ───────────────────────────── Beneficios ───────────────────────────────────
create table public.benefits (
  id                      uuid primary key default gen_random_uuid(),
  attendee_id             uuid not null references public.attendees (id) on delete restrict,
  event_day_id            uuid not null references public.event_days (id) on delete restrict,
  -- SHA-256 del token del QR. El token se deriva con HMAC y nunca se almacena.
  token_hash              text not null unique,
  token_salt              text not null,
  status                  public.benefit_status not null default 'PENDING',
  generated_at            timestamptz not null default now(),
  consumed_at             timestamptz,
  consumed_by             uuid references public.profiles (id) on delete restrict,
  consumed_by_integration uuid references public.api_integrations (id) on delete restrict,
  expiration_at           timestamptz not null,
  cancelled_at            timestamptz,
  cancelled_by            uuid references public.profiles (id) on delete set null,
  cancel_reason           text check (length(cancel_reason) <= 500),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (attendee_id, event_day_id),
  check ((status = 'CONSUMED') = (consumed_at is not null))
);
create index benefits_event_day_status_idx on public.benefits (event_day_id, status);
create index benefits_status_idx           on public.benefits (status);

-- ───────────────────────────── Consumos (historial inmutable) ───────────────
create table public.consumptions (
  id              uuid primary key default gen_random_uuid(),
  -- UNIQUE: segunda barrera física contra doble consumo.
  benefit_id      uuid not null unique references public.benefits (id) on delete restrict,
  attendee_id     uuid not null references public.attendees (id) on delete restrict,
  event_day_id    uuid not null references public.event_days (id) on delete restrict,
  operator_id     uuid references public.profiles (id) on delete restrict,
  integration_id  uuid references public.api_integrations (id) on delete restrict,
  credential_id   uuid references public.api_credentials (id) on delete restrict,
  operator_label  text,           -- nombre del operador/integración al momento del consumo
  consumed_at     timestamptz not null,
  is_override     boolean not null default false,
  override_reason text,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  check (operator_id is not null or integration_id is not null),
  check (not is_override or override_reason is not null)
);
create index consumptions_consumed_at_idx on public.consumptions (consumed_at desc);
create index consumptions_day_idx         on public.consumptions (event_day_id);
create index consumptions_operator_idx    on public.consumptions (operator_id);

create trigger consumptions_immutable before update or delete on public.consumptions
  for each row execute function private.forbid_mutation();
create trigger consumptions_no_truncate before truncate on public.consumptions
  for each statement execute function private.forbid_mutation();

-- ───────────────────────────── Auditoría (inmutable) ────────────────────────
-- Sin FKs a propósito: el log sobrevive a cualquier cambio en los datos referenciados.
create table public.audit_logs (
  id                 bigint generated always as identity primary key,
  occurred_at        timestamptz not null default now(),
  actor_type         text not null check (actor_type in ('user', 'integration', 'system', 'anonymous')),
  actor_profile_id   uuid,
  actor_auth_user_id uuid,
  actor_label        text,
  integration_id     uuid,
  credential_id      uuid,
  action             text not null,
  resource_type      text,
  resource_id        text,
  success            boolean not null default true,
  ip                 text,
  user_agent         text,
  request_id         text,
  metadata           jsonb not null default '{}'::jsonb
);
create index audit_logs_occurred_idx on public.audit_logs (occurred_at desc);
create index audit_logs_action_idx   on public.audit_logs (action, occurred_at desc);
create index audit_logs_resource_idx on public.audit_logs (resource_type, resource_id);
create index audit_logs_actor_idx    on public.audit_logs (actor_profile_id, occurred_at desc);
create index audit_logs_integration_idx on public.audit_logs (integration_id, occurred_at desc);

create trigger audit_logs_immutable before update or delete on public.audit_logs
  for each row execute function private.forbid_mutation();
create trigger audit_logs_no_truncate before truncate on public.audit_logs
  for each statement execute function private.forbid_mutation();

-- ───────────────────────────── Configuración de la aplicación ───────────────
create table public.app_settings (
  key         text primary key check (key ~ '^[a-z][a-z0-9_]{1,59}$'),
  value       jsonb not null,
  description text,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles (id) on delete set null
);

insert into public.app_settings (key, value, description) values
  ('event_name',                  '"Feria Effix 2026"', 'Nombre del evento mostrado en la aplicación'),
  ('scanner_default_mode',        '"confirm"',          'Modo por defecto del scanner: "auto" o "confirm"'),
  ('scanner_auto_return_seconds', '4',                  'Segundos antes de volver al scanner tras un resultado'),
  ('support_contact',             '""',                 'Texto de contacto/soporte mostrado a los asistentes')
on conflict (key) do nothing;

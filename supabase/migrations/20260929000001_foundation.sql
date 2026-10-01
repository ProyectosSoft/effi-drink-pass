-- ═══════════════════════════════════════════════════════════════════════════
-- EFFI DRINK PASS · 0001 · Fundaciones
-- Extensiones, esquema privado, reloj del servidor, rate limiting, idempotencia,
-- outbox de eventos (webhooks futuros) y utilidades comunes.
-- Este sistema es independiente de Effi: no hay referencias a bases de datos externas.
-- ═══════════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto with schema extensions;

-- Esquema privado: NO expuesto por PostgREST y sin USAGE para anon/authenticated.
create schema if not exists private;
revoke all on schema private from public;

-- Las funciones nuevas no quedan ejecutables por PUBLIC/anon/authenticated por defecto.
-- Cada función pública se habilita explícitamente en la migración de grants.
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema private revoke execute on functions from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'alter default privileges in schema public revoke execute on functions from anon, authenticated';
  end if;
end $$;

-- ───────────────────────────── Configuración y secretos del servidor ─────────
create table private.config (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

-- allow_clock_override=true SOLO en entornos de prueba (permite simular la hora).
-- En producción debe permanecer en false: el reloj es siempre now() del servidor.
insert into private.config (key, value) values ('allow_clock_override', 'false')
on conflict (key) do nothing;

create table private.secrets (
  name       text primary key,
  value      text not null,
  created_at timestamptz not null default now()
);

-- Secreto HMAC para derivar los tokens de QR. Nunca sale de la base de datos.
insert into private.secrets (name, value)
values ('qr_hmac_secret', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (name) do nothing;

-- ───────────────────────────── Reloj del servidor (America/Bogota) ───────────
create or replace function private.app_now()
returns timestamptz
language plpgsql stable
set search_path = ''
as $$
declare
  v_override text;
begin
  if coalesce((select c.value from private.config c where c.key = 'allow_clock_override'), 'false') = 'true' then
    v_override := nullif(current_setting('app.now_override', true), '');
    if v_override is not null then
      return v_override::timestamptz;
    end if;
  end if;
  return now();
end;
$$;

create or replace function private.bogota_today()
returns date
language sql stable
set search_path = ''
as $$ select (private.app_now() at time zone 'America/Bogota')::date $$;

-- ───────────────────────────── Utilidades ────────────────────────────────────
create or replace function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function private.forbid_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using
    errcode = '42501',
    message = format('La tabla %s es inmutable (operación %s no permitida)', tg_table_name, tg_op);
end;
$$;

-- Cabeceras HTTP que PostgREST expone en request.headers (llamadas directas del frontend).
create or replace function private.request_header(p_name text)
returns text
language plpgsql stable
set search_path = ''
as $$
declare
  v_headers text := nullif(current_setting('request.headers', true), '');
begin
  if v_headers is null then
    return null;
  end if;
  return (v_headers::json) ->> lower(p_name);
exception when others then
  return null;
end;
$$;

create or replace function private.request_ip()
returns text
language sql stable
set search_path = ''
as $$
  select left(coalesce(
    nullif(btrim(split_part(private.request_header('x-forwarded-for'), ',', 1)), ''),
    private.request_header('cf-connecting-ip'),
    private.request_header('x-real-ip')
  ), 64)
$$;

create or replace function private.request_user_agent()
returns text
language sql stable
set search_path = ''
as $$ select left(private.request_header('user-agent'), 400) $$;

create or replace function private.sha256_hex(p_value text)
returns text
language sql immutable
set search_path = ''
as $$ select encode(extensions.digest(convert_to(p_value, 'UTF8'), 'sha256'), 'hex') $$;

-- Genera un secreto aleatorio en base64url sin padding (n bytes de entropía).
create or replace function private.random_token(p_bytes int default 32)
returns text
language sql volatile
set search_path = ''
as $$
  select rtrim(translate(encode(extensions.gen_random_bytes(p_bytes), 'base64'), E'+/\n', '-_'), '=')
$$;

-- ───────────────────────────── Rate limiting (ventana fija) ──────────────────
create table private.rate_limits (
  bucket       text not null,
  window_start timestamptz not null,
  hits         integer not null default 0,
  primary key (bucket, window_start)
);

create or replace function private.rate_limit_hit(p_bucket text, p_limit int, p_window_seconds int)
returns jsonb
language plpgsql volatile
set search_path = ''
as $$
declare
  v_now   timestamptz := clock_timestamp();
  v_start timestamptz;
  v_reset timestamptz;
  v_hits  int;
begin
  v_start := to_timestamp(floor(extract(epoch from v_now) / p_window_seconds) * p_window_seconds);
  v_reset := v_start + make_interval(secs => p_window_seconds);

  insert into private.rate_limits as r (bucket, window_start, hits)
  values (p_bucket, v_start, 1)
  on conflict (bucket, window_start) do update set hits = r.hits + 1
  returning r.hits into v_hits;

  -- Limpieza oportunista de ventanas viejas.
  if random() < 0.01 then
    delete from private.rate_limits where window_start < v_now - interval '2 hours';
  end if;

  return jsonb_build_object(
    'allowed',     v_hits <= p_limit,
    'limit',       p_limit,
    'remaining',   greatest(p_limit - v_hits, 0),
    'reset_at',    v_reset,
    'retry_after', greatest(ceil(extract(epoch from (v_reset - v_now)))::int, 1)
  );
end;
$$;

-- ───────────────────────────── Idempotencia ──────────────────────────────────
create table private.idempotency_keys (
  scope       text not null,          -- actor (credencial / perfil)
  key         text not null,          -- valor de Idempotency-Key
  fingerprint text not null,          -- hash de los parámetros de la petición
  response    jsonb,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '48 hours',
  primary key (scope, key)
);
create index idempotency_keys_expires_idx on private.idempotency_keys (expires_at);

-- ───────────────────────────── Outbox de eventos (webhooks futuros) ──────────
-- Cada evento de dominio (p. ej. benefit.consumed) se inserta en la MISMA transacción
-- que lo produce. Un despachador (Edge Function programada) podrá entregarlos a
-- suscriptores externos con reintentos, sin afectar la operación del scanner.
create table private.event_outbox (
  id            bigint generated always as identity primary key,
  event_type    text not null,
  payload       jsonb not null,
  occurred_at   timestamptz not null default now(),
  dispatched_at timestamptz,
  attempts      integer not null default 0,
  last_error    text
);
create index event_outbox_pending_idx on private.event_outbox (occurred_at) where dispatched_at is null;

create or replace function private.enqueue_event(p_type text, p_payload jsonb)
returns void
language sql volatile
set search_path = ''
as $$
  insert into private.event_outbox (event_type, payload) values (p_type, p_payload)
$$;

-- ───────────────────────────── Tipos ─────────────────────────────────────────
create type public.benefit_status as enum ('PENDING', 'CONSUMED', 'EXPIRED', 'CANCELLED');

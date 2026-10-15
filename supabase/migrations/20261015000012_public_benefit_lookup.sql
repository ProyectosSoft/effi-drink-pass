-- Acceso público por correo o ID Effi, autorizado para el punto de entrada de la feria.
-- No autentica al usuario ni concede acceso al portal o al staff.
-- Reutiliza la validación y el token existentes; nunca genera ni consume beneficios.
create or replace function public.lookup_drink_benefit(p_kind text, p_identifier text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_identifier text := btrim(coalesce(p_identifier, ''));
  v_attendee_id uuid;
  v_benefit public.benefits;
  v_result jsonb;
  v_rate jsonb;
begin
  v_rate := private.rate_limit_hit('public-benefit:' || coalesce(private.request_ip(), 'unknown'), 60, 60);
  if not (v_rate ->> 'allowed')::boolean then
    return jsonb_build_object('available', false, 'code', 'RATE_LIMITED', 'retry_after', v_rate -> 'retry_after');
  end if;
  if p_kind is null or p_kind not in ('email', 'effi_id') or length(v_identifier) not between 1 and 254
     or (p_kind = 'effi_id' and length(v_identifier) > 64) then
    return jsonb_build_object('available', false, 'code', 'NOT_AVAILABLE');
  end if;

  if p_kind = 'email' then
    select id into v_attendee_id from public.attendees where lower(email) = lower(v_identifier);
  else
    select id into v_attendee_id from public.attendees where effi_id = v_identifier;
  end if;

  select b.* into v_benefit from public.benefits b
  join public.event_days d on d.id = b.event_day_id
  where b.attendee_id = v_attendee_id and d.date = private.bogota_today();
  if not found then
    return jsonb_build_object('available', false, 'code', 'NOT_AVAILABLE');
  end if;

  -- Exactamente las mismas reglas que usa el scanner, en modo consulta.
  v_result := private.process_benefit('validate', null, v_benefit.id);
  if v_result ->> 'code' <> 'VALID' then
    return jsonb_build_object('available', false, 'code', v_result ->> 'code');
  end if;

  return jsonb_build_object(
    'available', true,
    'code', 'VALID',
    'token', private.benefit_token(v_benefit.id, v_benefit.token_salt),
    'event_day', v_result #> '{benefit,event_day}',
    'server_time', v_result -> 'server_time'
  );
end;
$$;

revoke all on function public.lookup_drink_benefit(text, text) from public;
grant execute on function public.lookup_drink_benefit(text, text) to anon, authenticated;

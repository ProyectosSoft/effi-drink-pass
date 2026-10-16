-- Registro administrativo de entregas realizadas hoy o en días anteriores.
insert into public.permissions(name, description, integration_assignable)
values ('consumptions:manual', 'Registrar consumos manuales por empresa y día (auditado)', false);
insert into public.role_permissions(role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where r.name = 'super_admin' and p.name = 'consumptions:manual';

alter table public.company_drink_deliveries
  add column is_manual boolean not null default false,
  add column manual_reason text;
-- delivered_at conserva el instante del registro; el día efectivo es el del cupo asociado.
create function public.record_manual_company_delivery(
  p_company_day_id uuid, p_quantity integer, p_reason text, p_idempotency_key text
) returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare
  v_pass public.company_drink_days; v_company_id uuid; v_date date;
  v_actor jsonb; v_existing public.company_drink_deliveries; v_id uuid;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  perform private.require_permission('consumptions:manual');
  if p_quantity is null or p_quantity not between 1 and 100000 then raise exception 'INVALID_QUANTITY'; end if;
  if length(v_reason) not between 5 and 1000 then raise exception 'MANUAL_REASON_REQUIRED'; end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 8 and 255 then raise exception 'INVALID_IDEMPOTENCY_KEY'; end if;
  v_actor := private.actor();
  -- Serializa reintentos incluso si apuntan a empresas distintas.
  perform pg_advisory_xact_lock(hashtextextended('manual:' || auth.uid()::text || ':' || p_idempotency_key, 0));
  select * into v_existing from public.company_drink_deliveries
    where operator_id = (v_actor ->> 'profile_id')::uuid and idempotency_key = p_idempotency_key;
  if found then
    if not v_existing.is_manual or v_existing.company_day_id <> p_company_day_id
       or v_existing.quantity <> p_quantity or v_existing.manual_reason <> v_reason then
      raise exception 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return v_existing.id;
  end if;
  select company_id into v_company_id from public.company_drink_days where id = p_company_day_id;
  if not found then raise exception 'NOT_FOUND'; end if;
  -- Mismo orden de bloqueo que el canje por QR y la edición de empresas.
  perform 1 from public.drink_companies where id = v_company_id for update;
  select * into v_pass from public.company_drink_days where id = p_company_day_id for update;
  select date into v_date from public.event_days where id = v_pass.event_day_id for share;
  if v_date > private.bogota_today() then raise exception 'MANUAL_FUTURE_DAY'; end if;
  -- El estado actual de empresa/día no impide documentar una entrega pasada.
  if not v_pass.eligible then raise exception 'MANUAL_NOT_ELIGIBLE'; end if;
  if p_quantity > v_pass.quota - v_pass.delivered then raise exception 'INSUFFICIENT_QUOTA'; end if;
  update public.company_drink_days set delivered = delivered + p_quantity where id = v_pass.id;
  insert into public.company_drink_deliveries(company_day_id, quantity, operator_id, operator_label,
    delivered_at, idempotency_key, is_manual, manual_reason)
  values (v_pass.id, p_quantity, (v_actor ->> 'profile_id')::uuid, coalesce(v_actor ->> 'label', 'Operador'),
    private.app_now(), p_idempotency_key, true, v_reason) returning id into v_id;
  perform private.write_audit('MANUAL_COMPANY_DRINK_DELIVERY', 'company_day', v_pass.id::text, true,
    jsonb_build_object('delivery_id', v_id, 'company_id', v_company_id, 'event_date', v_date,
      'quantity', p_quantity, 'reason', v_reason, 'idempotency_key', p_idempotency_key));
  return v_id;
end;
$$;
revoke all on function public.record_manual_company_delivery(uuid, integer, text, text) from public, anon, authenticated;
grant execute on function public.record_manual_company_delivery(uuid, integer, text, text) to authenticated;

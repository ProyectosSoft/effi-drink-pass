-- ═══════════════════════════════════════════════════════════════════════════
-- Programa el despachador de webhooks cada minuto (pg_cron + pg_net).
-- Ejecutar UNA vez en Supabase → SQL Editor, después de desplegar la función "webhooks".
--
-- Requisitos:
--   1. Database → Extensions: habilitar pg_cron y pg_net.
--   2. Secret de la función:  supabase secrets set WEBHOOK_DISPATCHER_SECRET=<valor ≥ 32 caracteres>
--   3. Reemplazar abajo <REF> y <MISMO_VALOR_DEL_SECRET>.
-- El secreto se guarda en Supabase Vault (cifrado), no en el texto del job.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) Guardar URL y secreto en Vault (re-ejecutable: actualiza si ya existen).
do $$
declare
  v_url    text := 'https://<REF>.supabase.co/functions/v1/webhooks';   -- ← CAMBIAR
  v_secret text := '<MISMO_VALOR_DEL_SECRET>';                         -- ← CAMBIAR
begin
  if v_url like '%<REF>%' or v_secret like '<%' then
    raise exception 'Edite la URL y el secreto antes de ejecutar';
  end if;
  if exists (select 1 from vault.secrets where name = 'edp_webhooks_url') then
    perform vault.update_secret((select id from vault.secrets where name = 'edp_webhooks_url'), v_url);
  else
    perform vault.create_secret(v_url, 'edp_webhooks_url');
  end if;
  if exists (select 1 from vault.secrets where name = 'edp_webhooks_secret') then
    perform vault.update_secret((select id from vault.secrets where name = 'edp_webhooks_secret'), v_secret);
  else
    perform vault.create_secret(v_secret, 'edp_webhooks_secret');
  end if;
end $$;

-- 2) Job cada minuto (si ya existía con este nombre, se reemplaza).
select cron.unschedule(jobid) from cron.job where jobname = 'edp-webhooks-dispatch';
select cron.schedule('edp-webhooks-dispatch', '* * * * *', $job$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'edp_webhooks_url'),
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edp_webhooks_secret')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000)
$job$);

-- (Opcional) Persistir expiraciones cada hora.
select cron.unschedule(jobid) from cron.job where jobname = 'edp-expire-benefits';
select cron.schedule('edp-expire-benefits', '5 * * * *', $job$ select public.expire_benefits() $job$);

-- Verificación:
--   select jobname, schedule, active from cron.job where jobname like 'edp-%';
--   select status, return_message, start_time from cron.job_run_details order by start_time desc limit 10;

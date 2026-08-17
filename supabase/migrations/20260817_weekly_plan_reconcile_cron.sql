-- ════════════════════════════════════════════════════════════════════════
-- Weekly plan reconcile — replan already-planned days whose day_settings changed
-- ════════════════════════════════════════════════════════════════════════
-- The weekly rolling generation (weekly-rolling-plan-batch{1,2}) is ADDITIVE: it
-- only fills days that have no plan yet, and never re-plans an existing day. So a
-- change to an already-planned day — e.g. a weekday marked kids-home AFTER the
-- plan was made — would otherwise never take effect on its own.
--
-- This job calls plan-generator in "reconcile" mode. The function computes which
-- planned days in the 2-week horizon have gone STALE (the context stamped on the
-- meal row when it was planned no longer matches live day_settings — kids_home /
-- guests / commute / now-vacation) and replans ONLY those, via a targeted regen
-- that preserves locked / manual / cooked slots and re-stamps fresh context.
--
-- Scheduled Sunday 05:45 UTC — BEFORE the rolling batches (06:00 / 06:15) — so the
-- grocery snapshot built on the final rolling batch reflects the reconciled plan.
--
-- CADENCE (owner's choice): weekly only. A day-settings change is reconciled
-- automatically only if the day is still in the FUTURE on Sunday; today/past rows
-- are protected, and by the Sunday sweep the current week has already passed. For
-- an immediate mid-week fix, use the Day Settings "🔄 Regenerate plan" button.
--
-- Mechanism unchanged: pg_cron + pg_net, plan-generator deployed verify_jwt=false.
-- HOW TO APPLY: run this file once (Supabase Dashboard → SQL Editor, or MCP). Idempotent.
-- ════════════════════════════════════════════════════════════════════════

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('weekly-plan-reconcile')
where exists (select 1 from cron.job where jobname = 'weekly-plan-reconcile');

select cron.schedule(
  'weekly-plan-reconcile',
  '45 5 * * 0',                        -- min hour dom mon dow ; dow 0 = Sunday
  $$
  select net.http_post(
    url     := 'https://tsigszlaklspuankhztx.supabase.co/functions/v1/plan-generator',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := jsonb_build_object('mode', 'reconcile', 'triggered_by', 'scheduled')
  );
  $$
);

-- Inspect the schedule:   select jobname, schedule from cron.job where jobname like 'weekly-plan%';
-- Inspect run history:    select * from cron.job_run_details order by start_time desc limit 10;

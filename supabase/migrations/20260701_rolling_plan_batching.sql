-- ════════════════════════════════════════════════════════════════════════
-- Weekly rolling plan generation — split into batches to avoid Edge timeouts
-- ════════════════════════════════════════════════════════════════════════
-- Supersedes the single 'weekly-rolling-plan' job in
-- 20260620_weekly_rolling_cron.sql. That job asked plan-generator to produce
-- the whole next week in one invocation, which regularly blew past Supabase's
-- 150-second Edge Function limit (completed_at = null, success = null in
-- plan_generation_log).
--
-- plan-generator now generates rolling_7 in small batches (see ROLLING_BATCHES
-- in index.ts): batch 1 = days 1–3 of next week, batch 2 = days 4–7. Each batch
-- generates ONLY its own days, so every invocation stays comfortably under the
-- limit. This migration fires one cron call per batch, 15 minutes apart, so the
-- first call is finished long before the second starts. The grocery snapshot is
-- built by the function itself, but only on the FINAL batch.
--
-- day_settings is now extended forward at the start of every plan-generator
-- invocation (in the function), so there is no separate day_settings cron here.
--
-- Mechanism unchanged: pg_cron + pg_net, plan-generator deployed with
-- verify_jwt = false. If that ever changes, add an Authorization Bearer header
-- with the service-role key (from Vault) to both jobs below.
--
-- HOW TO APPLY: run this whole file once (Supabase Dashboard → SQL Editor, or
-- `supabase db push`). It is idempotent.
-- ════════════════════════════════════════════════════════════════════════

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ── Retire the old single-shot job (whole-week-in-one-call) ───────────────
select cron.unschedule('weekly-rolling-plan')
where exists (select 1 from cron.job where jobname = 'weekly-rolling-plan');

-- ── Batch 1: Sunday 06:00 UTC — next-week days 1–3 ────────────────────────
select cron.unschedule('weekly-rolling-plan-batch1')
where exists (select 1 from cron.job where jobname = 'weekly-rolling-plan-batch1');

select cron.schedule(
  'weekly-rolling-plan-batch1',
  '0 6 * * 0',                       -- min hour dom mon dow ; dow 0 = Sunday
  $$
  select net.http_post(
    url     := 'https://tsigszlaklspuankhztx.supabase.co/functions/v1/plan-generator',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := jsonb_build_object('mode', 'rolling_7', 'triggered_by', 'scheduled', 'batch', 1)
  );
  $$
);

-- ── Batch 2: Sunday 06:15 UTC — next-week days 4–7 (+ grocery snapshot) ────
-- 15 minutes after batch 1: batch 1 is well under the 150s limit, so it has
-- long since finished and written its rows (which batch 2 reads for no-repeat /
-- protein continuity).
select cron.unschedule('weekly-rolling-plan-batch2')
where exists (select 1 from cron.job where jobname = 'weekly-rolling-plan-batch2');

select cron.schedule(
  'weekly-rolling-plan-batch2',
  '15 6 * * 0',
  $$
  select net.http_post(
    url     := 'https://tsigszlaklspuankhztx.supabase.co/functions/v1/plan-generator',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := jsonb_build_object('mode', 'rolling_7', 'triggered_by', 'scheduled', 'batch', 2)
  );
  $$
);

-- Inspect the schedule:   select jobname, schedule from cron.job where jobname like 'weekly-rolling-plan%';
-- Inspect run history:    select * from cron.job_run_details order by start_time desc limit 10;
-- Inspect HTTP responses: select * from net._http_response order by created desc limit 10;

-- ════════════════════════════════════════════════════════════════════════
-- Weekly rolling plan generation — scheduled, autonomous
-- ════════════════════════════════════════════════════════════════════════
-- Every Sunday 06:00 UTC this calls the plan-generator Edge Function in
-- rolling_7 mode. The function defaults start_date to the Monday of the
-- current week, and rolling_7 writes days 8–14 — i.e. it extends the plan
-- forward by one week. Runs with NO app open and NO chat message required.
--
-- Locked slots (meal_plans.slot_locked = true) are preserved by the
-- generator itself (writePlan skips them), so this scheduled run never
-- overwrites a manual choice.
--
-- Mechanism: pg_cron (scheduler) + pg_net (outbound HTTP). plan-generator is
-- deployed with verify_jwt = false (the PWA already calls it with no auth
-- header), so the cron posts the same way — no key or Vault entry needed.
-- NOTE: if plan-generator is ever switched to verify_jwt = true, add an
--   'Authorization', 'Bearer ' || <service-role key from Vault>
-- entry to the headers below.
--
-- HOW TO APPLY (Supabase Dashboard → SQL Editor, or `supabase db push`):
--   Run sections 1 + 2 once. Section 3 is an optional manual test trigger.
-- ════════════════════════════════════════════════════════════════════════

-- ── 1. Extensions ─────────────────────────────────────────────────────────
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ── 2. Schedule: every Sunday 06:00 UTC ───────────────────────────────────
-- Idempotent: drop any prior job with this name, then (re)create it.
select cron.unschedule('weekly-rolling-plan')
where exists (select 1 from cron.job where jobname = 'weekly-rolling-plan');

select cron.schedule(
  'weekly-rolling-plan',
  '0 6 * * 0',                       -- min hour dom mon dow ; dow 0 = Sunday
  $$
  select net.http_post(
    url     := 'https://tsigszlaklspuankhztx.supabase.co/functions/v1/plan-generator',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := jsonb_build_object('mode', 'rolling_7')
  );
  $$
);

-- ── 3. Manual test trigger (optional) ─────────────────────────────────────
-- Fire the same call immediately to verify end-to-end without waiting for
-- Sunday, then inspect meal_plans and net._http_response.
--
-- select net.http_post(
--   url     := 'https://tsigszlaklspuankhztx.supabase.co/functions/v1/plan-generator',
--   headers := jsonb_build_object('Content-Type', 'application/json'),
--   body    := jsonb_build_object('mode', 'rolling_7')
-- );

-- Inspect the schedule:    select * from cron.job where jobname = 'weekly-rolling-plan';
-- Inspect run history:     select * from cron.job_run_details order by start_time desc limit 10;
-- Inspect HTTP responses:  select * from net._http_response order by created desc limit 10;

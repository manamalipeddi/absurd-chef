-- ════════════════════════════════════════════════════════════════════════
-- Rolling plan now extends TWO weeks ahead — add batches 3 & 4
-- ════════════════════════════════════════════════════════════════════════
-- Supersedes the two-batch schedule in 20260701_rolling_plan_batching.sql.
--
-- WHY: the plan used to extend only ONE week ahead each Sunday, but the weekly
-- grocery order has to bridge ~10 days (today → next Wednesday). With a 1-week
-- plan, the first dinners of the following week (Mon/Tue) were planned only the
-- Sunday AFTER the order that should have carried their ingredients was placed,
-- so those days could be short on fresh groceries. The generator now plans the
-- next TWO weeks (ROLLING_BATCHES in index.ts = days 1–14), split into FOUR
-- small batches so each Edge invocation stays well under the 150s limit.
--
-- Rolling generation is ADDITIVE (see writePlan's gap-fill note): it only fills
-- days that have no plan yet, so reaching two weeks out does NOT re-plan next
-- week every Sunday. In steady state batches 1–2 (the already-planned near week)
-- write nothing; batches 3–4 fill the newly-reached second week. On the first
-- run after deploy, all four batches together fill the current gap.
--
-- The grocery snapshot is triggered by the function itself, but only on the
-- FINAL batch (now batch 4) — see isFinalRollingBatch in index.ts. No snapshot
-- change is needed here; batch 2 simply stops being the last batch.
--
-- Mechanism unchanged: pg_cron + pg_net, plan-generator deployed with
-- verify_jwt = false. If that ever changes, add an Authorization Bearer header
-- with the service-role key (from Vault) to all four jobs below.
--
-- HOW TO APPLY: run this whole file once (Supabase Dashboard → SQL Editor, or
-- `supabase db push`). It is idempotent. DEPLOY index.ts FIRST
-- (`supabase functions deploy plan-generator --no-verify-jwt`) so a batch-3/4
-- call isn't rejected by an old function that only knows batches 1–2.
-- ════════════════════════════════════════════════════════════════════════

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ── Batch 1: Sunday 06:00 UTC — next-two-weeks days 1–4 ───────────────────
select cron.unschedule('weekly-rolling-plan-batch1')
where exists (select 1 from cron.job where jobname = 'weekly-rolling-plan-batch1');

select cron.schedule(
  'weekly-rolling-plan-batch1',
  '0 6 * * 0',
  $$
  select net.http_post(
    url     := 'https://tsigszlaklspuankhztx.supabase.co/functions/v1/plan-generator',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := jsonb_build_object('mode', 'rolling_7', 'triggered_by', 'scheduled', 'batch', 1)
  );
  $$
);

-- ── Batch 2: Sunday 06:15 UTC — days 5–7 ──────────────────────────────────
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

-- ── Batch 3: Sunday 06:30 UTC — days 8–11 (start of the second week) ───────
select cron.unschedule('weekly-rolling-plan-batch3')
where exists (select 1 from cron.job where jobname = 'weekly-rolling-plan-batch3');

select cron.schedule(
  'weekly-rolling-plan-batch3',
  '30 6 * * 0',
  $$
  select net.http_post(
    url     := 'https://tsigszlaklspuankhztx.supabase.co/functions/v1/plan-generator',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := jsonb_build_object('mode', 'rolling_7', 'triggered_by', 'scheduled', 'batch', 3)
  );
  $$
);

-- ── Batch 4: Sunday 06:45 UTC — days 12–14 (+ grocery snapshot) ───────────
-- Final batch: the function builds the grocery snapshot after this one only.
select cron.unschedule('weekly-rolling-plan-batch4')
where exists (select 1 from cron.job where jobname = 'weekly-rolling-plan-batch4');

select cron.schedule(
  'weekly-rolling-plan-batch4',
  '45 6 * * 0',
  $$
  select net.http_post(
    url     := 'https://tsigszlaklspuankhztx.supabase.co/functions/v1/plan-generator',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := jsonb_build_object('mode', 'rolling_7', 'triggered_by', 'scheduled', 'batch', 4)
  );
  $$
);

-- Inspect the schedule:   select jobname, schedule from cron.job where jobname like 'weekly-rolling-plan%';
-- Inspect run history:    select * from cron.job_run_details order by start_time desc limit 10;
-- Inspect HTTP responses: select * from net._http_response order by created desc limit 10;

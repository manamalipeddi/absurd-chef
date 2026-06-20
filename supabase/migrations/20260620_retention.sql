-- ════════════════════════════════════════════════════════════════════════
-- Retention policy — consolidated
-- ════════════════════════════════════════════════════════════════════════
-- Short-lived operational logs are pruned daily; the historical record is kept.
--   chat_history          : 30 days
--   plan_generation_log   : 30 days
--   meal_plans            : EXEMPT — long-term "what we actually ate" record
--   plan_edits            : EXEMPT — audit trail
-- General default for any other unbounded timestamped table is 6 months, but
-- the only append-only growth tables today are the two pruned below; all other
-- tables are reference/config data and are not swept.
--
-- Daily at 03:00 / 03:15 UTC via pg_cron (requires pg_cron, enabled already).
-- ════════════════════════════════════════════════════════════════════════

create extension if not exists pg_cron;

select cron.unschedule('retention-chat-history')
where exists (select 1 from cron.job where jobname = 'retention-chat-history');
select cron.schedule(
  'retention-chat-history',
  '0 3 * * *',
  $$ delete from chat_history where created_at < now() - interval '30 days'; $$
);

select cron.unschedule('retention-plan-gen-log')
where exists (select 1 from cron.job where jobname = 'retention-plan-gen-log');
select cron.schedule(
  'retention-plan-gen-log',
  '15 3 * * *',
  $$ delete from plan_generation_log where started_at < now() - interval '30 days'; $$
);

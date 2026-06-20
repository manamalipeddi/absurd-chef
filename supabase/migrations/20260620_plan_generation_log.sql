-- ════════════════════════════════════════════════════════════════════════
-- plan_generation_log — failure visibility for rolling plan generation
-- ════════════════════════════════════════════════════════════════════════
-- The plan-generator Edge Function inserts a row at the start of every run
-- (scheduled or manual) and updates it on completion: success = true with
-- days_generated, or success = false with error_message if it throws.
-- The Plan tab reads the latest 'scheduled' row to surface failures.
-- ════════════════════════════════════════════════════════════════════════

create table if not exists plan_generation_log (
  id              uuid primary key default gen_random_uuid(),
  triggered_by    text not null,        -- 'scheduled' | 'manual'
  mode            text not null,        -- 'rolling_7' | 'full_14'
  started_at      timestamptz default now(),
  completed_at    timestamptz,
  success         bool,
  error_message   text,
  days_generated  int
);

-- Fast lookup of the most recent run per trigger source.
create index if not exists plan_generation_log_trigger_started_idx
  on plan_generation_log (triggered_by, started_at desc);

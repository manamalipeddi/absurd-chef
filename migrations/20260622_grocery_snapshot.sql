-- Saved, AI-deduplicated grocery snapshot ("Absurd Plan Requirements").
-- Only the most-recent row is ever displayed; older rows kept for audit.
create table if not exists grocery_list_snapshot (
  id uuid primary key default gen_random_uuid(),
  generated_at timestamptz default now(),
  triggered_by text,                 -- 'manual' | 'cron'
  plan_date_range_start date,
  plan_date_range_end date,
  items jsonb not null default '[]'::jsonb
);
create index if not exists grocery_list_snapshot_generated_at_idx
  on grocery_list_snapshot (generated_at desc);

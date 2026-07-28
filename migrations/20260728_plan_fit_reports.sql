-- Plan Fit — a weekly self-evaluation of how well the CHEF'S PLAN matched the
-- household's actual week. It measures the plan's fit to real life, never the
-- family's adherence to the plan: a low score means "the plan needs to change,"
-- never "the family failed the plan." All downstream copy follows that framing.
--
-- Computed Sunday ~19:30 (Allie orchestrates the trigger in local time — pg_cron
-- can't track Swedish DST, and the 19:00 log-prompt / 19:30 compute / 20:00 relay
-- sequence must stay ordered year-round) by the `plan-fit` edge function, and
-- relayed by Allie at ~20:00. One row per week.
create table if not exists plan_fit_reports (
  id              uuid primary key default gen_random_uuid(),
  week_start      date not null,   -- Monday of the scored week
  week_end        date not null,   -- Sunday of the scored week
  scorable_slots  int,             -- denominator basis (after vacation/kids-home exclusions)
  max_score       int,             -- 3 × scorable_slots
  earned_score    int,
  fit_percent     numeric,         -- earned / max × 100 (null when nothing was scorable)
  slot_detail     jsonb,           -- per-slot breakdown (planned recipe, score, where-made)
  diagnosis       text,            -- AI-written PLAN-improvement pattern summary
  created_at      timestamptz not null default now()
);

-- One report per week — the compute is idempotent (re-trigger returns/updates
-- the same week's row rather than duplicating).
create unique index if not exists plan_fit_reports_week_start_key
  on plan_fit_reports (week_start);

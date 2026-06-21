-- Rule: day_settings always holds a row for every date from today through
-- (max meal_plans.plan_date + 14 days) — exactly one rolling-generation cycle of
-- lookahead, so the scheduled Sunday job always has the per-day context it reads
-- (commute/kids_home/gintas_away/vacation/guests) before it needs it.
--
-- Maintained automatically: a statement-level trigger on meal_plans inserts the
-- missing rows whenever the plan is extended (scheduled job, manual Plan Week N,
-- full regenerate). This does NOT touch plan-generator's logic — it only keeps
-- the input data pre-populated. It never deletes/truncates rows beyond the
-- target (so deliberately-set future rows are preserved).

create or replace function ensure_day_settings() returns trigger language plpgsql as $$
declare target date;
begin
  select max(plan_date) + 14 into target from meal_plans;
  if target is null then return null; end if;
  insert into day_settings (day, kids_home)         -- weekend kids_home default; everything else table defaults
  select d::date, (extract(dow from d) in (0, 6))
  from generate_series(current_date, target, interval '1 day') d
  on conflict (day) do nothing;
  return null;
end; $$;

drop trigger if exists trg_ensure_day_settings on meal_plans;
create trigger trg_ensure_day_settings after insert on meal_plans
  for each statement execute function ensure_day_settings();

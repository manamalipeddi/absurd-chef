-- Weekday lunch templates that apply only when the kids are home (holidays).
--
-- Weekday lunches only happen when the kids are off school (holidays, breaks) —
-- on school days they eat at preschool and no lunch is planned. So a weekday
-- lunch template rule must NOT force a lunch onto a normal school day; it should
-- only supply the theme for the lunch already planned on a kids-home day.
--
-- kids_home_only marks exactly that: when true, the rule contributes a lunch
-- ONLY on kids-home days. Weekend lunch rows (burger Saturday, leftover Sunday)
-- keep the default false — they're planned every weekend regardless. The planner
-- reads this in the needs_lunch trigger (see index.ts).
alter table weekly_template
  add column if not exists kids_home_only boolean not null default false;

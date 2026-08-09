-- Plan Fit — record how many scorable slots were ASSUMED made-as-planned.
--
-- The household logs deviations, not every meal, so a week often reaches Sunday
-- with no outcome logged at all. Plan Fit now assumes such unlogged slots were
-- made as planned (scored 3, where:"assumed") instead of reading them as "not
-- made" (0), which used to crater the score of any week the owner never
-- confirmed. This column stores the assumed count per week so the fit_percent
-- can be read honestly (a high score built mostly on assumed slots means "we
-- just don't know", not "the plan fit perfectly"). See plan-fit.ts header.
alter table plan_fit_reports
  add column if not exists assumed_slots int default 0;

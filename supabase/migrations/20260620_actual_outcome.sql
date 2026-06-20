-- ════════════════════════════════════════════════════════════════════════
-- Actual-outcome tracking on meal_plans — "what actually happened"
-- ════════════════════════════════════════════════════════════════════════
-- meal_plans becomes the long-term historical record of what was eaten,
-- distinct from what was planned. It is EXEMPT from any retention cleanup
-- (see 20260620_retention.sql) and must never be deleted on a schedule.
--
-- actually_made (existing):
--   null  = date hasn't happened yet, or happened but wasn't logged
--   true  = made exactly what was planned (recipe_id)
--   false = something different happened — actual_recipe_id holds the real
--           recipe, or actual_notes describes an untracked meal
--           (e.g. "ordered takeout", "leftovers from Tuesday")
-- ════════════════════════════════════════════════════════════════════════

alter table meal_plans add column if not exists actual_recipe_id uuid references recipes(id);
alter table meal_plans add column if not exists actual_notes text;

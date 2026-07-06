-- Multi-meal TRACKING (not planning): additional meals that actually happened
-- in a slot on top of the single planned recipe. Planning logic is unchanged —
-- still one planned recipe per slot. Each entry in the array:
--   {recipe_id, recipe_name, notes}
-- recipe_name is stored as a string so unlisted meals (e.g. "leftover
-- dumplings") that have no recipe_id can still be recorded. Additional meals
-- with a recipe_id count toward last_made, the no-repeat window, and the
-- preschool protein cross-reference for that day.
alter table meal_plans add column if not exists additional_recipes jsonb not null default '[]'::jsonb;

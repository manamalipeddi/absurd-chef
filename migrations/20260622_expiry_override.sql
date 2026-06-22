-- Marks a meal_plans slot where a template constraint yielded to an expiry
-- urgency (expiry-aware planning in plan-generator).
alter table meal_plans add column if not exists expiry_override boolean default false;

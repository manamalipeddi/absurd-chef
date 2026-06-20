-- "Other" placeholder recipe: an inert anchor for free-text actual-outcome /
-- plan entries, so actual_notes always attaches to a real recipe_id.
alter table recipes add column if not exists is_placeholder bool default false;
insert into recipes (name, emoji, meal_type, active, is_preferred, is_placeholder)
select 'Other', '❓', null, true, false, true
where not exists (select 1 from recipes where is_placeholder = true);

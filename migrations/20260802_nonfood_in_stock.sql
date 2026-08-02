-- Non-food items now use a simple 3-state signal: Restock / In Stock / Overstock
-- (see NONFOOD_STATUSES in screens/pantry.js). "In Stock" is stored as 'enough'
-- (a stored 'plenty' also reads "In Stock", but 'enough' is the canonical write).
--
-- One-time normalisation: mark every current non-food row "In Stock". They were
-- all carrying 'enough'/'plenty' (both already display as In Stock), so this only
-- collapses them onto the canonical key — Restock/Overstock are set by hand later.
update inventory
set status = 'enough'
where food_category = 'non_food'
  and status in ('enough', 'plenty');

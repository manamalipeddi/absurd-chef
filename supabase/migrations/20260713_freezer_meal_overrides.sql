-- Learned freezer classification (Slice B).
-- A frozen product is either a ready-to-heat MEAL (belongs in the Freezer Meals
-- tab / freezer_stash) or a frozen COMPONENT/ingredient (stays in the Freezer
-- section of Inventory). The app auto-sorts new/known frozen items with a
-- heuristic, but the user can override with one tap ("Move to Freezer Meals" /
-- "Move back to Inventory"). This table remembers those corrections by
-- normalized product name so the auto-sort gets smarter over time and never
-- re-moves something the user has already put back.
create table if not exists freezer_meal_overrides (
  norm_name  text primary key,          -- lower(trim(product name))
  is_meal    boolean not null,          -- true → freezer_stash meal, false → inventory component
  updated_at timestamptz not null default now()
);

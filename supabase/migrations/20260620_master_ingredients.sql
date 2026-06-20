-- ════════════════════════════════════════════════════════════════════════
-- Master ingredient list (additive — nothing existing is changed)
-- ════════════════════════════════════════════════════════════════════════
-- master_ingredient_id is an ADDITIONAL optional link on the ingredient tables.
-- The free-text `name` on recipe_ingredients / recipe_variant_ingredients stays
-- untouched and remains the source of truth for recipe display. The link is used
-- only for grocery-list / inventory matching, and a wrong or missing link never
-- affects how a recipe displays.
--
-- Populating master_ingredients and back-linking existing rows happens only AFTER
-- the grouping proposal (master_ingredients_proposal.md) is reviewed and approved.
-- ════════════════════════════════════════════════════════════════════════

create table if not exists master_ingredients (
  id               uuid primary key default gen_random_uuid(),
  canonical_name   text not null,        -- e.g. "Chickpeas"
  default_category text,                 -- fridge | freezer | pantry (best guess)
  aliases          text[],               -- original strings that map here
  active           bool default true,
  created_at       timestamptz default now()
);

alter table recipe_ingredients
  add column if not exists master_ingredient_id uuid references master_ingredients(id);
alter table recipe_variant_ingredients
  add column if not exists master_ingredient_id uuid references master_ingredients(id);

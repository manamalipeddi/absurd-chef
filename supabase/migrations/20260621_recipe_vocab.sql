-- Managed controlled vocabularies for recipe tags and cuisine. The goal is to
-- control the INPUT vocabulary on the Add/Edit Recipe form; storage stays as it
-- is (recipes.tags text[] referencing recipe_tags.name, recipes.cuisine text
-- referencing recipe_cuisines.name) so nothing reading tags/cuisine elsewhere
-- (planner template matching, recipe filtering) needs rework.

create table if not exists recipe_tags (
  id     uuid primary key default gen_random_uuid(),
  name   text not null unique,
  active boolean default true
);

create table if not exists recipe_cuisines (
  id     uuid primary key default gen_random_uuid(),
  name   text not null unique,
  active boolean default true
);

-- Backfill from every distinct value already in use, so nothing is lost.
insert into recipe_tags (name)
  select distinct trim(t) from recipes, unnest(coalesce(tags, '{}'::text[])) as t
  where trim(t) <> ''
  on conflict (name) do nothing;

insert into recipe_cuisines (name)
  select distinct trim(cuisine) from recipes
  where cuisine is not null and trim(cuisine) <> ''
  on conflict (name) do nothing;

-- Ensure the planner-relevant tags exist even if no recipe currently carries them.
insert into recipe_tags (name) values
  ('dump'), ('batch_cook'), ('freezable'), ('kidproof'), ('travel_friendly'), ('quick')
  on conflict (name) do nothing;

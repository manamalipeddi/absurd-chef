-- Managed vocabularies for cooking_method / protein / style (joins recipe_tags
-- and recipe_cuisines from the earlier vocab migration). Storage unchanged:
-- recipes.cooking_method / protein / style stay single text fields referencing
-- these tables' name values — the planner reads them exactly as before.

create table if not exists recipe_cooking_methods (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  active boolean default true
);
create table if not exists recipe_proteins (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  active boolean default true
);
create table if not exists recipe_styles (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  active boolean default true
);

-- Backfill from every distinct value already in use (nothing the planner relies
-- on is lost — including any near-duplicates, which the user can tidy via the
-- management screen's rename/deactivate).
insert into recipe_cooking_methods (name)
  select distinct trim(cooking_method) from recipes
  where cooking_method is not null and trim(cooking_method) <> '' on conflict (name) do nothing;
insert into recipe_proteins (name)
  select distinct trim(protein) from recipes
  where protein is not null and trim(protein) <> '' on conflict (name) do nothing;
insert into recipe_styles (name)
  select distinct trim(style) from recipes
  where style is not null and trim(style) <> '' on conflict (name) do nothing;

-- Atomic rename + propagate to existing recipes (one transaction per call).
create or replace function rename_recipe_vocab(kind text, old_name text, new_name text)
returns void language plpgsql as $$
begin
  if kind = 'tag' then
    update recipe_tags set name = new_name where name = old_name;
    update recipes set tags = array_replace(tags, old_name, new_name) where tags @> array[old_name];
  elsif kind = 'cuisine' then
    update recipe_cuisines set name = new_name where name = old_name;
    update recipes set cuisine = new_name where cuisine = old_name;
  elsif kind = 'cooking_method' then
    update recipe_cooking_methods set name = new_name where name = old_name;
    update recipes set cooking_method = new_name where cooking_method = old_name;
  elsif kind = 'protein' then
    update recipe_proteins set name = new_name where name = old_name;
    update recipes set protein = new_name where protein = old_name;
  elsif kind = 'style' then
    update recipe_styles set name = new_name where name = old_name;
    update recipes set style = new_name where style = old_name;
  else
    raise exception 'unknown vocab kind: %', kind;
  end if;
end; $$;

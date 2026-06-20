-- Steps 3 & 4: auto-link trigger (all insert paths) + inventory link column.

-- inventory carries the link too (Step 4 compares both sides)
alter table inventory add column if not exists master_ingredient_id uuid references master_ingredients(id);

-- shared matcher: confident exact match on canonical_name or an alias (case/space-insensitive)
create or replace function link_master_ingredient() returns trigger as $$
begin
  if new.master_ingredient_id is null and new.name is not null and length(trim(new.name)) > 0 then
    select mi.id into new.master_ingredient_id
    from master_ingredients mi
    where mi.active and (
      lower(trim(new.name)) = lower(trim(mi.canonical_name))
      or exists (select 1 from unnest(mi.aliases) a where lower(trim(a)) = lower(trim(new.name)))
    )
    limit 1;
  end if;
  return new;
end;
$$ language plpgsql;

-- Step 3: auto-link on every future insert, across all code paths
drop trigger if exists trg_link_master_ri  on recipe_ingredients;
drop trigger if exists trg_link_master_rvi on recipe_variant_ingredients;
drop trigger if exists trg_link_master_inv on inventory;
create trigger trg_link_master_ri  before insert on recipe_ingredients
  for each row execute function link_master_ingredient();
create trigger trg_link_master_rvi before insert on recipe_variant_ingredients
  for each row execute function link_master_ingredient();
create trigger trg_link_master_inv before insert on inventory
  for each row execute function link_master_ingredient();

-- back-link existing inventory (best-effort exact match; "Category - Variant" names mostly stay null → fuzzy fallback still applies)
update inventory inv set master_ingredient_id = mi.id
from master_ingredients mi
where inv.master_ingredient_id is null and inv.active
  and ( lower(trim(inv.name)) = lower(trim(mi.canonical_name))
     or exists (select 1 from unnest(mi.aliases) a where lower(trim(a)) = lower(trim(inv.name))) );

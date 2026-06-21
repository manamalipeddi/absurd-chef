-- Inventory rework: typical_quantity baseline, loose status, last_updated_at,
-- and food_category (WHAT kind of food — distinct from category which is WHERE
-- it's stored) driving default shelf-life. A single trigger centralises the
-- quantity side-effects so every write path (form, stepper, status tap, grocery
-- import, chat) behaves identically with no per-path special-casing.

alter table inventory add column if not exists typical_quantity numeric;
alter table inventory add column if not exists status text;            -- out|very_low|low|enough|plenty|overstock (input convenience)
alter table inventory add column if not exists last_updated_at timestamptz;
alter table inventory add column if not exists food_category text;     -- meat|seafood|produce|dairy|eggs|pantry|other

-- ── Best-effort food_category backfill (name-based; user can correct any) ─────
-- Order matters: dry/pantry signals win first so "chili powder" is pantry not
-- produce and "almond milk" is not dairy.
-- NOTE: PostgreSQL regex uses \y for a word boundary (\b means backspace here).
update inventory set food_category = case
  when lower(name) ~ '(powder|dried|flour|sugar|\yoil\y|stock|cube|broth|\ysauce\y|seed|masala|spice|baking|canned|tinned|paste|vinegar|syrup|honey|rice|pasta|noodle|lentil|\ydal\y|cereal|oats|flake|cracker|biscuit|\ytea\y|coffee|\ysalt\y|peppercorn|black pepper|white pepper|\yjam\y|peanut|cashew|\ynuts?\y|bread|\ybun\y|chapati|dough|pastry|wrap|tortilla)' then 'pantry'
  when lower(name) ~ '(almond milk|oat milk|soy milk|coconut milk|plant milk|rice milk|almond drink)' then 'other'
  when lower(name) ~ '(milk|cheese|yoghurt|yogurt|butter|cream|paneer|\yghee\y|curd|kefir)' then 'dairy'
  when lower(name) ~ '(chicken|beef|pork|lamb|mutton|mince|sausage|bacon|\yham\y|turkey|goat|meatball|keema|steak|kebab|salami|hot dog)' then 'meat'
  when lower(name) ~ '(fish|salmon|tuna|prawn|shrimp|crab|\ycod\y|haddock|mackerel|seafood|anchov)' then 'seafood'
  when lower(name) ~ '\yegg' then 'eggs'
  when lower(name) ~ '(spinach|broccoli|cauliflower|carrot|cabbage|celery|onion|potato|garlic|ginger|cucumber|lettuce|banana|berries|berry|apple|orange|lemon|lime|avocado|mushroom|courgette|zucchini|gourd|kale|leek|beetroot|coriander|cilantro|parsley|mint|basil|curry leaves|tomato|\ypepper\y|chilli|chili|\ypeas\y|spring onion|fruit|\yveg)' then 'produce'
  when category = 'pantry' then 'pantry'
  else 'other'
end
where food_category is null;

-- ── One-time last_updated_at backfill ────────────────────────────────────────
-- The 33 genuinely user-touched rows get added_date as the closest signal; the
-- 152 master→inventory sync rows stay NULL ("never actually checked").
update inventory set last_updated_at = added_date;
update inventory set last_updated_at = null
  where source = 'manual' and added_date = '2026-06-21' and master_ingredient_id is not null;

-- ── Quantity side-effects trigger (centralises last_updated_at + expiry) ──────
create or replace function inv_quantity_side_effects() returns trigger as $$
declare shelf_days int;
begin
  -- category default shelf life; NULL = no auto-expiry (pantry/other)
  shelf_days := case new.food_category
    when 'meat' then 3 when 'seafood' then 2 when 'produce' then 7
    when 'dairy' then 14 when 'eggs' then 21 else null end;

  if tg_op = 'INSERT' then
    if new.quantity is not null then
      if new.last_updated_at is null then new.last_updated_at := now(); end if;
      if new.expiry_date is null and shelf_days is not null then
        new.expiry_date := current_date + shelf_days;
      end if;
    end if;
  elsif tg_op = 'UPDATE' then
    -- last_updated_at + expiry move ONLY when the quantity itself changes;
    -- editing notes/category/etc. must not touch them.
    if new.quantity is distinct from old.quantity then
      new.last_updated_at := now();
      if shelf_days is not null then
        if new.quantity > coalesce(old.quantity, 0) then
          new.expiry_date := current_date + shelf_days;   -- restock → fresh date (even if already set)
        elsif new.expiry_date is null then
          new.expiry_date := current_date + shelf_days;   -- first-time default
        end if;
      end if;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_inv_qty_side_effects on inventory;
create trigger trg_inv_qty_side_effects before insert or update on inventory
  for each row execute function inv_quantity_side_effects();

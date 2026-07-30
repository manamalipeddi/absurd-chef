-- Auto-derive inventory status from quantity vs. typical_quantity.
--
-- WHY: the "how full" status (Enough / Plenty — displayed as "One More Meal" /
-- "Many Meals") is computable whenever an item has BOTH a real count (quantity)
-- and a baseline (typical_quantity). Previously it was only set by hand (tapping
-- the pill) or, more recently, in the edit-form save — so existing items and any
-- non-form write path still needed a manual tap. The grocery snapshot and the
-- meal planner read inventory.status straight from the DB, so the derivation has
-- to live HERE to be authoritative everywhere (pill, groceries, planner) and for
-- items that already exist.
--
-- THE RULE (matches the edit-form logic): for a staple with typical_quantity > 0
-- and a positive quantity, quantity > half the baseline → 'plenty', otherwise
-- 'enough'. Only these two "how full" values are derived.
--
-- WHAT STAYS MANUAL (deliberately NOT auto-set): Out, Restock, Overstock, and
-- Guest. Out/Restock drive the grocery list and Overstock is a judgement the
-- count can't express, so they remain a pill tap. The trigger re-derives ONLY
-- when the quantity or the baseline actually moves, so a pure status tap (which
-- changes status alone) is left untouched — a manual Restock/Overstock survives
-- until the count next changes. A zero/blank quantity is left alone too.

-- ── Extend the existing side-effects trigger (adds status derivation; the
--    last_updated_at + expiry behaviour is reproduced verbatim from
--    20260621_inventory_rework.sql — create-or-replace swaps the whole body) ──
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
    -- Auto-derive "how full" for a staple with a baseline + a positive count.
    if new.typical_quantity is not null and new.typical_quantity > 0
       and new.quantity is not null and new.quantity > 0 then
      new.status := case when new.quantity > new.typical_quantity / 2
                         then 'plenty' else 'enough' end;
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
    -- Re-derive status when the COUNT or the BASELINE moves (so editing typical
    -- also re-grades it). A status-only change (manual pill tap) touches neither
    -- and is left as-is, preserving manual Out/Restock/Overstock overrides.
    if (new.quantity is distinct from old.quantity
        or new.typical_quantity is distinct from old.typical_quantity)
       and new.typical_quantity is not null and new.typical_quantity > 0
       and new.quantity is not null and new.quantity > 0 then
      new.status := case when new.quantity > new.typical_quantity / 2
                         then 'plenty' else 'enough' end;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

-- (trigger binding is unchanged from the original migration; no need to recreate)

-- ── One-time backfill for items that already have a count + baseline ──────────
-- Fill blanks and correct any stale enough/plenty. Do NOT touch rows already
-- carrying a manual intent status (restock / overstock / out / guest) — those
-- are deliberate overrides that a future quantity change will re-derive anyway.
update inventory
set status = case when quantity > typical_quantity / 2 then 'plenty' else 'enough' end
where typical_quantity is not null and typical_quantity > 0
  and quantity is not null and quantity > 0
  and (status is null or status in ('enough', 'plenty'));

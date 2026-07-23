-- Sub-category for non-food items so the Non-food tab groups them the way the
-- household thinks about them: cleaning | kitchen | firstaid | toiletries | pet
-- | misc. Null for food rows (they group by storage location instead). The
-- grocery import assigns a group heuristically; the item's edit form lets the
-- user correct it.
alter table inventory add column if not exists nonfood_group text;

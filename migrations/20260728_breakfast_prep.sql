-- Bulk-prep breakfast restock — proactive "you're out, prep the next batch" +
-- auto-add the eggs to the next grocery list.
--
-- Manasa bulk-preps three breakfasts and freezes them; each lives as a
-- freezer_stash row tracked by `portions`. When a breakfast's portions hit 0 she
-- needs to prep the next batch THIS week so it's ready for the following week,
-- and buy that batch's eggs. This models exactly that:
--
--   breakfast_prep — config: the three breakfasts, how many eggs a batch needs,
--     an ILIKE pattern to match their freezer_stash rows, and the last observed
--     `state` (available|depleted) so we notify only on the available→depleted
--     EDGE, not every day it sits empty.
--   prep_needs — one OPEN row per breakfast currently needing a re-prep; it's
--     what grocery-snapshot reads to put the eggs on the list, and it auto-closes
--     when the breakfast is re-prepped.
--   check_breakfast_prep() — the daily state machine (pg_cron, below).
--
-- Start-clean: all three are at 0 portions right now, but seeding state
-- 'depleted' means the first run sees no EDGE and stays silent — only a future
-- re-prep-then-deplete cycle notifies.
-- Notifications go to chef_outbox (relayed on WhatsApp by Allie in her voice —
-- see 20260727_allie_relay_channel.sql) AND chat_history (the in-app log).

create extension if not exists pg_cron;

create table if not exists breakfast_prep (
  id           uuid primary key default gen_random_uuid(),
  label        text not null,            -- display name, e.g. "Sheet Pan Pancakes"
  stash_match  text not null,            -- ILIKE pattern vs freezer_stash.recipe_name
  recipe_name  text,                     -- the recipe to prep (reference only)
  eggs_needed  integer not null,         -- eggs one prep batch consumes
  state        text not null default 'available',  -- available | depleted (last seen)
  active       boolean not null default true
);

create table if not exists prep_needs (
  id                uuid primary key default gen_random_uuid(),
  breakfast_prep_id uuid not null references breakfast_prep(id),
  label             text not null,
  eggs_needed       integer not null,
  created_at        timestamptz not null default now(),
  fulfilled_at      timestamptz          -- null = OPEN (still needs prepping/eggs)
);

create index if not exists prep_needs_open_idx
  on prep_needs (breakfast_prep_id) where fulfilled_at is null;

-- Seed the three bulk-prep breakfasts. state='depleted' = start clean (see above).
-- Egg counts per batch: sheet pan 28, dutch baby 30, french toast 32.
insert into breakfast_prep (label, stash_match, recipe_name, eggs_needed, state)
select * from (values
  ('Sheet Pan Pancakes',  '%sheetpan%',    'Oat Flour Pancakes (Sheet Pan Oven version)', 28, 'depleted'),
  ('Dutch Baby Pancakes', '%dutch baby%',  'Dutch Baby Pancakes',                          30, 'depleted'),
  ('French Toast',        '%french toast%','French Toast',                                 32, 'depleted')
) as v(label, stash_match, recipe_name, eggs_needed, state)
where not exists (select 1 from breakfast_prep);

-- Daily state machine. For each active breakfast: is a batch available in the
-- freezer (any active, unused stash row matching the pattern with portions>0)?
--   available→depleted : new depletion — queue the heads-up + open a prep_need.
--   depleted→available : re-prepped — close the open prep_need.
-- Only transitions act, so a breakfast sitting empty is announced exactly once.
create or replace function check_breakfast_prep() returns void
language plpgsql
as $$
declare
  bp    record;
  avail boolean;
  msg   text;
begin
  for bp in select * from breakfast_prep where active loop
    avail := exists (
      select 1 from freezer_stash fs
      where fs.active
        and coalesce(fs.used, false) = false
        and coalesce(fs.portions, 0) > 0
        and fs.recipe_name ilike bp.stash_match
    );

    if not avail and bp.state = 'available' then
      msg := '❄️ ' || bp.label || ' are used up in the freezer — time to prep the '
          || 'next batch this week so you''re stocked for the following week. I''ve '
          || 'added ' || bp.eggs_needed || ' eggs to the next grocery list for it.';
      insert into chef_outbox (kind, content) values ('breakfast_prep', msg);
      insert into chat_history (role, content) values ('assistant', msg);
      insert into prep_needs (breakfast_prep_id, label, eggs_needed)
        values (bp.id, bp.label, bp.eggs_needed);
      update breakfast_prep set state = 'depleted' where id = bp.id;

    elsif avail and bp.state = 'depleted' then
      update prep_needs set fulfilled_at = now()
        where breakfast_prep_id = bp.id and fulfilled_at is null;
      update breakfast_prep set state = 'available' where id = bp.id;
    end if;
  end loop;
end;
$$;

-- Daily at 05:30 UTC (≈07:30 Europe/Stockholm) so a fresh heads-up is queued
-- before Allie's morning relay window (08:00–21:00).
select cron.unschedule('breakfast-prep-check')
where exists (select 1 from cron.job where jobname = 'breakfast-prep-check');
select cron.schedule(
  'breakfast-prep-check',
  '30 5 * * *',
  $$ select check_breakfast_prep(); $$
);

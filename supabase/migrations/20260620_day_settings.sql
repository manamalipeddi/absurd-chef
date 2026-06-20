-- Combined per-day settings: replaces commute_days + special_days at the input
-- level. Single source of truth for commute / kids_home / gintas_away / guests.
-- One-time migration backfills the next 90 days from the old tables (which are
-- left in place but no longer read/written). Read-time default: kids_home=true on
-- weekends where no row exists.

create table if not exists day_settings (
  id uuid primary key default gen_random_uuid(),
  day date not null unique,
  is_commute_day bool default false,
  kids_home bool default false,
  gintas_away bool default false,
  guest_count int default 0,
  guest_family_member_ids uuid[] default '{}',
  guest_allergies jsonb default '[]',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

insert into day_settings (day, is_commute_day, kids_home, gintas_away, guest_count, guest_family_member_ids, guest_allergies)
select d::date,
  coalesce(cd.is_commute, false),
  coalesce(flags.kids_home, false),
  coalesce(flags.gintas_away, false),
  coalesce(g.guest_count, 0),
  coalesce(g.guest_ids, '{}'::uuid[]),
  coalesce(g.guest_allergies, '[]'::jsonb)
from generate_series(current_date, current_date + 89, interval '1 day') d
left join lateral (
  select true as is_commute from commute_days c
  where c.active and c.day_of_week = extract(dow from d)::int limit 1
) cd on true
left join lateral (
  select bool_or(s.type in ('holiday','preschool_closed','kids_home')) as kids_home,
         bool_or(s.type = 'gintas_away') as gintas_away
  from special_days s where s.day = d::date
) flags on true
left join lateral (
  select s.guest_count, s.guest_family_member_ids as guest_ids, s.guest_allergies
  from special_days s where s.day = d::date and coalesce(s.guest_count,0) > 0
  order by s.guest_count desc limit 1
) g on true
where coalesce(cd.is_commute,false) or coalesce(flags.kids_home,false)
   or coalesce(flags.gintas_away,false) or coalesce(g.guest_count,0) > 0
on conflict (day) do nothing;

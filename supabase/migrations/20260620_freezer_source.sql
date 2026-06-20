alter table freezer_stash add column if not exists source text default 'homemade';
alter table freezer_stash add column if not exists typically_restocked bool default false;

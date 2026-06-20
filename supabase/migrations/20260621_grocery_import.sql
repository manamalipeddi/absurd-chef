-- Grocery order import: staging for the parse → review → commit flow.
-- A pasted order confirmation (ICA / Mathem / other) is parsed into structured
-- inventory candidates and stored here as status 'pending', so the chat agent
-- can show a review list BEFORE anything is written to inventory. On explicit
-- user confirmation the batch is committed (rows upserted/inserted) and marked
-- 'committed'. Nothing is ever written to inventory straight from the parser.
create table if not exists grocery_import_batches (
  id           uuid primary key default gen_random_uuid(),
  source       text not null default 'other',   -- ica | mathem | other
  status       text not null default 'pending',  -- pending | committed | discarded
  items        jsonb not null default '[]'::jsonb,
  raw_text     text,
  created_at   timestamptz not null default now(),
  committed_at timestamptz
);

create index if not exists idx_grocery_import_status
  on grocery_import_batches(status, created_at desc);

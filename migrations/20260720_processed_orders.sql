-- Processed-order ledger: one row per retailer grocery order that has been
-- written to inventory, keyed by a UNIQUE order_id. Shared by BOTH import
-- paths — the automated AbsurdAssistant ("Allie") hand-off and a manual paste
-- in the PWA chat — so an order that produces multiple confirmation emails
-- (orders get edited), or that is handed off AND later pasted, can never be
-- added to inventory twice.
--
-- Deliberately a NEW table, not a column on grocery_import_batches: that table
-- is a per-paste-attempt log (pending/committed/discarded rows) purged after
-- 30 days by chat-agent's cleanup. A dedupe ledger must be permanent and
-- one-row-per-order with a real unique constraint. This table is tiny
-- (~1 row/week) and is never part of the 30-day cleanup.
create table if not exists processed_orders (
  id           uuid primary key default gen_random_uuid(),
  order_id     text not null,   -- retailer order number, normalised (trimmed, no leading #, uppercased)
  retailer     text,            -- mathem | ica | null (unknown)
  source       text not null,   -- absurdassistant | manual_paste
  status       text not null default 'processing',  -- processing | added | needs_review | error
  items_added  integer,
  summary      text,            -- the import summary shown to the user / relayed by Allie
  delivered_at date,
  created_at   timestamptz not null default now()
);

-- Unique on order_id ALONE (not retailer + order_id): the manual-paste path
-- infers the retailer from pasted text and could disagree with Allie's
-- explicit retailer field for the same order — a mismatch would let the order
-- in twice, the exact failure this ledger exists to prevent. A cross-retailer
-- order-number collision is theoretical; double inventory is not.
create unique index if not exists processed_orders_order_id_key
  on processed_orders (order_id);

-- Allie ↔ Chef relay channel — two additive tables that let AbsurdAssistant
-- ("Allie", the WhatsApp bot) act as a two-way relay for AbsurdChef WITHOUT
-- reading or polluting Manasa's own in-app chat (`chat_history`).
--
-- 1) chef_outbox — Chef → Allie push queue.
--    Chef writes proactive messages (expiring-soon nudges, the Sunday check-in,
--    grocery/hold-list hand-off confirmations) into chat_history so the PWA log
--    shows them, but Manasa only sees those when she opens the app. Each such
--    message is ALSO enqueued here; Allie polls, rewrites it in her own voice,
--    and relays it on WhatsApp. Manasa then replies in the AbsurdChef app (the
--    message already threads in chat_history) — the relay is notify-only, Allie
--    never carries a reply back. `relayed_at` is stamped when Allie picks a row
--    up, so nothing is relayed twice.
create table if not exists chef_outbox (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null,   -- expiry_nudge | weekly_checkin | handoff_confirm
  content     text not null,   -- the factual message; Allie restyles it in her voice
  created_at  timestamptz not null default now(),
  relayed_at  timestamptz              -- null = not yet relayed by Allie
);

-- Poll query is "unrelayed, oldest first" — index the open rows only.
create index if not exists chef_outbox_unrelayed_idx
  on chef_outbox (created_at) where relayed_at is null;

-- 2) allie_chat_history — the ISOLATED Allie↔Chef conversation log.
--    Allie's food questions/relays used to hit Chef's general chat endpoint,
--    which loads + writes Manasa's `chat_history` — so Allie's traffic leaked
--    into Manasa's 20-message context window and in-app log. This is a separate
--    store keyed to Allie: Chef's keyed `kind:'chat'` endpoint reads/writes here
--    instead, keeping the two conversations fully isolated.
--
--    Retention is TIME-BASED: the endpoint deletes rows older than a fixed
--    window at the top of each call (Allie's exchanges are short-lived context,
--    not durable history), so the table self-cleans without an end-of-chat
--    signal. Never part of Chef's 30-day chat_history cleanup — different table.
create table if not exists allie_chat_history (
  id          uuid primary key default gen_random_uuid(),
  role        text not null check (role in ('user', 'assistant')),
  content     text not null,
  created_at  timestamptz not null default now()
);

create index if not exists allie_chat_history_created_idx
  on allie_chat_history (created_at);

-- User-only visual prioritisation flag for inventory rows. Affects display order
-- (Inventory list + Grocery List) ONLY — never read by check_substitutes, the
-- Grocery quantity-math/shortfall logic, the chat-agent, or plan-generator.
alter table inventory add column if not exists is_favourite boolean default false;

-- Backstop against duplicate recipes: no two ACTIVE, non-placeholder recipes
-- may share the same (case-insensitive, trimmed) name. The chat-agent's
-- add_recipe tool also dedups in code, but this guarantees it at the DB level.
CREATE UNIQUE INDEX IF NOT EXISTS recipes_unique_active_name
  ON recipes (lower(btrim(name)))
  WHERE active AND COALESCE(is_placeholder, false) = false;

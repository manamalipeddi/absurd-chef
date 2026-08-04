-- ── Enable Row Level Security on all public tables ──────────────────────────
-- Posture (single-household app, not multi-tenant): the anon key ships in the
-- PWA browser bundle, so with RLS off anyone with that key could read/write
-- every row. This migration closes that hole.
--
-- Two safety facts this relies on:
--   1. service_role and postgres have BYPASSRLS = true. So every server-side
--      caller — AbsurdChef edge functions (chat-agent, plan-generator,
--      recipe-agent, grocery-snapshot, plan-fit), Allie's reads, and the
--      pg_dump backup cron — is unaffected by anything below. RLS only ever
--      governs the anon/authenticated roles (i.e. the browser).
--   2. The PWA is gated behind ONE shared Supabase Auth login (see app.js).
--      Once signed in, the browser's role is `authenticated`, which the
--      Class B policies below allow. The anonymous public (anon) gets nothing.
--
-- Class A — the browser never queries these directly (all access is via
-- service-role edge functions). Enable RLS with NO policy: anon/authenticated
-- are denied; service_role still bypasses. Nothing publicly reachable.
ALTER TABLE public.special_days           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commute_days           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_verification_log  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.grocery_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.processed_orders       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chef_outbox            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.allie_chat_history     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.breakfast_prep         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prep_needs             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_fit_reports       ENABLE ROW LEVEL SECURITY;

-- Class B — the browser reads/writes these directly with the anon key today.
-- Enable RLS and grant full access to any signed-in (authenticated) session.
-- No per-row / per-user predicate: single household, one shared login, so a
-- blanket USING(true)/WITH CHECK(true) is the correct altitude. anon (a
-- browser that has NOT logged in) still gets nothing.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'recipes','recipe_ingredients','family_members','weekly_template',
    'preschool_meals','inventory','freezer_stash','meal_plans','plan_edits',
    'chat_history','recipe_variants','recipe_variant_ingredients',
    'prepped_components','preschool_template','plan_generation_log',
    'master_ingredients','day_settings','recipe_tags','recipe_cuisines',
    'recipe_cooking_methods','recipe_proteins','recipe_styles',
    'grocery_list_snapshot','freezer_meal_overrides'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS household_rw ON public.%I;', t);
    EXECUTE format(
      'CREATE POLICY household_rw ON public.%I FOR ALL TO authenticated USING (true) WITH CHECK (true);',
      t);
  END LOOP;
END $$;

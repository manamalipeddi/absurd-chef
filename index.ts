// AbsurdChef — Meal Planning Agent
// Supabase Edge Function: supabase/functions/plan-generator/index.ts
// Deploy: supabase functions deploy plan-generator --no-verify-jwt
// Secrets: supabase secrets set ANTHROPIC_API_KEY=sk-ant-...

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// ── Planning rules ─────────────────────────────────────────────────────────
// BREAKFAST AND SNACK ARE NEVER PLANNED BY THE AI.
// Breakfast is decided same-day by Manasa based on energy/mood/freezer stash;
// snack is treated the same way. This planner writes meal_plans rows for 'dinner'
// only. 'lunch' rows are written only on weekends (day_of_week IN [0,6]) or
// special_days where type = 'kids_home'. Snack/breakfast are never written.

// ── Types ──────────────────────────────────────────────────────────────────

interface PlanRequest {
  mode: "full_14" | "rolling_7" | "targeted";
  start_date?: string;
  days?: number;
  triggered_by?: "scheduled" | "manual";
  target_dates?: string[];
}

interface Recipe {
  id: string;
  name: string;
  protein: string | null;
  style: string | null;
  cooking_method: string | null;
  tags: string[];
  last_made: string | null;
  template_slots: string[];
  is_freezable: boolean;
  prep_time_min: number | null;
  cook_time_min: number | null;
  contains_allergen: string[];
}

interface TemplateRule {
  day_of_week: number;
  meal_type: string;
  constraint_type: string;
  constraint_value: string;
  label: string;
}

interface DaySetting {
  day: string;
  is_commute_day: boolean;
  kids_home: boolean;
  gintas_away: boolean;
  is_vacation: boolean;
  guest_count: number;
  guest_family_member_ids?: string[];
  guest_allergies?: Array<{ substance: string; severity: string }>;
}

interface PreschoolMeal {
  iso_week: string;
  day_of_week: number;
  protein: string | null;
  style: string | null;
  lunch_weight: string;
  meal_description: string;
}

interface PreschoolTemplate {
  day_of_week: number;
  typical_description: string | null;
  protein: string | null;
  style: string | null;
  lunch_weight: string;
}


interface FamilyMember {
  id: string;
  name: string;
  role: string;
  allergies: Array<{ substance: string }> | null;
}

interface StashItem {
  id: string;
  recipe_name: string;
  recipe_id: string | null;
  portions: number;
  protein?: string;
  style?: string;
}

interface PlanDay {
  date: string;
  day_of_week: number; // 0=Sun, 1=Mon...6=Sat
  meal_type: string;
  recipe_id: string | null;
  recipe_name: string | null;
  cook_source: "home" | "freezer_stash" | "store_bought" | "slow_cook";
  is_commute_day: boolean;
  is_holiday: boolean;
  is_preschool_closed: boolean;
  guest_count: number;
  stash_item_id: string | null;
  remap_log: object | null;
  notes: string | null;
}

interface Unresolved {
  date: string;
  meal_type: string;
  issue: string;
  options: { label: string; action: string }[];
}

interface StashRecommendation {
  recipe_id: string;
  recipe_name: string;
  suggested_date: string;
  reason: string;
}

interface PlanResult {
  plan: PlanDay[];
  unresolved: Unresolved[];
  stash_recommendations: StashRecommendation[];
}

// ── Date helpers ───────────────────────────────────────────────────────────

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dayOfWeek(dateStr: string): number {
  return new Date(dateStr + "T12:00:00Z").getUTCDay();
}

// Monday of the week containing dateStr (week runs Mon–Sun; Sunday belongs to
// the week that just ended). Used to default start_date for scheduled rolling.
function getMondayOf(dateStr: string): string {
  const dow = dayOfWeek(dateStr); // 0=Sun
  return addDays(dateStr, dow === 0 ? -6 : 1 - dow);
}

function isoWeek(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00Z");
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const startOfWeek1 = new Date(jan4);
  startOfWeek1.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));
  const diff = d.getTime() - startOfWeek1.getTime();
  const week = Math.floor(diff / (7 * 86400000)) + 1;
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function daysBetween(a: string, b: string): number {
  return Math.abs(
    (new Date(a + "T12:00:00Z").getTime() -
      new Date(b + "T12:00:00Z").getTime()) /
      86400000
  );
}

// ── Fetch context from Supabase ────────────────────────────────────────────

async function fetchContext(supabase: ReturnType<typeof createClient>, startDate: string, days: number) {
  const endDate = addDays(startDate, days - 1);

  const [
    recipesRes,
    templateRes,
    daySettingsRes,
    preschoolRes,
    preschoolTemplateRes,
    stashRes,
    existingPlanRes,
    lockedSlotsRes,
    familyRes,
  ] = await Promise.all([
    supabase
      .from("recipes")
      .select("id, name, protein, style, cooking_method, tags, last_made, template_slot, is_freezable, prep_time_min, cook_time_min, contains_allergen")
      .eq("active", true)
      .eq("is_placeholder", false)
      .not("meal_type", "in", '("meal_prep","breakfast","snack","dessert","special")'),
    supabase
      .from("weekly_template")
      .select("*")
      .eq("active", true),
    // Single source of truth for per-day context (commute / kids_home /
    // gintas_away / guests). Read-time defaults apply where no row exists.
    supabase
      .from("day_settings")
      .select("*")
      .gte("day", startDate)
      .lte("day", endDate),
    supabase
      .from("preschool_meals")
      .select("*")
      .order("iso_week", { ascending: false })
      .limit(20),
    supabase
      .from("preschool_template")
      .select("*")
      .eq("active", true)
      .order("day_of_week"),
    supabase
      .from("freezer_stash")
      .select("id, recipe_name, recipe_id, portions, notes, source, typically_restocked")
      .eq("used", false).eq("active", true)
      // include 0-portion items that are typically restocked (week-2 eligible)
      .or("portions.gt.0,typically_restocked.eq.true"),
    // recently_used reads ACTUAL outcome: when a past day was made differently
    // (actually_made = false) use actual_recipe_id; otherwise the planned recipe.
    supabase
      .from("meal_plans")
      .select("plan_date, meal_type, recipe_id, actually_made, actual_recipe_id, planned:recipes!meal_plans_recipe_id_fkey(name, protein, style, is_placeholder), actual:recipes!meal_plans_actual_recipe_id_fkey(name, protein, style, is_placeholder)")
      .gte("plan_date", addDays(startDate, -14))
      .lt("plan_date", startDate),
    // Locked slots WITHIN the planning window — immovable; the planner must keep
    // them as-is and count their recipe against the no-repeat window.
    supabase
      .from("meal_plans")
      .select("plan_date, meal_type, recipe_id, slot_locked, planned:recipes!meal_plans_recipe_id_fkey(name, protein, style, is_placeholder)")
      .gte("plan_date", startDate)
      .lte("plan_date", endDate)
      .eq("slot_locked", true),
    supabase
      .from("family_members")
      .select("id, name, role, allergies, preferences")
      .eq("active", true),
  ]);

  return {
    recipes: recipesRes.data || [],
    template: templateRes.data || [],
    daySettings: daySettingsRes.data || [],
    preschoolMeals: preschoolRes.data || [],
    preschoolTemplate: preschoolTemplateRes.data || [],
    stash: stashRes.data || [],
    existingPlan: existingPlanRes.data || [],
    lockedSlots: lockedSlotsRes.data || [],
    family: familyRes.data || [],
  };
}

// ── Build structured prompt ────────────────────────────────────────────────

function buildPrompt(
  startDate: string,
  days: number,
  ctx: Awaited<ReturnType<typeof fetchContext>>
): string {
  const endDate = addDays(startDate, days - 1);

  // Collect allergens from household members only — guests are date-scoped, not global
  const allergens: string[] = [];
  for (const member of ctx.family as FamilyMember[]) {
    if (member.role === "guest") continue;
    for (const a of member.allergies || []) {
      if (a.substance && !allergens.includes(a.substance)) allergens.push(a.substance);
    }
  }

  // Build guest member ID → allergens map for date-scoped guest constraints
  const guestMemberAllergens: Record<string, string[]> = {};
  for (const member of ctx.family as FamilyMember[]) {
    if (member.role !== "guest") continue;
    guestMemberAllergens[member.id] = (member.allergies || []).map(a => a.substance).filter(Boolean);
  }

  // Filter recipes: remove anything with a household allergen
  const safeRecipes = ctx.recipes.filter((r: Recipe) => {
    const rAllergens = r.contains_allergen || [];
    return !allergens.some((a) => rAllergens.includes(a));
  });

  // Build date list with metadata
  const dateList = Array.from({ length: days }, (_, i) => {
    const date = addDays(startDate, i);
    const dow = dayOfWeek(date);
    // day_settings is the single source of truth; read-time defaults apply
    // where no row exists (kids_home defaults true on weekends).
    const ds = (ctx.daySettings as DaySetting[]).find(d => d.day === date);
    const isCommute = ds?.is_commute_day ?? false;
    const kidsHome = ds ? ds.kids_home : (dow === 0 || dow === 6);
    // Adapt to the existing per-date shape used below (special.* / preschool_closed)
    const special = (ds && (ds.guest_count > 0 || ds.gintas_away || ds.kids_home)) ? {
      type: ds.guest_count > 0 ? "guests" : (ds.gintas_away ? "gintas_away" : "kids_home"),
      guest_count: ds.guest_count || 0,
      guest_family_member_ids: ds.guest_family_member_ids || [],
      guest_allergies: ds.guest_allergies || [],
      gintas_away: ds.gintas_away || false,
    } : null;
    // 3-tier preschool lookup for this date
    const dateWeek = isoWeek(date);
    const t1 = dow >= 1 && dow <= 5
      ? (ctx.preschoolMeals as PreschoolMeal[]).find(p => p.iso_week === dateWeek && p.day_of_week === dow)
      : undefined;
    const t2 = (!t1 && dow >= 1 && dow <= 5)
      ? (ctx.preschoolMeals as PreschoolMeal[]).find(p => p.iso_week < dateWeek && p.day_of_week === dow)
      : undefined;
    const t3 = (!t1 && !t2 && dow >= 1 && dow <= 5)
      ? (ctx.preschoolTemplate as PreschoolTemplate[]).find(t => t.day_of_week === dow)
      : undefined;
    const preschoolMeal = t1 || t2 || t3;
    const preschoolSource = t1 ? "specific" : t2 ? `stale:${t2.iso_week}` : t3 ? "template_default" : null;
    const templateRule = ctx.template.find(
      (t: TemplateRule) =>
        t.day_of_week === dow && t.meal_type === "dinner"
    );
    const lunchRule = ctx.template.find(
      (t: TemplateRule) => t.day_of_week === dow && t.meal_type === "lunch"
    );

    // Compute date-scoped guest allergens from known guests + one-off entries
    const guestAllergens: string[] = [];
    if (special?.type === "guests") {
      for (const memberId of (special.guest_family_member_ids || [])) {
        for (const a of (guestMemberAllergens[memberId] || [])) {
          if (!guestAllergens.includes(a)) guestAllergens.push(a);
        }
      }
      for (const a of (special.guest_allergies || [])) {
        if (a.substance && !guestAllergens.includes(a.substance)) guestAllergens.push(a.substance);
      }
    }

    return {
      date,
      day_of_week: dow,
      day_name: ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][dow],
      is_vacation: !!ds?.is_vacation,            // overrides everything (rule 0)
      week: i < 7 ? 1 : 2,                       // week-relative inventory (rule 16)
      is_commute: isCommute,
      kids_home: kidsHome,
      weekday_kids_home: kidsHome && dow >= 1 && dow <= 5,   // effort chain (rule 15)
      needs_lunch: !!lunchRule || kidsHome,      // lunch trigger (rule 14)
      lunch_template: lunchRule?.label || lunchRule?.constraint_value || null,
      special_type: special?.type || null,
      guest_count: special?.guest_count || 0,
      guest_allergens: guestAllergens.length > 0 ? guestAllergens : undefined,
      preschool_protein: preschoolMeal?.protein || null,
      preschool_weight: preschoolMeal?.lunch_weight || "medium",
      preschool_source: preschoolSource,
      preschool_closed: kidsHome,
      template_constraint_type: templateRule?.constraint_type || null,
      template_constraint_value: templateRule?.constraint_value || null,
      template_label: templateRule?.label || null,
    };
  });

  // Reads reality: if a past day was made differently, the actual recipe is
  // what counts against the no-repeat window — not the original plan.
  const recentlyUsed = ctx.existingPlan.map((p: {plan_date: string; actually_made: boolean | null; actual_recipe_id: string | null; planned: {name: string; is_placeholder?: boolean} | null; actual: {name: string; is_placeholder?: boolean} | null}) => {
    const useActual = p.actually_made === false && p.actual_recipe_id;
    const r = useActual ? p.actual : p.planned;
    // "Other" is excluded from no-repeat entirely.
    return { date: p.plan_date, name: (r && !r.is_placeholder) ? r.name : null };
  });

  // Locked slots inside the planning window — immovable. Surface them so the
  // model keeps them and counts their recipe against the no-repeat window.
  const lockedList = (ctx.lockedSlots || []).map((p: {plan_date: string; meal_type: string; recipe_id: string; planned: {name: string; is_placeholder?: boolean} | null}) => ({
    date: p.plan_date,
    meal_type: p.meal_type,
    recipe_id: p.recipe_id,
    name: (p.planned && !p.planned.is_placeholder) ? p.planned.name : null,
  }));

  // Lean payload — only fields the planning rules use. We PRECOMPUTE wkh_quick
  // (eligibility for the weekday kids-home quick/kid-safe tier, rule 15c) here
  // rather than shipping raw tags + prep/cook minutes for all ~64 recipes, which
  // keeps the prompt small (the worker is memory-sensitive). Recency is already
  // covered by recently_used.
  const recipeList = safeRecipes.map((r: Recipe) => {
    const tags = r.tags || [];
    // Numeric fallback: only counts as a time signal if at least one of
    // prep/cook is known — an all-null recipe must NOT auto-qualify as quick.
    const hasTime = r.prep_time_min != null || r.cook_time_min != null;
    const quickByTime = hasTime && ((r.prep_time_min || 0) + (r.cook_time_min || 0)) <= 20;
    const wkh_quick =
      tags.includes("dump") ||                                // zero hands-on
      r.cooking_method === "slow_cook" ||                     // dump/slow-cook pool
      (tags.includes("quick") && tags.includes("kidproof")) || // fast + kid-safe
      quickByTime;                                            // ≤20 min combined
    return {
      id: r.id,
      name: r.name,
      protein: r.protein,
      style: r.style,
      method: r.cooking_method,
      slot: r.template_slot,
      freezable: r.is_freezable,
      wkh_quick,   // true → eligible for weekday kids-home quick tier (rule 15c)
    };
  });

  const stashList = ctx.stash.map((s: StashItem) => ({
    id: s.id,
    name: s.recipe_name,
    recipe_id: s.recipe_id,
    portions: s.portions,
    source: (s as Record<string, unknown>).source || "homemade",
    typically_restocked: !!(s as Record<string, unknown>).typically_restocked,
  }));

  return `You are AbsurdChef, an autonomous meal planning agent for a busy family.

FAMILY
- 2 adults (Manasa, Gintas), 3 young children (Lara 6, Ari 3, Astrid 1)
- Gintas skips lunch often — dinner must be substantial
- Household allergens (NEVER use these): ${allergens.join(", ") || "none"}
- Kids attend preschool Mon–Fri (they eat lunch there)

PLANNING PERIOD
- Start: ${startDate} (${dateList[0].day_name})
- End: ${endDate} (${dateList[days-1].day_name})
- Days to plan: ${days}

PLANNING RULES
0. VACATION (checked FIRST, overrides everything): if a day has is_vacation = true,
   output NOTHING for it — no dinner, no lunch, no breakfast, no snack, no entry in
   "plan" at all, and never put it in "unresolved". A vacation day is a deliberate
   absence of a plan, not a gap to fill. This takes precedence over kids_home,
   commute, guests, template — ignore all other day-type logic for that date.
1. Plan dinner for every NON-vacation day. ALSO plan a lunch for any non-vacation day where needs_lunch = true (this covers both weekend template lunches and weekday kids-home days — see rule 14). Output lunch as a separate plan entry with meal_type "lunch". SNACK IS NEVER PLANNED, same as breakfast — never emit a "snack" (or "breakfast") entry under any condition. Only "dinner" (every day) and "lunch" (weekends / holidays / kids_home days) are ever generated.
2. NO-REPEAT — SOFT PREFERENCE, NEVER A HARD BLOCK. The 14-day no-repeat window
   (recently_used below) is a PREFERENCE applied only AFTER every hard constraint
   is satisfied. It must NEVER, on its own, leave a slot unfilled or push it to
   unresolved. This holds in EVERY context — normal days, commute days, weekday
   kids-home days, guest days, batch-cook selection.
   ORDER OF OPERATIONS for every slot:
   (1) Satisfy ALL hard constraints first: household allergens + any guest
       allergens, the template protein/style match, and whichever day-type tier
       logic applies (freezer stash / store-bought / quick-kidproof / dump pool).
   (2) Among the options that pass (1), PREFER one not used in the last 14 days
       (and secondarily not the same protein as the day before — rule 3).
   (3) If EVERY option that passes (1) was used within 14 days, DROP the no-repeat
       preference for this slot and assign the best (1)-valid option anyway, even
       though it repeats. A repeat is ALWAYS better than an empty/unresolved slot.
   TRANSPARENCY: whenever you assign a recipe specifically because no-repeat had
   to be dropped per (3), set "notes" to make that visible, e.g.
   "Repeating sooner than usual — nothing else fit this slot this week".
   (That replaces the usual why-note for that slot.)
3. No same protein two days in a row (a preference, secondary to rule 2's hard constraints).
4. Match each day's template constraint (protein or style).
5. COMMUTE DAYS — strict priority order:
   a. Use freezer stash item matching template slot if available
   b. Use a dump+slow_cook recipe matching template slot
   c. If neither works: try remapping — swap this day with an adjacent
      non-commute day that has a suitable dump recipe, then assign the
      non-dump recipe to the non-commute day
   d. Only if ALL of a/b/c fail on HARD grounds (no usable stash and no
      slot-matching dump recipe exists at all): add to unresolved. A recipe
      being used recently is NOT a reason to fail here — apply rule 2 step (3)
      and repeat rather than leave the slot unresolved.
6. Preschool protein conflict: if dinner protein matches preschool lunch
   protein that day, silently swap to another day in the same week.
   Log the swap in remap_log.
7. On guest days: pick a recipe from template_slot = 'special' or
   a crowd-pleasing recipe. Increase implied portions. If the day has
   guest_allergens, those are HARD constraints for that date only —
   treat them exactly like household allergens (do not suggest any
   recipe whose contains_allergen list intersects with guest_allergens).
8. needs_lunch days: plan a lunch (light, quick). Weekend lunches follow the lunch template (see WEEKLY TEMPLATE LUNCH). Weekday kids-home lunches follow the weekday kids-home effort chain (rule 15).
9. Mark one dinner per week as batch_cook if recipe is freezable —
   this builds the freezer stash.
10. Prefer dump recipes on days adjacent to commute days too
    (less prep the day before helps).
11. Do not repeat the same protein that the preschool served that day.
    preschool_source values: "specific" = confirmed this week's menu; "stale:YYYY-WXX" = most recent past menu (different week); "template_default" = generic observed pattern, no specific week data. All tiers apply equally to the protein conflict check. In display/notes, label template_default as "typical pattern" not "confirmed menu".
12. GUEST ALLERGENS: if a date entry has guest_allergens, those substances
    are forbidden for that specific date only. Filter accordingly when
    selecting a recipe for that day — even if the recipe is otherwise safe.
13. LOCKED SLOTS (see LOCKED below) are immovable user choices. For any
    date+meal_type in LOCKED: output that exact recipe unchanged — do NOT
    substitute, swap, or remap it. Treat its recipe as already-used for the
    no-repeat (rule 2) and same-protein-in-a-row (rule 3) checks, so you
    never schedule that same recipe again nearby. If honouring the locked
    recipe makes another rule impossible to satisfy, work around it by
    changing the OTHER (unlocked) days — never the locked one.
14. NOTES — for EVERY planned slot, set "notes" to ONE short plain-English
    sentence saying why that recipe landed there: the deciding factor, in
    the same tone you'd say it in chat. Examples:
    "Batch-cook day — doubled and added to freezer stash"
    "Commute day — quick stovetop, no prep needed"
    "Swapped from Korean Beef — original stash entry no longer available"
    "Matches Thursday's red meat template, hasn't been made in 18 days"
    Keep it to one sentence. Never leave notes empty for a chosen recipe.
    Do not restate the recipe name; give the reason.
    The cook is Manasa — when a note needs to refer to her, say "Manasa" or
    "your"/"you", never the third-person "the user" / "user's".
15. WEEKDAY KIDS-HOME (weekday_kids_home = true, i.e. a Mon–Fri kids-home day) —
    effort-reduction priority chain for BOTH that day's lunch and dinner, same
    shape as commute days:
    a. Freezer stash matching the slot with portions > 0 (homemade OR store-bought,
       no distinction) — use cook_source "freezer_stash" + stash_item_id.
    b. A store-bought-style stash item at portions 0 BUT typically_restocked = true,
       ONLY if that date is in week 2 (see rule 16) — assign it (the restock is
       surfaced on the Grocery List).
    c. A recipe matching the slot with wkh_quick = true — i.e. a genuinely quick /
       kid-safe option. wkh_quick is precomputed and true for: a dump recipe, a
       slow-cooker dump, a recipe tagged BOTH quick and kidproof, OR any recipe
       whose prep+cook time is ≤20 min. This pool is deliberately WIDER than the
       commute dump pool (tier c there), so a genuinely quick 15-min pasta is fair
       game — important for sustaining variety across long consecutive kids-home
       stretches (e.g. school holidays) where the narrow freezer/dump pool alone
       would be exhausted fast.
    d. Otherwise remap/swap with an adjacent day; only add to unresolved if NO
       wkh_quick recipe and NO usable stash exists at all for the slot — never
       purely because the only options were used recently (rule 2 is soft:
       repeat instead of going unresolved).
16. WEEK-RELATIVE INVENTORY (each day has week = 1 or 2):
    - WEEK 1 (days 1–7): plan strictly against CURRENT stock. A freezer_stash item
      at portions 0 is NOT available this week. Do not rely on buying something new.
    - WEEK 2 (days 8–14): a full week of lead time exists. You MAY assign a
      portions-0 stash item that is typically_restocked, or a recipe whose missing
      ingredients are ordinary grocery items the user can buy this week. The need
      will appear on the Grocery List for the user to order. Do not do this for
      rare/specialty ingredients — use sensible judgement.
17. STORE-BOUGHT stash items (source = "store_bought") need no cooking instructions;
    treat them exactly like homemade stash for assignment. Keep cook_source
    "freezer_stash" and reference stash_item_id.

WEEKLY TEMPLATE (dinner)
${JSON.stringify(ctx.template.filter((t: TemplateRule) => t.meal_type === "dinner"), null, 2)}

WEEKLY TEMPLATE LUNCH
${JSON.stringify(ctx.template.filter((t: TemplateRule) => t.meal_type === "lunch"), null, 2)}

DAYS TO PLAN (with context)
${JSON.stringify(dateList, null, 2)}

AVAILABLE RECIPES (safe for this household)
${JSON.stringify(recipeList, null, 2)}

FREEZER STASH (available now)
${JSON.stringify(stashList, null, 2)}

RECENTLY USED (last 14 days — do not repeat)
${JSON.stringify(recentlyUsed, null, 2)}

LOCKED (immovable — keep these exactly; see rule 13)
${JSON.stringify(lockedList, null, 2)}

OUTPUT FORMAT
Return ONLY valid JSON. No markdown. No explanation. No wrapper text.
The "plan" array holds one entry per dinner for every day, PLUS one entry with
meal_type "lunch" for each day where needs_lunch = true (rule 1/8).

{
  "plan": [
    {
      "date": "YYYY-MM-DD",
      "meal_type": "dinner | lunch",
      "recipe_id": "uuid or null",
      "recipe_name": "string",
      "cook_source": "home | freezer_stash | slow_cook | store_bought",
      "is_commute_day": true/false,
      "is_holiday": true/false,
      "is_preschool_closed": true/false,
      "guest_count": 0,
      "stash_item_id": "uuid or null",
      "remap_log": null or {"reason": "...", "original_date": "...", "swapped_with": "..."},
      "notes": "one short plain-English sentence: WHY this recipe was chosen for this slot (see rule 14)"
    }
  ],
  "unresolved": [
    {
      "date": "YYYY-MM-DD",
      "meal_type": "dinner",
      "issue": "plain English explanation of what couldn't be resolved",
      "options": [
        {"label": "short action label", "action": "machine_key"}
      ]
    }
  ],
  "stash_recommendations": [
    {
      "recipe_id": "uuid",
      "recipe_name": "string",
      "suggested_date": "YYYY-MM-DD",
      "reason": "plain English — e.g. double batch covers commute day on June 23"
    }
  ]
}`;
}

// ── Write plan to Supabase ─────────────────────────────────────────────────

async function writePlan(
  supabase: ReturnType<typeof createClient>,
  plan: PlanDay[],
  mode: string,
  targetDates?: string[],
  startDate?: string,
  vacationDates?: string[],
  daySettings?: DaySetting[],
) {
  const MEALS = ["dinner", "lunch"];          // the planner writes these two
  const lockedKey = (d: string, m: string) => `${d}|${m}`;
  const vacSet = new Set(vacationDates || []);

  // Day context written to meal_plans is sourced from day_settings (the single
  // source of truth) — NOT from the model's echoed output, which can drift and
  // wrongly mark days as commute / kids-home / guests. Read-time defaults match
  // the rest of the app (kids_home defaults true on weekends).
  const dsByDay: Record<string, DaySetting> = {};
  for (const d of (daySettings || [])) dsByDay[d.day] = d;
  const dayContext = (date: string) => {
    const ds = dsByDay[date];
    const dow = dayOfWeek(date);
    return {
      is_commute_day: ds?.is_commute_day ?? false,
      is_preschool_closed: ds ? !!ds.kids_home : (dow === 0 || dow === 6),
      is_holiday: false,   // day_settings has no holiday concept; kids_home covers it
      guest_count: ds?.guest_count ?? 0,
    };
  };

  // Keep dinner + lunch; drop stray breakfast/snack. The day set is driven by
  // dinners (one per day); lunch rides along for the same dates.
  let rowsAll = plan.filter((p) => MEALS.includes(p.meal_type));
  const dinnerDates = [...new Set(rowsAll.filter(p => p.meal_type === "dinner").map(p => p.date))].sort();

  let writeDates: Set<string>;
  if (mode === "rolling_7") writeDates = new Set(dinnerDates.slice(7));   // days 8–14
  else if (mode === "targeted" && targetDates?.length) writeDates = new Set(targetDates);
  else writeDates = new Set(dinnerDates);
  // Never write a vacation day, even if the model mistakenly emits one.
  let toWrite = rowsAll.filter((p) => writeDates.has(p.date) && !vacSet.has(p.date));

  // Week-relative stash validation: a stash ref is normally only valid when
  // portions > 0, BUT a typically_restocked item is also allowed in WEEK 2
  // (date >= startDate+7) even at portions 0 — the user has a week of lead time
  // to restock, and the need is surfaced on the Grocery List.
  const week2From = startDate ? addDays(startDate, 7) : null;
  const stashPlanItems = toWrite.filter(p => p.cook_source === "freezer_stash" && p.stash_item_id);
  if (stashPlanItems.length > 0) {
    const { data: stashRows } = await supabase.from("freezer_stash")
      .select("id, portions, used, active, typically_restocked")
      .in("id", stashPlanItems.map(p => p.stash_item_id!));
    const byId = new Map((stashRows || []).map((s: Record<string, unknown>) => [s.id, s]));
    toWrite = toWrite.map(p => {
      if (p.cook_source === "freezer_stash" && p.stash_item_id) {
        const s = byId.get(p.stash_item_id) as Record<string, unknown> | undefined;
        const live = s && !s.used && s.active && (s.portions as number) > 0;
        const week2Restock = s && s.active && s.typically_restocked && week2From && p.date >= week2From;
        if (!live && !week2Restock) {
          return { ...p, cook_source: "home" as const, stash_item_id: null,
            notes: (p.notes ? p.notes + " | " : "") + "[stash ref invalidated at write time — reverted to home]" };
        }
      }
      return p;
    });
  }

  // Vacation days within the window must be CLEARED (so toggling vacation on
  // wipes any prior plan). Add them to the delete set; nothing is inserted for
  // them (locked rows are still protected by the slot_locked guard below).
  let vacInWindow: string[] = [];
  if (vacSet.size > 0) {
    if (mode === "targeted" && targetDates?.length) {
      vacInWindow = [...vacSet].filter(d => targetDates.includes(d));
    } else if (startDate) {
      const winStart = mode === "rolling_7" ? addDays(startDate, 7) : startDate;
      const winEnd = addDays(startDate, 13);
      vacInWindow = [...vacSet].filter(d => d >= winStart && d <= winEnd);
    }
  }

  const dates = [...new Set([...writeDates, ...vacInWindow])];

  // ── HARD RULE: never overwrite a manually-locked slot (dinner OR lunch). ────
  const { data: lockedRows } = await supabase
    .from("meal_plans")
    .select("plan_date, meal_type")
    .in("plan_date", dates)
    .in("meal_type", MEALS)
    .eq("slot_locked", true);
  const lockedSet = new Set(
    (lockedRows || []).map((r: { plan_date: string; meal_type: string }) => lockedKey(r.plan_date, r.meal_type))
  );
  if (lockedSet.size > 0) console.log(`Skipping ${lockedSet.size} locked slot(s)`);

  toWrite = toWrite.filter((p) => !lockedSet.has(lockedKey(p.date, p.meal_type)));

  // Dedup by date+meal_type (model can emit a date twice via remap).
  const seen = new Set<string>();
  toWrite = toWrite.filter((p) => {
    const k = lockedKey(p.date, p.meal_type);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Delete existing (unlocked) dinner+lunch entries for these dates, then insert.
  if (dates.length > 0) {
    await supabase
      .from("meal_plans")
      .delete()
      .in("plan_date", dates)
      .in("meal_type", MEALS)
      .or("slot_locked.is.null,slot_locked.eq.false");
  }

  // Insert new plan — day-context columns come from day_settings, not the model.
  const rows = toWrite.map((p) => ({
    plan_date: p.date,
    meal_type: p.meal_type,
    recipe_id: p.recipe_id,
    is_commute_day: dayContext(p.date).is_commute_day,
    is_holiday: dayContext(p.date).is_holiday,
    is_preschool_closed: dayContext(p.date).is_preschool_closed,
    guest_count: dayContext(p.date).guest_count,
    cook_source: p.cook_source,
    stash_item_id: p.stash_item_id,
    remap_log: p.remap_log,
    notes: p.notes,
    swap_reason: p.remap_log
      ? (p.remap_log as {reason?: string}).reason || null
      : null,
  }));

  if (rows.length > 0) {
    const { error } = await supabase.from("meal_plans").insert(rows);
    if (error) throw new Error(`Failed to write plan: ${error.message}`);
  }

  // Mark used stash items — but only those with portions remaining. A week-2
  // restock assignment (portions 0, typically_restocked) is a future need, not
  // a consumption, so it must NOT be marked used.
  const stashIds = toWrite.filter(p => p.stash_item_id).map(p => p.stash_item_id!);
  if (stashIds.length > 0) {
    const { data: live } = await supabase.from("freezer_stash")
      .select("id").in("id", stashIds).eq("active", true).gt("portions", 0);
    const liveIds = (live || []).map((s: { id: string }) => s.id);
    if (liveIds.length > 0) {
      await supabase.from("freezer_stash")
        .update({ used: true, used_date: new Date().toISOString().slice(0, 10) })
        .in("id", liveIds);
    }
  }
}

// ── Main handler ───────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  // CORS for PWA
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  // Hoisted so the catch block can mark the log row as failed.
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  let logId: string | null = null;

  try {
    const body: PlanRequest = await req.json();
    const { mode, days: reqDays } = body;
    const triggeredBy = body.triggered_by === "scheduled" ? "scheduled" : "manual";

    if (!mode) {
      return new Response(
        JSON.stringify({ error: "mode is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Open a log row for this attempt (success/completed_at filled in later).
    const { data: logRow } = await supabase
      .from("plan_generation_log")
      .insert({ triggered_by: triggeredBy, mode })
      .select("id")
      .single();
    logId = logRow?.id ?? null;

    // targeted: scoped replan of specific dates only (from the Day Settings
    // grid). Window spans the requested dates; only those rows are written.
    const targetDates = (mode === "targeted" && Array.isArray(body.target_dates))
      ? [...new Set(body.target_dates)].filter(Boolean).sort()
      : undefined;

    // start_date is optional: when omitted (e.g. the scheduled Sunday rolling
    // run) default to the Monday of the current week. With rolling_7 the
    // generator writes days 8–14, i.e. it extends the plan into next week.
    const start_date =
      (targetDates?.length ? targetDates[0] : body.start_date) ||
      getMondayOf(new Date().toISOString().slice(0, 10));

    let days = reqDays && reqDays >= 1 && reqDays <= 14 ? reqDays : 14;
    if (targetDates?.length) {
      const span = Math.round(
        (new Date(targetDates[targetDates.length - 1] + "T12:00:00Z").getTime()
         - new Date(targetDates[0] + "T12:00:00Z").getTime()) / 86400000) + 1;
      days = Math.min(14, Math.max(1, span));
    }

    console.log(`Planning ${mode} from ${start_date} (${triggeredBy})`);

    // 1. Fetch all context from DB
    const ctx = await fetchContext(supabase, start_date, days);
    console.log(`Context: ${ctx.recipes.length} recipes, ${ctx.stash.length} stash items`);

    // 2. Build prompt
    const prompt = buildPrompt(start_date, days, ctx);

    // 3. Call Claude
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        // Capped lower than 16k: a 14-day plan (dinners + lunches + concise
        // notes) fits comfortably under this, and bounding output keeps the
        // worst-case generation time (and worker resource use) in check.
        model: "claude-sonnet-4-6",
        max_tokens: 11000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      throw new Error(`Claude API error: ${err}`);
    }

    const claudeData = await claudeRes.json();
    const rawText = claudeData.content[0].text.trim();

    // 4. Parse response
    const clean = rawText.replace(/```json|```/g, "").trim();
    const result: PlanResult = JSON.parse(clean);

    console.log(
      `Plan: ${result.plan.length} days, ${result.unresolved.length} unresolved`
    );

    // 5. Write plan to DB (skip & clear vacation days)
    const vacationDates = (ctx.daySettings as DaySetting[]).filter(d => d.is_vacation).map(d => d.day);
    await writePlan(supabase, result.plan, mode, targetDates, start_date, vacationDates, ctx.daySettings as DaySetting[]);

    // dinner rows are the only ones written; report that count
    const dinnerCount = result.plan.filter((p) => p.meal_type === "dinner").length;
    const daysPlanned = mode === "targeted"
      ? (targetDates?.length || 0)
      : mode === "rolling_7" ? Math.max(0, dinnerCount - 7) : dinnerCount;

    // Mark the log row succeeded.
    if (logId) {
      await supabase
        .from("plan_generation_log")
        .update({ success: true, completed_at: new Date().toISOString(), days_generated: daysPlanned })
        .eq("id", logId);
    }

    // 6. Return result to client
    // Client only needs unresolved items + stash recommendations
    // The full plan is now in the DB and will be fetched normally
    return new Response(
      JSON.stringify({
        success: true,
        days_planned: daysPlanned,
        unresolved: result.unresolved,
        stash_recommendations: result.stash_recommendations,
      }),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  } catch (err) {
    console.error("Plan generation error:", err);
    const errMsg = err instanceof Error ? err.message : "Unknown error";

    // Mark the log row failed so the Plan tab can surface it.
    if (logId) {
      await supabase
        .from("plan_generation_log")
        .update({ success: false, completed_at: new Date().toISOString(), error_message: errMsg })
        .eq("id", logId);
    }

    return new Response(
      JSON.stringify({
        success: false,
        error: errMsg,
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }
});

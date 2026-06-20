// AbsurdChef — Meal Planning Agent
// Supabase Edge Function: supabase/functions/plan-generator/index.ts
// Deploy: supabase functions deploy plan-generator --no-verify-jwt
// Secrets: supabase secrets set ANTHROPIC_API_KEY=sk-ant-...

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// ── Planning rules ─────────────────────────────────────────────────────────
// BREAKFAST IS NEVER PLANNED BY THE AI.
// Breakfast is decided same-day by the user based on energy/mood/freezer stash.
// This planner writes meal_plans rows for 'dinner' only.
// 'lunch' rows are written only on weekends (day_of_week IN [0,6]) or special_days
// where type = 'kids_home'.

// ── Types ──────────────────────────────────────────────────────────────────

interface PlanRequest {
  mode: "full_14" | "rolling_7" | "targeted";
  start_date?: string;
  days?: number;
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

interface CommuteDayRule {
  day_of_week: number;
  label: string;
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

interface SpecialDay {
  day: string;
  type: string;
  guest_count?: number;
  guest_family_member_ids?: string[];
  guest_allergies?: Array<{ substance: string; severity: string }>;
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
    commuteRes,
    preschoolRes,
    preschoolTemplateRes,
    specialRes,
    stashRes,
    existingPlanRes,
    lockedSlotsRes,
    familyRes,
  ] = await Promise.all([
    supabase
      .from("recipes")
      .select("id, name, protein, style, cooking_method, tags, last_made, template_slot, is_freezable, prep_time_min, cook_time_min, contains_allergen")
      .eq("active", true)
      .not("meal_type", "in", '("meal_prep","breakfast","snack","dessert","special")'),
    supabase
      .from("weekly_template")
      .select("*")
      .eq("active", true),
    supabase
      .from("commute_days")
      .select("*")
      .eq("active", true),
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
      .from("special_days")
      .select("*")
      .gte("day", startDate)
      .lte("day", endDate),
    supabase
      .from("freezer_stash")
      .select("id, recipe_name, recipe_id, portions, notes")
      .eq("used", false)
      .gt("portions", 0),
    supabase
      .from("meal_plans")
      .select("plan_date, meal_type, recipe_id, recipes(name, protein, style)")
      .gte("plan_date", addDays(startDate, -14))
      .lt("plan_date", startDate),
    // Locked slots WITHIN the planning window — immovable; the planner must keep
    // them as-is and count their recipe against the no-repeat window.
    supabase
      .from("meal_plans")
      .select("plan_date, meal_type, recipe_id, slot_locked, recipes(name, protein, style)")
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
    commuteDays: commuteRes.data || [],
    preschoolMeals: preschoolRes.data || [],
    preschoolTemplate: preschoolTemplateRes.data || [],
    specialDays: specialRes.data || [],
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
    const isCommute = ctx.commuteDays.some(
      (c: CommuteDayRule) => c.day_of_week === dow
    );
    const special = ctx.specialDays.find(
      (s: SpecialDay) => s.day === date
    );
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
      is_commute: isCommute,
      special_type: special?.type || null,
      guest_count: special?.guest_count || 0,
      guest_allergens: guestAllergens.length > 0 ? guestAllergens : undefined,
      preschool_protein: preschoolMeal?.protein || null,
      preschool_weight: preschoolMeal?.lunch_weight || "medium",
      preschool_source: preschoolSource,
      preschool_closed: special?.type === "kids_home" || special?.type === "preschool_closed",
      template_constraint_type: templateRule?.constraint_type || null,
      template_constraint_value: templateRule?.constraint_value || null,
      template_label: templateRule?.label || null,
    };
  });

  const recentlyUsed = ctx.existingPlan.map((p: {plan_date: string; recipes: {name: string} | null}) => ({
    date: p.plan_date,
    name: p.recipes?.name || null,
  }));

  // Locked slots inside the planning window — immovable. Surface them so the
  // model keeps them and counts their recipe against the no-repeat window.
  const lockedList = (ctx.lockedSlots || []).map((p: {plan_date: string; meal_type: string; recipe_id: string; recipes: {name: string} | null}) => ({
    date: p.plan_date,
    meal_type: p.meal_type,
    recipe_id: p.recipe_id,
    name: p.recipes?.name || null,
  }));

  const recipeList = safeRecipes.map((r: Recipe) => ({
    id: r.id,
    name: r.name,
    protein: r.protein,
    style: r.style,
    method: r.cooking_method,
    tags: r.tags,
    last_made: r.last_made,
    slot: r.template_slot,
    freezable: r.is_freezable,
    prep_min: r.prep_time_min,
    cook_min: r.cook_time_min,
  }));

  const stashList = ctx.stash.map((s: StashItem) => ({
    id: s.id,
    name: s.recipe_name,
    recipe_id: s.recipe_id,
    portions: s.portions,
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
1. Plan dinner for every day. Add lunch only on kids_home days (special_type = 'kids_home').
2. No recipe repeat within 14 days (check recently_used below).
3. No same protein two days in a row.
4. Match each day's template constraint (protein or style).
5. COMMUTE DAYS — strict priority order:
   a. Use freezer stash item matching template slot if available
   b. Use a dump+slow_cook recipe matching template slot
   c. If neither works: try remapping — swap this day with an adjacent
      non-commute day that has a suitable dump recipe, then assign the
      non-dump recipe to the non-commute day
   d. Only if ALL of a/b/c fail: add to unresolved
6. Preschool protein conflict: if dinner protein matches preschool lunch
   protein that day, silently swap to another day in the same week.
   Log the swap in remap_log.
7. On guest days: pick a recipe from template_slot = 'special' or
   a crowd-pleasing recipe. Increase implied portions. If the day has
   guest_allergens, those are HARD constraints for that date only —
   treat them exactly like household allergens (do not suggest any
   recipe whose contains_allergen list intersects with guest_allergens).
8. On kids_home days: plan a lunch too (light, quick).
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

WEEKLY TEMPLATE
${JSON.stringify(ctx.template.filter((t: TemplateRule) => t.meal_type === "dinner"), null, 2)}

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

{
  "plan": [
    {
      "date": "YYYY-MM-DD",
      "meal_type": "dinner",
      "recipe_id": "uuid or null",
      "recipe_name": "string",
      "cook_source": "home | freezer_stash | slow_cook | store_bought",
      "is_commute_day": true/false,
      "is_holiday": true/false,
      "is_preschool_closed": true/false,
      "guest_count": 0,
      "stash_item_id": "uuid or null",
      "remap_log": null or {"reason": "...", "original_date": "...", "swapped_with": "..."},
      "notes": null or "string"
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
  mode: string
) {
  // This planner writes 'dinner' rows only (the delete below is dinner-scoped).
  // Filter to dinner FIRST — the model can emit stray breakfast/snack/lunch
  // entries, and slicing before filtering would misalign the rolling window.
  // Sort by date so slice(7) reliably yields days 8–14.
  const dinners = plan
    .filter((p) => p.meal_type === "dinner")
    .sort((a, b) => a.date.localeCompare(b.date));

  // For rolling_7: only write days 8–14 (don't touch existing days 1–7).
  let toWrite = mode === "rolling_7" ? dinners.slice(7) : dinners;

  // Verify stash references are still live before committing
  const stashPlanItems = toWrite.filter(p => p.cook_source === "freezer_stash" && p.stash_item_id)
  if (stashPlanItems.length > 0) {
    const { data: validStash } = await supabase.from("freezer_stash")
      .select("id")
      .in("id", stashPlanItems.map(p => p.stash_item_id!))
      .eq("used", false).eq("active", true).gt("portions", 0)
    const validIds = new Set((validStash || []).map((s: { id: string }) => s.id))
    toWrite = toWrite.map(p => {
      if (p.cook_source === "freezer_stash" && p.stash_item_id && !validIds.has(p.stash_item_id)) {
        return {
          ...p,
          cook_source: "home" as const,
          stash_item_id: null,
          notes: (p.notes ? p.notes + " | " : "") + "[stash ref invalidated at write time — reverted to home]",
        }
      }
      return p
    })
  }

  const dates = toWrite.map((p) => p.date);

  // ── HARD RULE: never overwrite a manually-locked slot ──────────────────────
  // Any meal_plans row with slot_locked = true is a deliberate user assignment
  // (manual Plan-card pick, or chat update_plan_slot). The planner — scheduled
  // OR manual — must leave it exactly as-is: skip the delete AND the insert for
  // that date+meal_type. This is absolute and independent of date-range logic.
  const { data: lockedRows } = await supabase
    .from("meal_plans")
    .select("plan_date, meal_type")
    .in("plan_date", dates)
    .eq("meal_type", "dinner")
    .eq("slot_locked", true);
  const lockedKey = (d: string, m: string) => `${d}|${m}`;
  const lockedSet = new Set(
    (lockedRows || []).map((r: { plan_date: string; meal_type: string }) =>
      lockedKey(r.plan_date, r.meal_type)
    )
  );
  if (lockedSet.size > 0) {
    console.log(`Skipping ${lockedSet.size} locked slot(s): ${[...lockedSet].join(", ")}`);
  }

  // Only write slots that are NOT locked.
  toWrite = toWrite.filter((p) => !lockedSet.has(lockedKey(p.date, p.meal_type)));

  // Dedup by date+meal_type — the model can occasionally emit the same date
  // twice (e.g. via a remap); without this the batch insert violates the
  // (plan_date, meal_type) unique constraint and the whole write rolls back.
  const seen = new Set<string>();
  toWrite = toWrite.filter((p) => {
    const k = lockedKey(p.date, p.meal_type);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const deletableDates = toWrite.map((p) => p.date);

  // Delete existing (unlocked) plan entries for exactly these dates. The list
  // already excludes locked dates; the slot_locked guard is defense-in-depth so
  // a locked row can never be deleted even if lock detection above missed it.
  if (deletableDates.length > 0) {
    await supabase
      .from("meal_plans")
      .delete()
      .in("plan_date", deletableDates)
      .eq("meal_type", "dinner")
      .or("slot_locked.is.null,slot_locked.eq.false");
  }

  // Insert new plan
  const rows = toWrite.map((p) => ({
    plan_date: p.date,
    meal_type: p.meal_type,
    recipe_id: p.recipe_id,
    is_commute_day: p.is_commute_day,
    is_holiday: p.is_holiday,
    is_preschool_closed: p.is_preschool_closed || false,
    guest_count: p.guest_count || 0,
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

  // Mark used stash items
  const usedStashIds = toWrite
    .filter((p) => p.stash_item_id)
    .map((p) => p.stash_item_id!);

  if (usedStashIds.length > 0) {
    await supabase
      .from("freezer_stash")
      .update({ used: true, used_date: new Date().toISOString().slice(0, 10) })
      .in("id", usedStashIds);
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

  try {
    const body: PlanRequest = await req.json();
    const { mode, days: reqDays } = body;

    if (!mode) {
      return new Response(
        JSON.stringify({ error: "mode is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // start_date is optional: when omitted (e.g. the scheduled Sunday rolling
    // run) default to the Monday of the current week. With rolling_7 the
    // generator writes days 8–14, i.e. it extends the plan into next week.
    const start_date =
      body.start_date ||
      getMondayOf(new Date().toISOString().slice(0, 10));

    const days = reqDays && reqDays >= 1 && reqDays <= 14 ? reqDays : 14;
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    console.log(`Planning ${mode} from ${start_date}`);

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
        model: "claude-sonnet-4-6",
        max_tokens: 16000,
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

    // 5. Write plan to DB
    await writePlan(supabase, result.plan, mode);

    // dinner rows are the only ones written; report that count
    const dinnerCount = result.plan.filter((p) => p.meal_type === "dinner").length;
    const daysPlanned = mode === "rolling_7" ? Math.max(0, dinnerCount - 7) : dinnerCount;

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
    return new Response(
      JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : "Unknown error",
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

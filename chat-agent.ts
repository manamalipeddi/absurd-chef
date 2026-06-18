// AbsurdChef — Chat Agent Edge Function
// Deploy: via MCP or supabase functions deploy chat-agent --no-verify-jwt

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Types ──────────────────────────────────────────────────────────────────

interface Message  { role: "user" | "assistant"; content: string }
interface ChatReq  { messages: Message[] }
interface Action {
  type:        "override_day" | "show_recipe";
  date?:       string;
  recipe_id?:  string;
  recipe_name?: string;
  reason?:     string;
}
interface ChatRes  { message: string; action: Action | null }

// ── Date util ──────────────────────────────────────────────────────────────

function addDays(s: string, n: number) {
  const d = new Date(s + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function today() { return new Date().toISOString().slice(0, 10); }

function fmtDate(s: string) {
  const d = new Date(s + "T12:00:00Z");
  return d.toLocaleString("en", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

// ── DB fetches ─────────────────────────────────────────────────────────────

async function fetchContext(db: ReturnType<typeof createClient>) {
  const start = today();
  const end   = addDays(start, 13);

  const [planRes, stashRes, recipeRes] = await Promise.all([
    db.from("meal_plans")
      .select("plan_date, cook_source, recipes(name, protein, template_slot)")
      .gte("plan_date", start).lte("plan_date", end)
      .eq("meal_type", "dinner").order("plan_date"),
    db.from("freezer_stash")
      .select("recipe_name, portions")
      .eq("used", false).gt("portions", 0),
    db.from("recipes")
      .select("id, name, protein, template_slot, cooking_method, is_freezable")
      .eq("active", true)
      .not("meal_type", "in", '("meal_prep","breakfast","snack","dessert","special")'),
  ]);

  return {
    plan:    planRes.data    || [],
    stash:   stashRes.data   || [],
    recipes: recipeRes.data  || [],
  };
}

// ── System prompt ──────────────────────────────────────────────────────────

function buildSystem(ctx: Awaited<ReturnType<typeof fetchContext>>) {
  const planLines = ctx.plan.length
    ? ctx.plan.map((p: Record<string, unknown>) => {
        const r = p.recipes as Record<string, string> | null;
        const name   = r?.name       || (p.cook_source === "freezer_stash" ? "From Freezer" : "—");
        const slot   = r?.template_slot || "";
        const source = p.cook_source === "freezer_stash" ? " [freezer]"
                     : p.cook_source === "slow_cook"     ? " [slow cook]" : "";
        return `  ${fmtDate(p.plan_date as string)}: ${name}${source}${slot ? " (" + slot + ")" : ""}`;
      }).join("\n")
    : "  No plan yet.";

  const stashLines = ctx.stash.length
    ? ctx.stash.map((s: Record<string, unknown>) => `  ${s.recipe_name} — ${s.portions} portions`).join("\n")
    : "  Empty.";

  const recipeLines = ctx.recipes
    .map((r: Record<string, unknown>) =>
      `  ${r.id} | ${r.name} | ${r.protein || "vegetarian"} | ${r.template_slot || "—"} | ${r.cooking_method || "—"}`)
    .join("\n");

  return `You are AbsurdChef, the meal planning assistant for the Malipeddi family:
Manasa and Gintas (adults), Lara (6), Ari (3), Astrid (1).

HARD RULE: Gintas has a severe fish and seafood allergy. Never suggest fish, seafood, salmon, tuna, prawns, shrimp, or any dish containing them. This is non-negotiable.

TODAY: ${today()}

CURRENT DINNER PLAN (next 14 days):
${planLines}

FREEZER STASH (ready to use):
${stashLines}

RECIPE CATALOGUE (id | name | protein | template_slot | cooking_method):
${recipeLines}

─────────────────────────────────────
RESPONSE FORMAT — always return valid JSON, nothing else:

{
  "message": "your response (warm, brief, 1–3 sentences)",
  "action": null
}

For a plan override:
{
  "message": "I've changed [Weekday date] to [Recipe] — [one-line reason].",
  "action": { "type": "override_day", "date": "YYYY-MM-DD", "recipe_id": "full-uuid", "recipe_name": "Name", "reason": "brief" }
}

For a recipe walkthrough:
{
  "message": "Here's how to make [Recipe]: [brief intro].",
  "action": { "type": "show_recipe", "recipe_id": "full-uuid", "recipe_name": "Name" }
}

RULES:
• Overrides: pick ONE recipe — never offer a list. Match the day's template slot. Prefer freezer stash first.
• Substitutions: check freezer stash first, then general kitchen knowledge. Keep it to one suggestion.
• Recipe questions: use show_recipe action so the app can display the full instructions.
• Always confirm overrides in the message text: "I've changed [day] to [recipe]."
• Never suggest fish or seafood (hard allergy).`;
}

// ── Claude call ────────────────────────────────────────────────────────────

async function callClaude(system: string, messages: Message[]): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type":    "application/json",
      "x-api-key":       ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model:      "claude-sonnet-4-6",
      max_tokens: 512,
      system,
      messages,
    }),
  });
  if (!res.ok) throw new Error(`Claude error: ${await res.text()}`);
  const data = await res.json();
  return data.content[0].text.trim();
}

function parseResponse(raw: string): ChatRes {
  try {
    const clean = raw.replace(/^```json|```$/gm, "").trim();
    return JSON.parse(clean);
  } catch {
    // Claude didn't return JSON — wrap it
    return { message: raw, action: null };
  }
}

// ── Action execution ───────────────────────────────────────────────────────

async function executeOverride(
  db:     ReturnType<typeof createClient>,
  action: Action,
  lastUserMsg: string,
) {
  const { date, recipe_name } = action;
  if (!date) return;

  // Resolve recipe_id by name if not given
  let recipeId = action.recipe_id || null;
  if (!recipeId && recipe_name) {
    const { data } = await db.from("recipes").select("id").ilike("name", recipe_name).limit(1).single();
    recipeId = data?.id || null;
  }

  // Get current entry (for audit log)
  const { data: existing } = await db.from("meal_plans")
    .select("id, recipe_id").eq("plan_date", date).eq("meal_type", "dinner").single();

  const prevId = existing?.recipe_id || null;

  // Upsert meal_plans
  await db.from("meal_plans").upsert({
    plan_date:   date,
    meal_type:   "dinner",
    recipe_id:   recipeId,
    cook_source: "home",
    remap_log:   null,
    notes:       action.reason || null,
  }, { onConflict: "plan_date,meal_type" });

  // Audit log
  await db.from("plan_edits").insert({
    plan_date:          date,
    meal_type:          "dinner",
    previous_recipe_id: prevId,
    new_recipe_id:      recipeId,
    edit_source:        "chat",
    instruction_text:   lastUserMsg.slice(0, 500),
  });
}

// ── Handler ────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  try {
    const { messages }: ChatReq = await req.json();
    if (!messages?.length) throw new Error("messages required");

    const db  = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const ctx = await fetchContext(db);
    const sys = buildSystem(ctx);
    const raw = await callClaude(sys, messages);
    const result = parseResponse(raw);

    if (result.action?.type === "override_day") {
      const lastUser = [...messages].reverse().find(m => m.role === "user")?.content || "";
      await executeOverride(db, result.action, lastUser);
    }

    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json", ...CORS },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ message: "Something went wrong — try again.", action: null, _error: String(err) }),
      { status: 500, headers: { "Content-Type": "application/json", ...CORS } },
    );
  }
});

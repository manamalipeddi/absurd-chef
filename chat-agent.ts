// AbsurdChef — Chat Agent Edge Function (v2)
// Real Claude tool-calling loop; server-managed history
// Deploy: supabase functions deploy chat-agent --no-verify-jwt

import Anthropic from 'npm:@anthropic-ai/sdk'
import { createClient } from 'npm:@supabase/supabase-js@2'

const ac  = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY')! })
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'content-type',
}

type DB = ReturnType<typeof createClient>

// ── Helpers ───────────────────────────────────────────────

function today(): string { return new Date().toISOString().slice(0, 10) }

function addDays(s: string, n: number): string {
  const d = new Date(s + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function getMondayOf(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00Z')
  const dow = d.getUTCDay() // 0=Sun
  d.setUTCDate(d.getUTCDate() + (dow === 0 ? -6 : 1 - dow))
  return d.toISOString().slice(0, 10)
}

const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
function dayName(dow: number): string { return DOW_NAMES[dow] ?? `day_${dow}` }
function dayNameFromDate(dateStr: string): string { return dayName(new Date(dateStr + 'T12:00:00Z').getUTCDay()) }

// Wall-clock HH:MM:SS for a status event, in the CLIENT's local time. The client
// passes tz_offset (Date.getTimezoneOffset() minutes, i.e. UTC−local); shifting
// now by −offset gives local time, read out via getUTC* on the shifted instant.
function fmtTs(tzOffsetMin: number): string {
  const d = new Date(Date.now() - tzOffsetMin * 60000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
}

function buildSystem(): string {
  return `You are AbsurdChef, a meal planning assistant for the Malipeddi household.

HOUSEHOLD: Manasa and Gintas (adults), Lara (~8), Ari (~5), Astrid (~3). Recurring guests (e.g. Gintas' parents) have family_members rows with role='guest' — their allergies are stored there and surfaced via get_special_days as known_guests when they visit.

HARD RULE — NON-NEGOTIABLE: Gintas has a severe fish and seafood allergy. Never suggest, recommend, reference, or help cook fish, seafood, salmon, tuna, prawns, shrimp, crab, mussels, or any dish containing them — under any circumstances, regardless of user request or tool output.

HARD RULE — LOCKED SLOTS: A meal_plans slot with slot_locked = true is a deliberate user assignment and must NEVER be silently overwritten — not by a single-slot change, not by a full or rolling replan, regardless of date range. get_plan returns slot_locked per slot; always check it.
- A plain trigger_replan (rolling_7 / full_14) already preserves every locked slot automatically — the generator skips them. You do NOT need to warn about locked slots for a routine replan.
- EXCEPTION — you must ASK FIRST, explicitly, only when a broad replan the user requested logically needs to touch a locked slot to make sense (e.g. "redo this whole week" and a locked day's recipe would otherwise force a repeat within the no-repeat window, or directly contradicts the new request). Name the slot and its recipe: "Monday's dinner is locked to Channa Masala — should I work around that, or are you open to changing it?" Never assume permission to override a lock, even during a broad replan the user asked for.
- Changing a slot the user explicitly names in this turn is itself a deliberate assignment — use update_plan_slot (it re-locks the slot). That is allowed; the protection is against SILENT/automatic overwrites.

HARD RULE — HISTORY IS COMPLETED WORK: The conversation history shows past, already-completed exchanges. ONLY the most recent user message is a new request to act on. NEVER re-execute an action that already has an assistant response after it in the history — a recipe you already added, a grocery order you already processed, a plan change already made are DONE. Treat all prior turns as context only, never as pending/unprocessed work, and never combine an old request with the current one.

HARD RULE — ONE MAJOR TASK AT A TIME: Never combine or parallelise multiple distinct major operations in a single turn (e.g. adding a recipe AND parsing a large grocery order). A big grocery-order parse/import is itself a full task and must not be bundled with anything else. If the current request involves more than one major operation, do the FIRST one only: briefly state what you're doing, complete it, confirm it's done, then ASK whether to proceed with the next — do not start the second until asked.

HARD RULE — NEVER FABRICATE A TOOL RESULT: You may ONLY claim an action happened, or state a fact about stored data, if a tool call in THIS turn actually returned that result. Concretely:
- Never say you found, added, updated, saved, changed, slotted, or logged anything unless a tool call returned success for it in this turn. Phrases like "found it", "updated it", "it already existed", "saved" must be backed by an actual tool result you can see — never asserted from memory, assumption, or what you intended to do.
- To act, you MUST emit the tool call. Describing a change in prose is NOT doing it. If you have not yet called the tool, call it now — do not narrate the outcome first.
- If a tool returns an error or { success: false }, report the failure plainly and say what you'll do next (retry / ask for input / stop). NEVER paper over a failed or absent call by claiming it worked. A malformed/rejected write is a FAILURE, not a success.
- If you cannot find something after searching, say so honestly ("I'm not finding it") — do not invent that it exists or that a prior turn handled it.
- Only after seeing the tool's result do you describe what it did, using its returned fields (e.g. update_recipe's "changed" list, import_grocery_order's "summary").

BEHAVIOR:
- VOICE: you're talking to Manasa. In anything you write for display — chat replies, the reason/notes you save on a plan slot, summaries — address her directly as "you"/"your", or name her "Manasa". NEVER refer to her in the third person as "the user" or "user's" in displayed text.
- Always fetch data before answering. Never guess current plan, inventory, or stash state.
- Propose ONE specific recommendation, not a list of options.
- After any plan edit, confirm the change in plain text and ask if anything else needs adjusting.
- Mid-cook urgent messages ("out of X", "no Y") → direct one-line answer, skip all preamble.
- When citing inventory for substitutions, add a brief hedge — inventory may not be fully current.
- Day-of-week convention used throughout: 0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday. Tool results include pre-computed day_name fields — always use day_name directly, never convert day_of_week integers yourself.
- stash_still_valid: false in a tool result means a meal planned from freezer_stash has no matching valid stash entry — always flag this to the user.
- Freezer stash items with source = "store_bought" are bought ready-made (no recipe to open) — refer to them as store-bought (e.g. "🛒 store-bought lasagna"). A store-bought item at portions 0 with typically_restocked = true is one the user normally keeps stocked and can rebuy on a grocery run.
- Guest days: get_special_days returns known_guests[] (resolved member data) and guest_allergies[] (one-off). Both are hard allergy constraints for that date only — treat them with the same enforcement strength as household allergens when suggesting meals for that specific day.
- Inventory item names follow the pattern "Category - Variant" (e.g. "Milk - Oat", "Bread - Lingon Grova"). When the user describes what they have in stock, call update_inventory_from_description. The tool handles parsing, matching, and writing; your job is to relay what was done and ask about any ambiguous items it surfaces.
- GROCERY ORDER IMPORT: when the user pastes a grocery order confirmation (a block with product lines and "kr" prices, e.g. "Beställda varor" / "Vara Antal Moms Pris" from Mathem), you MUST call import_grocery_order once with the verbatim text — do NOT reply "Done", "Processing", or acknowledge it without actually calling the tool. It is a SINGLE-PASS, NO-CONFIRMATION tool: it parses AND writes inventory immediately (net quantity per item, incl. adjustment/negative lines), and routes ready-to-heat store-bought freezer meals to Freezer Meals instead of inventory. Do NOT ask the user to confirm first, and do NOT call it a second time for the same paste. When it returns, relay its "summary" field to the user as-is. Do NOT regenerate the grocery list afterwards — that only happens on the Sunday cron or the manual Regenerate button. (Most order pastes are routed to the parser automatically before you even see them; this is your instruction for any that reach you directly.)
- WHY-NOTES: when you change a plan slot via update_plan_slot and there's a reason ("swap Thursday, Gintas is craving curry"), pass it as the reason argument — one short sentence. It's saved to the slot's notes and shown on the plan card, separate from the audit log. If the user gives no reason, omit it (the card then shows nothing for that slot).
- FINDING A NAMED RECIPE: when the user names a specific dish and you need its id (to slot it, update it, or just confirm it exists), call search_recipes with the "name" argument — do NOT guess protein/style facets and hope they match. A short distinctive word is enough ("tikka", "channa"). Only fall back to category filters when browsing rather than looking up one dish.
- ACTUAL vs PLANNED: meal_plans records what was planned AND what was actually eaten. When the user says they made something different on a past day ("we ended up ordering pizza Monday", "I made tacos instead of the curry Tuesday"), call update_actual_outcome with that date — actual_recipe_id if it's a tracked recipe, else actual_notes for an untracked meal (takeout, leftovers). Use made_as_planned: true if they confirm they made the plan. This also covers BREAKFAST and SNACK, which are never pre-planned: to log or correct a past breakfast ("we had pancakes yesterday", "fix Tuesday's breakfast to porridge") call update_actual_outcome with meal_type breakfast (or snack) and actual_recipe_id/actual_notes — it creates the history record. get_plan returns actually_made / actual_recipe / actual_notes so you can report what really happened. The recipe actually eaten is what counts for no-repeat — never claim a planned recipe was eaten if actually_made is false.
- WEEKLY OUTCOME CHECK-IN: on Sundays the planner posts a "🗓️ Quick check on last week" message listing last week's unconfirmed meals. When Manasa replies to it ("all as planned", "all as planned except Wednesday — we ordered pizza", "Tuesday we had the leftover dal instead"), log the WHOLE week in this one turn: call get_plan with start_date 7 days ago and days 7 to see each past slot's confirmation state (actually_made / actual_recipe_id / actual_notes all null = unconfirmed), then call update_actual_outcome once per unconfirmed slot — made_as_planned: true for the confirmed ones, actual_recipe_id (tracked recipe) or actual_notes (free text like takeout) for the exceptions. A slot with no planned recipe (open slot / chef's choice) can't be "made as planned" — log what she says was eaten, or skip it if she doesn't say. Never ask her to confirm day by day; one short summary of what you logged at the end is enough.
- COOKING LEARNINGS: when a cooking conversation produces a correction or discovery worth keeping (timing, temperature, a substitution that worked), OFFER to save it to the recipe ("want me to note that on the recipe?") and call update_recipe only after she agrees. When she mentions prepped food she has ready ("I have 10 cubes of cooked onion in the freezer"), log it with add_prepped_component.
- EXPIRING FOOD (recommend-and-approve): get_expiry_recommendations lists inventory expiring in the next ~2 weeks, each with matching existing recipes, plus the upcoming plan slots. Use it when Manasa asks what to cook to use things up, says something is expiring/going off, or replies to an expiry heads-up. Then RECOMMEND ONE concrete action: the nearest suitable upcoming slot + a SINGLE recipe that uses most or all of the expiring items — prefer an existing matching_recipes entry. If none is appealing (or she asks), offer to generate a NEW recipe built around the expiring items via add_recipe. NEVER auto-apply: only after she approves, call update_plan_slot (for a brand-new recipe, add_recipe first, then update_plan_slot with the new id). If she wants a different idea, propose another. If nothing in the catalogue uses an item and she doesn't want a new recipe, say plainly to use it up manually — never invent that it's handled. Items flagged already_auto_planned (critical meat/fish within ~2 days) are already slotted by the planner; don't re-handle them. Don't overwrite a locked slot (see LOCKED SLOTS).
- Today: ${today()}`
}

// ── Tool definitions ──────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'get_plan',
    description: 'Get the meal plan for a date range. Returns meals with recipe names, cook source, and context flags.',
    input_schema: {
      type: 'object' as const,
      properties: {
        start_date: { type: 'string', description: 'ISO date YYYY-MM-DD. Defaults to today.' },
        days:       { type: 'integer', description: 'Number of days. Defaults to 14.' },
      },
    },
  },
  {
    name: 'get_today_recipe',
    description: "Get today's planned dinner with full recipe: ingredients, night_before / morning_of / when_cooking steps, and notes (tips/shortcuts).",
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'search_recipes',
    description: 'Search the recipe catalogue. To find a SPECIFIC recipe the user names ("do we have channa masala?", "pull up the tikka recipe"), pass its name via `name` — this is the reliable way to locate one recipe and get its id (e.g. to then update_plan_slot or update_recipe). The other fields (protein/style/method/slot/tags) are for browsing by category. `name` matches on a partial, case-insensitive substring, so a short distinctive word works.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name:           { type: 'string', description: 'Free-text partial match on the recipe name (case-insensitive). Use when the user names a dish.' },
        meal_type:      { type: 'string' },
        protein:        { type: 'string' },
        style:          { type: 'string' },
        template_slot:  { type: 'string' },
        cooking_method: { type: 'string' },
        tags:           { type: 'array', items: { type: 'string' } },
        exclude_used_days: { type: 'integer', description: 'Exclude recipes used in the past N days.' },
      },
    },
  },
  {
    name: 'get_inventory',
    description: 'Get active inventory items. NOTE: may not be fully current — hedge substitution suggestions.',
    input_schema: {
      type: 'object' as const,
      properties: {
        category: { type: 'string', description: 'fridge|freezer|pantry. Omit for all.' },
      },
    },
  },
  {
    name: 'get_freezer_stash',
    description: 'Get active unused freezer stash entries with portions remaining.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_expiry_recommendations',
    description: "Get inventory items expiring within the plan window (default ~14 days), each annotated with matching existing recipes, PLUS the upcoming dinner/lunch slots — everything needed to recommend a use-it-up meal. Use when the user asks what to cook to use things up, mentions something is expiring/going off, or replies to an expiry heads-up. Recommend ONE slot + ONE recipe covering most/all expiring items; only apply via update_plan_slot after the user approves. Items flagged already_auto_planned (critical meat/fish within ~2 days) are already slotted by the planner — don't re-handle them.",
    input_schema: {
      type: 'object' as const,
      properties: {
        days: { type: 'integer', description: 'Window size in days from today. Defaults to 14.' },
      },
    },
  },
  {
    name: 'get_prepped_components',
    description: 'Get prepped components with batches remaining.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'check_substitutes',
    description: "Return inventory data to help reason about substitutes for a missing ingredient. You do the reasoning about what makes a good sub.",
    input_schema: {
      type: 'object' as const,
      properties: {
        ingredient_name: { type: 'string' },
        recipe_context:  { type: 'string' },
      },
      required: ['ingredient_name'],
    },
  },
  {
    name: 'get_family_context',
    description: 'Get family members with allergies and dietary preferences.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_weekly_template',
    description: 'Get active weekly template rules (per-day meal constraints).',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_special_days',
    description: 'Get upcoming special days: kids_home, guest days (with known guest allergies resolved), Gintas away.',
    input_schema: {
      type: 'object' as const,
      properties: {
        start_date: { type: 'string', description: 'ISO date. Defaults to today.' },
        end_date:   { type: 'string', description: 'ISO date. Defaults to 14 days from start.' },
      },
    },
  },
  {
    name: 'get_commute_days',
    description: 'Get active commute day configuration.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'update_inventory_from_description',
    description: 'Parse a free-text description of what the user has in stock and update inventory accordingly. Handles name normalisation ("Category - Variant" format), matching against existing entries, inserting new items, and flagging ambiguous cases for the user to resolve.',
    input_schema: {
      type: 'object' as const,
      properties: {
        description: { type: 'string', description: 'Natural language description of what\'s in stock, e.g. "we have oat milk, 3 eggs, and some frozen chicken".' },
      },
      required: ['description'],
    },
  },
  {
    name: 'import_grocery_order',
    description: "Parse a pasted Mathem grocery order confirmation AND write inventory in one shot. This is a single-pass, no-confirmation tool: it discards headers / change-notification / price lines, computes the NET quantity per product (summing adjustment lines incl. negatives), then updates or creates inventory rows directly. Ready-to-heat store-bought freezer meals (e.g. a Dafgårds lasagne) are routed to Freezer Meals instead of inventory; single-ingredient frozen items (e.g. Spenat Fryst) stay in inventory. It streams progress and returns a plain-English summary — present that summary to the user as-is. Do NOT ask for confirmation before calling it, do NOT call it twice for the same paste, and do NOT regenerate the grocery list afterwards. Use it whenever the user pastes a block of Mathem order text.",
    input_schema: {
      type: 'object' as const,
      properties: {
        raw_text: { type: 'string', description: 'The full pasted Mathem order-confirmation text, verbatim.' },
      },
      required: ['raw_text'],
    },
  },
  {
    name: 'update_plan_slot',
    description: 'Set or change a meal plan entry. Logs the change to plan_edits. Call only after confirming with the user.',
    input_schema: {
      type: 'object' as const,
      properties: {
        plan_date:        { type: 'string', description: 'YYYY-MM-DD' },
        meal_type:        { type: 'string', description: 'dinner|lunch|breakfast' },
        recipe_id:        { type: 'string', description: 'UUID of recipe to assign.' },
        cook_source:      { type: 'string', description: 'home|freezer_stash|slow_cook|store_bought. Default: home.' },
        reason:           { type: 'string', description: 'ONE short plain-English sentence shown on the plan card explaining why this recipe is here, e.g. "Swapped in — Gintas is craving curry". Omit if there is no particular reason.' },
        instruction_text: { type: 'string', description: 'User message that prompted this change (for audit).' },
      },
      required: ['plan_date', 'meal_type', 'recipe_id'],
    },
  },
  {
    name: 'update_actual_outcome',
    description: "Record or change what was ACTUALLY eaten on a PAST date (distinct from what was planned). Use when the user says they made something different, confirms they made the plan, or wants to log/correct a meal — including BREAKFAST and SNACK, which are never pre-planned. e.g. \"I made tacos instead of the curry Tuesday\", \"we had pancakes for breakfast yesterday\". For breakfast/snack (and any slot with no planned meal) this creates the record from scratch; pass actual_recipe_id (tracked recipe) or actual_notes (free text). Past dates only.",
    input_schema: {
      type: 'object' as const,
      properties: {
        plan_date:        { type: 'string', description: 'YYYY-MM-DD (must be in the past).' },
        meal_type:        { type: 'string', description: 'dinner|lunch|breakfast|snack. Default: dinner. breakfast/snack are never planned, so logging one creates a new history record.' },
        made_as_planned:  { type: 'boolean', description: 'true if they made exactly what was planned. When true, omit actual_recipe_id/actual_notes.' },
        actual_recipe_id: { type: 'string', description: 'UUID of the recipe actually made, if it differs from the plan and is a tracked recipe.' },
        actual_notes:     { type: 'string', description: 'Free text for an untracked meal actually eaten, e.g. "ordered takeout", "leftovers". Use instead of actual_recipe_id.' },
      },
      required: ['plan_date'],
    },
  },
  {
    name: 'use_stash_item',
    description: 'Mark a freezer stash item as used (fully or partially).',
    input_schema: {
      type: 'object' as const,
      properties: {
        stash_id:      { type: 'string' },
        portions_used: { type: 'integer', description: 'Portions used. Omit to mark entire entry used.' },
      },
      required: ['stash_id'],
    },
  },
  {
    name: 'add_recipe',
    description: 'Add a NEW recipe to the catalogue and generate ADHD prep layers. Use only when the user explicitly requests it AND the recipe does not already exist. ALWAYS call search_recipes first to check for an existing recipe with the same (or near-identical) name — if one exists, reuse it rather than adding a duplicate. (As a backstop, this tool also refuses to create a second recipe with a name that already exists and returns the existing one.)',
    input_schema: {
      type: 'object' as const,
      properties: {
        name:                  { type: 'string' },
        original_instructions: { type: 'string' },
        ingredients: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name:     { type: 'string' },
              quantity: { type: 'number' },
              unit:     { type: 'string' },
              notes:    { type: 'string' },
            },
            required: ['name'],
          },
        },
        meal_type:      { type: 'string', enum: ['breakfast', 'lunch_dinner', 'snack', 'special'], description: "One of exactly these four. Any dinner/lunch recipe is 'lunch_dinner'; desserts are 'special'." },
        protein:        { type: 'string' },
        style:          { type: 'string' },
        cooking_method: { type: 'string' },
        serves_base:    { type: 'integer' },
      },
      required: ['name', 'original_instructions', 'ingredients'],
    },
  },
  {
    name: 'update_recipe',
    description: "Update an EXISTING recipe: append a dated cooking learning to its notes, replace its instructions, or set metadata fields. Use when a cooking conversation produces a correction or discovery worth keeping (timing, temperature, a substitution that worked) — OFFER first ('want me to note that on the recipe?') and call only after the user agrees. Never use this to create a recipe (that's add_recipe).",
    input_schema: {
      type: 'object' as const,
      properties: {
        recipe_id:            { type: 'string', description: 'UUID of the recipe. Preferred.' },
        recipe_name:          { type: 'string', description: 'Exact recipe name (case-insensitive) if the id is unknown.' },
        append_note:          { type: 'string', description: 'One concise learning to append to the recipe notes, e.g. "Oven strips: pull at 68°C, not 72 — carryover finishes them." Date prefix is added automatically.' },
        replace_instructions: { type: 'string', description: 'Full replacement for original_instructions. Only when the user asked to redo the recipe.' },
        set: {
          type: 'object',
          description: 'Optional metadata updates.',
          properties: {
            protein:       { type: 'string' },
            style:         { type: 'string' },
            prep_time_min: { type: 'integer' },
            cook_time_min: { type: 'integer' },
          },
        },
      },
    },
  },
  {
    name: 'add_prepped_component',
    description: 'Log a prepped component the user has ready (e.g. "cooked frozen onion, ~10 cubes", "boiled potatoes for tomorrow"). Creates a prepped_components row so the planner and chat can see it.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name:          { type: 'string', description: 'What it is, in the household\'s naming style.' },
        batches:       { type: 'integer', description: 'How many batches/portions. Default 1.' },
        storage_notes: { type: 'string', description: 'Where/how it\'s stored, e.g. "freezer, ziplock, 2cm cubes".' },
        recipe_id:     { type: 'string', description: 'Linked recipe UUID, if it came from one.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'log_plan_edit',
    description: 'Log a plan change directly to plan_edits. Use after trigger_replan or bulk changes.',
    input_schema: {
      type: 'object' as const,
      properties: {
        plan_date:          { type: 'string' },
        meal_type:          { type: 'string' },
        previous_recipe_id: { type: 'string' },
        new_recipe_id:      { type: 'string' },
        instruction_text:   { type: 'string' },
      },
      required: ['plan_date', 'meal_type'],
    },
  },
  {
    name: 'trigger_replan',
    description: 'Trigger a meal plan regeneration (rolling_7 = extend next 7 days, full_14 = redo two weeks). Locked slots (slot_locked = true) are always preserved automatically. If a broad replan would logically need to touch a locked slot (see HARD RULE — LOCKED SLOTS), ask the user first before calling this; otherwise call it directly.',
    input_schema: {
      type: 'object' as const,
      properties: {
        mode:   { type: 'string', enum: ['rolling_7', 'full_14'] },
        reason: { type: 'string' },
      },
      required: ['mode', 'reason'],
    },
  },
]

// ── Tool implementations ──────────────────────────────────

async function toolGetPlan(input: Record<string, unknown>, db: DB) {
  const start = (input.start_date as string) || today()
  const days  = Number(input.days) || 14
  const end   = addDays(start, days - 1)
  const { data } = await db.from('meal_plans')
    .select('plan_date, meal_type, cook_source, is_commute_day, is_holiday, guest_count, slot_locked, notes, stash_item_id, actually_made, actual_recipe_id, actual_notes, recipes!meal_plans_recipe_id_fkey(id, name, emoji, protein, cooking_method, template_slot), actual_recipe:recipes!meal_plans_actual_recipe_id_fkey(id, name, emoji)')
    .gte('plan_date', start).lte('plan_date', end)
    .in('meal_type', ['dinner', 'lunch'])   // snack & breakfast are not planned — out of scope here
    .order('plan_date').order('meal_type')

  const entries = (data || []) as Record<string, unknown>[]

  // Cross-check any freezer_stash assignments — verify the row still exists
  // (plan-generator marks items used=true at write time, so we only check existence)
  const stashIds = entries
    .filter(e => e.cook_source === 'freezer_stash' && e.stash_item_id)
    .map(e => e.stash_item_id as string)
  const validStashIds = new Set<string>()
  if (stashIds.length > 0) {
    const { data: valid } = await db.from('freezer_stash')
      .select('id').in('id', stashIds).eq('active', true)
    ;(valid || []).forEach((s: Record<string, unknown>) => validStashIds.add(s.id as string))
  }

  return {
    range: { start, end },
    entries: entries.map(e => ({
      ...e,
      day_name: dayNameFromDate(e.plan_date as string),
      ...(e.cook_source === 'freezer_stash' ? {
        stash_still_valid: e.stash_item_id ? validStashIds.has(e.stash_item_id as string) : null,
      } : {}),
    })),
  }
}

async function toolGetTodayRecipe(db: DB) {
  const t = today()
  const { data } = await db.from('meal_plans')
    .select('plan_date, meal_type, cook_source, guest_count, stash_item_id, recipes!meal_plans_recipe_id_fkey(id, name, emoji, protein, serves_base, original_instructions, night_before, morning_of, when_cooking, notes, recipe_ingredients(name, quantity, unit, notes, order_index))')
    .eq('plan_date', t).in('meal_type', ['dinner', 'lunch']).order('meal_type')
  if (!data?.length) return { message: 'No meal planned for today.' }

  const entries = data as Record<string, unknown>[]
  const stashIds = entries
    .filter(e => e.cook_source === 'freezer_stash' && e.stash_item_id)
    .map(e => e.stash_item_id as string)
  const validStashIds = new Set<string>()
  if (stashIds.length > 0) {
    const { data: valid } = await db.from('freezer_stash')
      .select('id').in('id', stashIds).eq('active', true)
    ;(valid || []).forEach((s: Record<string, unknown>) => validStashIds.add(s.id as string))
  }

  return {
    today: t,
    meals: entries.map(e => ({
      ...e,
      ...(e.cook_source === 'freezer_stash' ? {
        stash_still_valid: e.stash_item_id ? validStashIds.has(e.stash_item_id as string) : null,
      } : {}),
    })),
  }
}

async function toolSearchRecipes(input: Record<string, unknown>, db: DB) {
  let q = db.from('recipes')
    .select('id, name, emoji, meal_type, protein, style, cooking_method, template_slot, tags, last_made, serves_base, is_freezable, ease_descriptor')
    .eq('active', true)
  if (input.name)           q = q.ilike('name', `%${String(input.name).trim()}%`)
  if (input.meal_type)      q = q.eq('meal_type', input.meal_type as string)
  if (input.protein)        q = q.ilike('protein', `%${input.protein}%`)
  if (input.style)          q = q.ilike('style', `%${input.style}%`)
  if (input.template_slot)  q = q.eq('template_slot', input.template_slot as string)
  if (input.cooking_method) q = q.eq('cooking_method', input.cooking_method as string)
  if (input.exclude_used_days) {
    const cutoff = addDays(today(), -(input.exclude_used_days as number))
    q = q.or(`last_made.is.null,last_made.lt.${cutoff}`)
  }
  const { data } = await q.order('name')
  let results = data || []
  if (Array.isArray(input.tags) && input.tags.length) {
    const tags = input.tags as string[]
    results = results.filter((r: Record<string, unknown>) =>
      tags.some(t => ((r.tags as string[]) || []).includes(t))
    )
  }
  return { recipes: results, count: results.length }
}

async function toolGetInventory(input: Record<string, unknown>, db: DB) {
  let q = db.from('inventory')
    .select('name, quantity, unit, category, expiry_date')
    .eq('active', true).order('category').order('name')
  if (input.category) q = q.eq('category', input.category as string)
  const { data } = await q
  return { items: data || [], note: 'Inventory may not be fully current — hedge accordingly.' }
}

// Expiry recommendation data (Part 3): in-window expiring inventory, each with
// the active recipes that could use it, plus the upcoming dinner/lunch slots so
// the agent can recommend WHERE to slot a use-it-up meal. Recommend-and-approve:
// the agent proposes, the user approves, then update_plan_slot applies it. It
// does NOT auto-assign. Critical meat/fish within 2 days is already auto-slotted
// by the plan-generator (flagged here so the agent doesn't double-handle it).
async function toolGetExpiryRecommendations(input: Record<string, unknown>, db: DB) {
  const start = today()
  const windowDays = Number(input.days) || 14
  const end = addDays(start, windowDays - 1)
  const dayDiff = (iso: string) => Math.round((new Date(iso + 'T00:00:00Z').getTime() - new Date(start + 'T00:00:00Z').getTime()) / 86400000)

  const { data: inv } = await db.from('inventory')
    .select('name, food_category, expiry_date, quantity, status, master_ingredient_id')
    .eq('active', true).not('expiry_date', 'is', null)
    .gte('expiry_date', start).lte('expiry_date', end)
    .order('expiry_date')
  const items = (inv || []).filter((it: Record<string, unknown>) => !(Number(it.quantity) === 0 || it.status === 'out'))
  if (!items.length) return { expiring: [], note: 'Nothing is expiring in the window — no recommendation needed.' }

  const [{ data: recipes }, { data: ings }, { data: slots }] = await Promise.all([
    db.from('recipes').select('id, name, protein, style').eq('active', true).eq('is_placeholder', false),
    db.from('recipe_ingredients').select('recipe_id, name, master_ingredient_id'),
    db.from('meal_plans')
      .select('plan_date, meal_type, slot_locked, recipes!meal_plans_recipe_id_fkey(name)')
      .gte('plan_date', start).lte('plan_date', end).in('meal_type', ['dinner', 'lunch'])
      .order('plan_date').order('meal_type'),
  ])
  const nameById = new Map((recipes || []).map((r: Record<string, unknown>) => [r.id as string, r.name as string]))
  const byMaster = new Map<string, Set<string>>()
  const ingRows: { n: string; recipe_id: string }[] = []
  for (const ri of (ings || []) as Record<string, unknown>[]) {
    if (!nameById.has(ri.recipe_id as string)) continue
    if (ri.master_ingredient_id) {
      const k = ri.master_ingredient_id as string
      if (!byMaster.has(k)) byMaster.set(k, new Set())
      byMaster.get(k)!.add(ri.recipe_id as string)
    }
    ingRows.push({ n: (ri.name as string || '').toLowerCase(), recipe_id: ri.recipe_id as string })
  }
  const matchRecipes = (it: Record<string, unknown>) => {
    const ids = new Set<string>()
    const mid = it.master_ingredient_id as string | null
    if (mid && byMaster.has(mid)) for (const id of byMaster.get(mid)!) ids.add(id)
    const n = (it.name as string || '').toLowerCase()
    const words = n.split(/[\s,-]+/).filter(w => w.length >= 4)
    for (const ri of ingRows) {
      if (ri.n === n || ri.n.includes(n) || n.includes(ri.n) || words.some(w => ri.n.includes(w))) ids.add(ri.recipe_id)
    }
    return [...ids].map(id => nameById.get(id)).filter(Boolean).slice(0, 6)
  }
  const FISH_RE = /\b(fish|salmon|tuna|cod|prawn|shrimp|seafood|haddock|mackerel|sardine)\b/i
  const expiring = items.map((it: Record<string, unknown>) => {
    const daysUntil = dayDiff(it.expiry_date as string)
    const isMeatFish = it.food_category === 'meat' || FISH_RE.test(it.name as string || '')
    return {
      name: it.name, expires: it.expiry_date, days_until: daysUntil,
      already_auto_planned: isMeatFish && daysUntil <= 2,   // critical → planner slotted it
      matching_recipes: matchRecipes(it),
    }
  })
  const upcoming_slots = (slots || []).map((s: Record<string, unknown>) => ({
    date: s.plan_date, meal_type: s.meal_type,
    current_recipe: (s.recipes as { name?: string } | null)?.name || null,
    locked: s.slot_locked === true,
  }))
  return {
    expiring, upcoming_slots,
    note: 'Recommend ONE slot + ONE recipe that uses most/all of these (prefer a matching_recipes entry; offer a NEW recipe via add_recipe if none fits or on request). Do NOT call update_plan_slot until the user approves. Skip items where already_auto_planned is true.',
  }
}

async function toolGetFreezerStash(db: DB) {
  const { data } = await db.from('freezer_stash')
    .select('id, recipe_name, recipe_id, portions, frozen_date, use_by_date, notes, source, typically_restocked')
    .eq('used', false).eq('active', true)
    .or('portions.gt.0,typically_restocked.eq.true')
    .order('frozen_date', { ascending: false })
  return { stash: data || [] }
}

async function toolGetPreppedComponents(db: DB) {
  const { data } = await db.from('prepped_components')
    .select('id, recipe_id, name, batches_remaining, made_date, storage_notes, recipes(name, emoji)')
    .eq('active', true).gt('batches_remaining', 0)
    .order('made_date', { ascending: false })
  return { components: data || [] }
}

async function toolCheckSubstitutes(input: Record<string, unknown>, db: DB) {
  const { data } = await db.from('inventory')
    .select('name, quantity, unit, category').eq('active', true).order('category')
  const available = (data || []).filter((i: Record<string, unknown>) =>
    i.quantity == null || Number(i.quantity) > 0
  )
  return {
    looking_for: input.ingredient_name,
    recipe_context: input.recipe_context || null,
    available_inventory: available,
    note: 'Inventory may not be fully current. You reason about what makes a good substitute.',
  }
}

async function toolGetFamilyContext(db: DB) {
  const { data } = await db.from('family_members')
    .select('name, role, birth_year, allergies, preferences, is_default_household')
    .eq('active', true).order('role')
  return { members: data || [] }
}

async function toolGetWeeklyTemplate(db: DB) {
  const { data } = await db.from('weekly_template').select('*').eq('active', true).order('day_of_week')
  return {
    template: (data || []).map((row: Record<string, unknown>) => ({
      ...row,
      day_name: dayName(row.day_of_week as number),
    })),
  }
}

async function toolGetSpecialDays(input: Record<string, unknown>, db: DB) {
  const start = (input.start_date as string) || today()
  const end   = (input.end_date as string)   || addDays(start, 14)
  // day_settings is the single source of truth. Surface kids-home / gintas-away
  // / guest days (with resolved known-guest allergies) for this window.
  const { data } = await db.from('day_settings').select('*').gte('day', start).lte('day', end).order('day')
  const rows = (data || []).filter((r: Record<string, unknown>) =>
    r.kids_home || r.gintas_away || ((r.guest_count as number) || 0) > 0 || r.note)

  const allGuestIds: string[] = [...new Set(
    rows.flatMap((r: Record<string, unknown>) => (r.guest_family_member_ids as string[] | null) || [])
  )]
  const guestMemberMap: Record<string, Record<string, unknown>> = {}
  if (allGuestIds.length > 0) {
    const { data: members } = await db.from('family_members')
      .select('id, name, allergies, preferences')
      .in('id', allGuestIds)
    for (const m of members || []) {
      guestMemberMap[(m as Record<string, unknown>).id as string] = m as Record<string, unknown>
    }
  }

  return {
    special_days: rows.map((row: Record<string, unknown>) => ({
      day: row.day,
      day_name: dayNameFromDate(row.day as string),
      kids_home: !!row.kids_home,
      gintas_away: !!row.gintas_away,
      guest_count: (row.guest_count as number) || 0,
      guest_allergies: row.guest_allergies || [],
      note: row.note || null,
      known_guests: ((row.guest_family_member_ids as string[]) || [])
        .map(id => guestMemberMap[id])
        .filter(Boolean),
    })),
  }
}

async function toolGetCommuteDays(db: DB) {
  // Commute days now live per-date on day_settings (not a recurring weekday rule).
  const { data } = await db.from('day_settings')
    .select('day, is_commute_day').eq('is_commute_day', true)
    .gte('day', today()).order('day')
  return {
    commute_days: (data || []).map((row: Record<string, unknown>) => ({
      day: row.day,
      day_name: dayNameFromDate(row.day as string),
    })),
  }
}

async function toolUpdateInventoryFromDescription(input: Record<string, unknown>, db: DB) {
  const description = (input.description as string) || ''

  const { data: existing } = await db.from('inventory')
    .select('id, name, quantity, unit, category')
    .eq('active', true).order('name')

  const parsePrompt = `You are an inventory parser. Parse the user's description into structured items and match them against existing inventory.

NAMING CONVENTION: Inventory names use "Category - Variant" format.
Examples: "Bread - Råg Levain", "Milk - Oat", "Milk - Lactose Free", "Chicken - Frozen"
Simple items with no meaningful variant use just the item name: "Eggs", "Butter"

CATEGORY INFERENCE (infer from context):
- fridge: dairy, eggs, fresh produce, opened items, fresh meat, leftovers
- freezer: anything described as frozen or for the freezer
- pantry: bread (unless frozen), dry goods, pasta, rice, canned items, oils, spices, shelf-stable

EXISTING INVENTORY:
${JSON.stringify(existing || [])}

USER DESCRIPTION: "${description}"

For each item in the description:
1. Build the canonical name using "Category - Variant" (or just item name if no variant)
2. Extract quantity (number or null) and unit (string or null) if mentioned
3. Infer category (fridge/freezer/pantry)
4. Set match_type:
   - "new": no similar entry in existing inventory
   - "update": clearly the same as exactly one existing entry — provide that entry's matched_id
   - "ambiguous": multiple entries could plausibly match, OR item is similar but not clearly the same as an existing one (different brand/variant name, unclear if duplicate or new variant)
   For "ambiguous", list the candidate existing names in ambiguous_candidates.

Return ONLY valid JSON, no other text:
{"items":[{"name":"string","quantity":number|null,"unit":"string|null","category":"fridge|freezer|pantry","match_type":"new|update|ambiguous","matched_id":"uuid|null","ambiguity_note":"string|null","ambiguous_candidates":["name1"]}]}`

  type ParsedItem = {
    name: string
    quantity: number | null
    unit: string | null
    category: string
    match_type: 'new' | 'update' | 'ambiguous'
    matched_id: string | null
    ambiguity_note: string | null
    ambiguous_candidates: string[]
  }

  let items: ParsedItem[] = []
  try {
    const resp = await ac.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [{ role: 'user', content: parsePrompt }],
    })
    const raw = ((resp.content[0] as Anthropic.TextBlock).text || '').trim()
    const jsonStr = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    items = (JSON.parse(jsonStr) as { items: ParsedItem[] }).items || []
  } catch (e) {
    return { error: `Failed to parse description: ${String(e)}`, description }
  }

  const newItems       = items.filter(i => i.match_type === 'new')
  const updateItems    = items.filter(i => i.match_type === 'update' && i.matched_id)
  const ambiguousItems = items.filter(i => i.match_type === 'ambiguous')

  const inserted: string[] = []
  if (newItems.length) {
    const { error } = await db.from('inventory').insert(
      newItems.map(i => ({ name: i.name, quantity: i.quantity ?? null, unit: i.unit ?? null, category: i.category, active: true }))
    )
    if (!error) inserted.push(...newItems.map(i => i.name))
  }

  type UpdatedEntry = { name: string; quantity: number | null; unit: string | null }
  const updated: UpdatedEntry[] = []
  // Atypical reconcile: load typical_quantity for the rows being updated. For an
  // atypical item (typical = 0), a write that empties it (qty 0 / 'out') drops it
  // out of inventory (active = false); any remaining stock marks it 'some'.
  const updIds = updateItems.map(i => i.matched_id!).filter(Boolean)
  const typicalById = new Map<string, number | null>()
  if (updIds.length) {
    const { data: trows } = await db.from('inventory').select('id, typical_quantity').in('id', updIds)
    for (const r of (trows || []) as Record<string, unknown>[])
      typicalById.set(r.id as string, r.typical_quantity == null ? null : Number(r.typical_quantity))
  }
  for (const item of updateItems) {
    const upd: Record<string, unknown> = { quantity: item.quantity ?? null, unit: item.unit ?? null }
    if (typicalById.get(item.matched_id!) === 0) {
      const q = item.quantity
      if (q == null || Number(q) <= 0) { upd.status = 'out'; upd.active = false }
      else { upd.status = 'some' }
    }
    const { error } = await db.from('inventory').update(upd).eq('id', item.matched_id!)
    if (!error) updated.push({ name: item.name, quantity: item.quantity, unit: item.unit })
  }

  return {
    inserted,
    updated,
    ambiguous: ambiguousItems.map(i => ({
      described_as: i.name,
      note: i.ambiguity_note,
      candidates: i.ambiguous_candidates,
    })),
  }
}

// ── Grocery order import (Mathem) — deterministic single-pass parse + write ──
// Parses a pasted Mathem order confirmation, computes NET quantity per product
// (summing adjustment lines, including negatives), and writes inventory DIRECTLY
// — there is no confirmation step (the pre-write summary is informational only).
// Steps mirror the grocery spec: discard headers / "Ändring i din beställning" /
// price lines; Swedish decimals; net>0 update-or-create, net=0 cancelled,
// net<0 parse-error or (negative-only) correction to existing stock. Non-food
// PRODUCTS (diapers, cleaning, hygiene…) are recognised and routed to their own
// Non-food list (food_category='non_food'), not the food inventory.
// Matching is deterministic first (normalised name / master-ingredient alias);
// items with no deterministic match go through a Claude pass that maps Mathem's
// verbose names onto existing inventory rows before falling back to create-new.

const NORM = (s: string) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim()
const HEADER_WORDS = new Set(['vara', 'antal', 'moms', 'pris'])

// Swedish decimal ("1,00" / "-2,00") → float, else null.
function swedishNum(s: string): number | null {
  const n = parseFloat(String(s).replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

// Non-food PRODUCTS that must never land in the food inventory — they go to the
// Non-food list instead. Focused, low false-positive list (Swedish + English);
// ambiguous words are deliberately out.
const NON_FOOD_RE = /\b(blöj\w*|diaper\w*|libero|hushållspapper|toapapper|toalettpapper|toilet\s*paper|servett\w*|napkin\w*|aluminiumfolie|plastfilm|gladpack|cling\s*film|vanish|fläckborttag\w*|fläckbort\w*|diskmedel|disktablett\w*|disktabs|maskindisk\w*|dishwash\w*|tvättmedel|sköljmedel|detergent|rengöring\w*|allrengöring|tvål|soap|schampo|shampoo|balsam|conditioner|tandkräm|toothpaste|deodorant|bindor|tampong\w*|batteri\w*|glödlampa|djurfoder|kattmat|hundmat)\b/i
// Detects non-food so it routes to the Non-food list. Primary signal: 25% VAT
// (Mathem food is 6–12%, household/hygiene/cleaning is 25%, and Mathem sells no
// alcohol) — backed by a keyword list for anything mis-rated or when VAT is missing.
function isNonFood(name: string, vat?: number | null): boolean {
  return vat === 25 || NON_FOOD_RE.test(name)
}

// Best-guess non-food sub-category for the Non-food tab's grouping (mirrors the
// app's nonFoodGroupFor). Only a default — the item's edit form lets the user
// override. Matches Swedish product names and English clean names.
function nonFoodGroup(name: string): string {
  const s = String(name || '').toLowerCase()
  if (/detergent|tvättmedel|sköljmedel|stain|fläck|vanish|\bsoap\b|såpa|tvål|rengöring|cleaner|\bclean|disk|dish|wettex|wipe|servett|napkin|bin ?bag|avfallspåse|garbage|trash|sponge|svamp|colou?r.?catch/.test(s)) return 'cleaning'
  if (/foil|folie|baking ?paper|bakplåt|parchment|\btape\b|tejp|cling|plastfilm|gladpack|batter|batteri|bulb|glödlampa/.test(s)) return 'kitchen'
  if (/plaster|plåster|band.?aid|bandage|compress|kompress|first ?aid|gauze|antisept/.test(s)) return 'firstaid'
  if (/shampoo|schampo|conditioner|balsam|toothpaste|tandkräm|toothbrush|tandborste|deodorant|lotion|diaper|blöj|nappy|tampon|\bpad\b|bind|razor|rakhyvel|\bcotton\b|bomull/.test(s)) return 'toiletries'
  if (/\bcat |\bdog |\bpet |kattmat|hundmat|djurfoder|litter|kattsand/.test(s)) return 'pet'
  return 'misc'
}

// ── Ready-to-heat freezer MEAL vs frozen INGREDIENT (deterministic) ──
// Default to FREEZER MEAL when in doubt: a frozen product is treated as a
// ready-to-heat meal (→ freezer_stash) UNLESS it's a clearly-identifiable single
// ingredient (Spenat Fryst, raw fish/meat portions, frozen fruit/veg), which
// stays in inventory. A ready-meal-only brand qualifies on the brand alone.
// Guardrails on the "in doubt → meal" default:
//   - Only FROZEN items are candidates — a non-frozen grocery item can't be a
//     freezer meal (milk, eggs, fresh produce, pantry staples stay inventory).
//   - An explicit chilled/fresh signal (Kyld, Färsk) is never a freezer meal.
// Dish/ingredient words are matched WITHOUT word boundaries so Swedish compounds
// hit too (Lyx·lasagne, Fisk·gratäng, Wok·grönsaker).
const FREEZER_DISH_RE = /(lasagne|gratäng|gratang|gryta|pyttipanna|pytt\s*i\s*panna|wokrätt|wokratt|soppa|pizza|middag|risotto|\bpaj\b|färdigrätt|fardigratt|färdigmat|fardigmat|portionsrätt|portionsratt|pannbiff|köttbullar\s+med|kottbullar\s+med|biff\s+med|pasta\s+med|kyckling\s+med|fisk\s+med)/i
// Brands that sell ONLY ready meals — classify on the brand alone.
const FREEZER_READY_BRAND_RE = /\b(dafgårds|dafgards|gordon\s*ramsay|gordonramsay|billys?\s*pan|liva|la\s*cucina)\b/i
const FROZEN_RE = /\b(fryst|frysta|frozen|djupfryst)\b/i
const CHILLED_RE = /\b(kyld|kylda|färsk|farsk|fresh|chilled)\b/i
// Clear single-ingredient frozen products that stay in inventory despite the
// default-to-meal rule: plain veg, fruit/berries, raw fish/seafood, raw meat,
// herbs, and frozen staples (ice cream, fries, bread, dough).
const FROZEN_INGREDIENT_RE = /(spenat|broccoli|blomkål|blomkal|ärtor|artor|ärter|edamame|majs|haricot|sparris|brysselkål|brysselkal|morot|morötter|morotter|\blök\b|purjolök|grönsak|gronsak|bönor|bonor|\bbär\b|blåbär|blabar|hallon|jordgubb|björnbär|bjornbar|lingon|hjortron|mango|ananas|\bfrukt\b|\blax\b|torsk|\bsej\b|kolja|\bfisk\b|räk|scampi|musslor|bläckfisk|blackfisk|kyckling|kalkon|nötkött|notkott|fläskkött|flaskkott|köttfärs|kottfars|\bfärs\b|\bfars\b|filé|\bfile\b|\bdill\b|persilja|basilika|örter|orter|glass|isglass|pommes|klyftpotatis|potatis|\bbröd\b|\bbrod\b|\bdeg\b|bottnar|smördeg|smordeg)/i
function isFreezerMeal(name: string): boolean {
  const s = String(name || '')
  if (CHILLED_RE.test(s)) return false                          // explicitly chilled/fresh
  if (FREEZER_READY_BRAND_RE.test(s)) return true               // ready-meal-only brand
  if (FREEZER_DISH_RE.test(s) && FROZEN_RE.test(s)) return true // unambiguous frozen dish
  if (!FROZEN_RE.test(s)) return false                          // non-frozen → not a freezer meal
  return !FROZEN_INGREDIENT_RE.test(s)                          // frozen + in doubt → meal
}

// Pull the pack size / weight token off a raw product name for the stash `notes`
// field (e.g. "…Lyxlasagne 600 g" → "600 g"), else null.
function extractSizeNote(raw: string): string | null {
  const s = String(raw || '')
  const m = s.match(/\b\d+([.,]\d+)?\s*(kg|g|l|dl|cl|ml)\b/i)
    || s.match(/\b\d+\s*[xX]\s*\d+\s*\w*/)
    || s.match(/\b\d+\s*-?\s*p(?:ack)?\b/i)
  return m ? m[0].replace(/\s+/g, ' ').trim() : null
}

// Does a pasted message look like a Mathem grocery order confirmation? Used to
// route it DIRECTLY to the parser instead of relying on the model to decide to
// call the tool (which it was skipping — replying "Done" without writing).
function isGroceryOrderPaste(text: string): boolean {
  if (/beställda varor|orderbekräftelse|mathem|vara\s+antal\s+moms\s+pris/i.test(text)) return true
  // Fallback: several product lines ending in a "<number> kr" price.
  const krLines = text.split(/\r?\n/).filter(l => /\d[\d.,\s]*\s*kr\b/i.test(l)).length
  return krLines >= 3
}

// Best-effort food_category from a product name (else null). Swedish + English.
const FOOD_CATEGORY_RULES: Array<[RegExp, string]> = [
  [/\b(mjölk|milk|grädde|cream|ost|cheese|yoghurt|yogurt|kvarg|kvark|kefir|filmjölk|smör|butter|crème|creme)\b/i, 'dairy'],
  [/\b(ägg|eggs?)\b/i, 'eggs'],
  [/\b(fisk|lax|torsk|räk|räkor|shrimp|prawn|fish|salmon|tonfisk|tuna|skaldjur|seafood)\b/i, 'seafood'],
  [/\b(kött|nöt|fläsk|kyckling|chicken|beef|pork|korv|bacon|skinka|mince|färs|lamm|lamb|kalkon|turkey)\b/i, 'meat'],
  [/\b(banan|äpple|apple|tomat|sallad|lök|onion|potatis|potato|morot|carrot|frukt|grönsak|bär|berry|blåbär|hallon|jordgubb|gurka|paprika|citron|lime|apelsin|avokado|vitlök|ingefära|spenat|broccoli)\b/i, 'produce'],
]
function inferFoodCategory(name: string): string | null {
  for (const [re, cat] of FOOD_CATEGORY_RULES) if (re.test(name)) return cat
  return null
}
// Storage category (fridge|freezer|pantry) for a NEW row, inferred from name/food.
function inferStorageCategory(name: string, food: string | null): string {
  if (/\b(fryst|frozen|glass|djupfryst)\b/i.test(name)) return 'freezer'
  if (food === 'dairy' || food === 'eggs' || food === 'meat' || food === 'seafood' || food === 'produce') return 'fridge'
  return 'pantry'
}

// Inferred shelf life (days from delivery) by food_category — the grocery
// importer stamps expiry_date automatically so expiry-aware planning has
// coverage without manual date entry. Conservative defaults; pantry/unknown
// get none, and frozen storage never gets one. A manually set FUTURE date is
// never overwritten (only null or already-past dates are re-stamped on restock).
const SHELF_LIFE_DAYS: Record<string, number> = { meat: 3, seafood: 2, dairy: 10, produce: 7, eggs: 21 }

// Strip a verbose Mathem product name to its descriptor for a NEW inventory row:
// remove brand, size/weight/percent/pack tokens, and quality/marketing words;
// keep functional descriptors (Laktosfri, Fryst, flavours). e.g. "Arla® Mild
// Kvarg Vanilj Laktosfri Utan Tillsatt Socker 0,2% 450 g" → "Mild Kvarg Vanilj
// Laktosfri". Unicode-aware word boundaries so Swedish-initial words match.
const GROCERY_BRANDS = ['arla ko', 'arla', 'garant', 'valio', 'kronägg', 'kronfågel', 'dole', 'oatly', 'felix', 'santa maria', 'zeta', "ben's original", 'dr.oetker', 'dr oetker', 'eldorado', 'daily greens', 'semper', 'yoplait safari', 'yoplait', 'keso', 'friggs', 'star nutrition', 'biosalma', "patak's", 'pop bakery', 'masalamagic nirus', 'masalamagic', 'zeinas', 'itigo', 'blå band', 'dafgårds', 'axa', 'vanish', 'frukost', 'scan', 'guldfågeln']
const GROCERY_MKT = ['eko', 'krav', 'ekologisk', 'klass 1', 'klass1', 'fairtrade', 'utan tillsatt socker', 'med lång hållbarhet', 'lång hållbarhet', 'färdigsköljd', 'frigående', 'hållbar', 'ätmogen', 'svenska', 'svensk', 'hel', 'delikatess', 'original', 'boil-in-bag', "quick n' easy", 'quick n easy', 'klassisk']
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const BRAND_PREFIX_RE = new RegExp('^\\s*(?:' + GROCERY_BRANDS.map(reEsc).join('|') + ')(?=[^\\p{L}]|$)[.\\s]*', 'iu')
function cleanProductName(raw: string): string {
  let s = String(raw || '').replace(/[®™]/g, ' ')
  s = s.replace(BRAND_PREFIX_RE, '')
  s = s.replace(/\b\d+([.,]\d+)?\s*-\s*\d+([.,]\d+)?\s*%/g, ' ')     // 3,8-4,5%
  s = s.replace(/\b\d+([.,]\d+)?\s*%/g, ' ')                        // 0,2%  3%
  s = s.replace(/\b\d+\s*[xX]\s*\d+\s*\w*/g, ' ')                   // 4x125g
  s = s.replace(/\b\d+([.,]\d+)?\s*(kg|g|l|dl|cl|ml)\b/gi, ' ')     // 450 g, 1,5 L
  s = s.replace(/\b\d+\s*(pc\.?|pcs|st|stk)\b/gi, ' ')             // 20 pc.
  s = s.replace(/\b\d+\s*-?\s*p(ack)?\b/gi, ' ')                    // 4-p, 6-p
  s = s.replace(/\b\d+\s*M\b/g, ' ')                                // 12M (baby food age)
  for (const w of GROCERY_MKT) s = s.replace(new RegExp('(^|[^\\p{L}])' + reEsc(w) + '(?=[^\\p{L}]|$)', 'giu'), '$1 ')
  s = s.replace(/\s*\/\s*/g, ' ').replace(/\s{2,}/g, ' ').trim()
  s = s.replace(/^[\s,;:/–-]+|[\s,;:/–-]+$/g, '').trim()
  return s || String(raw || '').trim()
}

// Parse one line → { name, qty, vat } or null (header / notification / price /
// noise). vat is captured (not for pricing — it's the reliable non-food signal).
function parseOrderLine(rawLine: string): { name: string; qty: number; vat: number | null } | null {
  const line = rawLine.replace(/ /g, ' ').trim()   // normalise non-breaking spaces
  if (!line) return null
  if (/ändring i din beställning/i.test(line)) return null   // change-notification metadata
  const words = line.replace(/\t/g, ' ').split(/\s+/).filter(Boolean)
  if (words.length && words.every(w => HEADER_WORDS.has(w.toLowerCase()))) return null   // header row

  // Primary: tab-separated columns [name][qty][vat][price].
  const tabs = line.split('\t').map(s => s.trim()).filter(s => s.length)
  if (tabs.length >= 2) {
    const q = swedishNum(tabs[1])
    if (q != null && tabs[0]) {
      const v = tabs[2] ? parseInt(tabs[2], 10) : NaN
      return { name: tabs[0], qty: Math.round(q), vat: Number.isFinite(v) ? v : null }
    }
  }
  // Fallback (tabs lost in the paste): trailing "<qty> <vat>% <price> kr".
  const m = line.match(/^(.*?)[\s\t]+(-?\d+(?:[.,]\d+)?)[\s\t]+(\d{1,3})\s*%[\s\t]+[\d.,\s]+kr\.?$/i)
  if (m && m[1].trim()) {
    const q = swedishNum(m[2])
    if (q != null) return { name: m[1].trim(), qty: Math.round(q), vat: parseInt(m[3], 10) }
  }
  // Mathem EMAIL line: "<qty> stycken <name> Moms <vat>% <price> SEK". The
  // automated hand-off from Allie sends the email body, which — unlike a pasted
  // table — prefixes the quantity ("2 stycken …"), puts "Moms" before the VAT,
  // and prices in "SEK". The leading "<n> stycken" also excludes the VAT-summary
  // rows ("Moms 6% 69,90 SEK"), which have no quantity.
  const em = line.match(/^(-?\d+(?:[.,]\d+)?)\s+st(?:ycken|k|\.)?\s+(.+?)\s+moms\s+(\d{1,3})\s*%\s+[\d.,\s]+(?:sek|kr)\.?$/i)
  if (em && em[2].trim()) {
    const q = swedishNum(em[1])
    if (q != null) return { name: em[2].trim(), qty: Math.round(q), vat: parseInt(em[3], 10) }
  }
  return null   // price-summary / delivery-fee / unrecognised
}

type GroceryGroup = { name: string; norm: string; net: number; hasPositive: boolean; vat: number | null }

// Claude pass for items that missed the deterministic matcher. For each, either
// map it to an existing inventory row (same product, ignoring brand/size/pack),
// OR return a concise ENGLISH name for a new row (translated from Swedish, brand/
// size/marketing stripped, in the household's naming style). Ids are validated;
// on failure everything falls back to the deterministic clean name.
async function aiMatchGrocery(items: GroceryGroup[], invRows: Record<string, unknown>[]): Promise<Map<string, { id?: string; name?: string }>> {
  const out = new Map<string, { id?: string; name?: string }>()
  if (!items.length) return out
  const invForAI = invRows.map(r => ({ id: r.id, name: r.name, food_category: r.food_category, active: r.active !== false }))
  const prompt = `You process purchased grocery items (Swedish Mathem names) for a household whose inventory is kept in ENGLISH. For EACH purchased item do ONE of:
(a) If it is clearly the SAME product as an existing inventory row (same food; ignore brand, size, pack count, marketing words), return that row's id in "inventory_id" (and leave "name" null).
(b) Otherwise set "inventory_id": null and return "name": a concise ENGLISH name for a NEW row — translate from Swedish, strip brand/size/pack/marketing, keep the descriptor and functional words (lactose-free, frozen, flavour). Match the style of the existing English names (e.g. "Cashew butter", "Yoghurt - Strawberry & Raspberry", "Basmati rice", "Naan - Garlic", "Chicken Thigh Strips", "Pizza - 4 Cheese (frozen)").

PURCHASED ITEMS:
${JSON.stringify(items.map((g, i) => ({ i, name: g.name })))}

EXISTING INVENTORY (you MAY match an inactive row; ids are the only valid match outputs):
${JSON.stringify(invForAI)}

Rules:
- Match only when clearly the same product. A different flavour/variant/type → null + an English name.
- Never invent an id. Use only ids from the list above, or null.

Return ONLY JSON, no prose: {"items":[{"i":0,"inventory_id":"<uuid or null>","name":"<english name or null>"}]}`
  try {
    const resp = await ac.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 3000, messages: [{ role: 'user', content: prompt }] })
    const raw = ((resp.content[0] as Anthropic.TextBlock).text || '').trim()
    const jsonStr = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    const parsed = JSON.parse(jsonStr) as { items?: Array<{ i: number; inventory_id: string | null; name: string | null }> }
    const idSet = new Set(invRows.map(r => r.id as string))
    for (const m of (parsed.items || [])) {
      const g = items[m.i]
      if (!g) continue
      if (m.inventory_id && idSet.has(m.inventory_id)) out.set(g.norm, { id: m.inventory_id })
      else if (m.name && String(m.name).trim()) out.set(g.norm, { name: String(m.name).trim() })
    }
  } catch (_e) { /* AI unavailable → deterministic clean name fallback */ }
  return out
}

// Stable fingerprint of an order's net>0 items (sorted "norm:net"), for the
// duplicate-paste guard. djb2 hash → hex, plus item count.
function fingerprintOf(pairs: string[]): string {
  const s = pairs.slice().sort().join('|')
  let h = 5381
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) + s.charCodeAt(i)) >>> 0
  return h.toString(16) + '.' + pairs.length
}

// "20 minutes ago" / "2 hours ago" / "5 days ago" for guard/dedupe messages.
function agoText(iso: string): string {
  const mins = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 48) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`
  const days = Math.round(hrs / 24)
  return `${days} days ago`
}

// ── Processed-order ledger (order_id dedupe) ──────────────
// One retailer order generates multiple confirmation emails (orders get
// edited) and can arrive via TWO paths: an automated AbsurdAssistant ("Allie")
// hand-off, and a manual paste in the PWA. Both paths share ONE ledger —
// processed_orders, UNIQUE on order_id — so the same order can never be
// written to inventory twice. The claim is a plain INSERT: a unique violation
// (Postgres 23505) means "already processed", which is atomic and race-safe.
// Unlike grocery_import_batches (a per-paste log purged after 30 days), ledger
// rows are permanent.

function normalizeOrderId(raw: unknown): string | null {
  const s = String(raw ?? '').trim().replace(/^#/, '').toUpperCase()
  return s.length >= 4 ? s : null
}

// Pull the retailer order number out of pasted/emailed order text, so a MANUAL
// paste dedupes against the same ledger as Allie's hand-offs. Keyword-anchored
// (ordernummer / beställningsnummer / order no…) and digits-first (Mathem and
// ICA order numbers are numeric) to avoid matching arbitrary text.
function extractOrderId(text: string): string | null {
  const m = String(text || '').match(
    /(?:best[äa]llningsnummer|best[äa]llningsnr|order(?:nummer|nr|[-\s]*(?:number|no|id))?)\s*[.:#]*\s*(\d[\d-]{4,})/i
  )
  return m ? normalizeOrderId(m[1]) : null
}

function detectRetailer(text: string): string | null {
  if (/mathem/i.test(text)) return 'mathem'
  if (/\bica\b/i.test(text)) return 'ica'
  return null
}

// Chat reply when a pasted order's id is already in the ledger.
function duplicateReplyText(orderId: string, prior: { created_at?: string; source?: string; items_added?: number | null } | null): string {
  const when = prior?.created_at ? ` ${agoText(prior.created_at)}` : ''
  const via = prior?.source === 'absurdassistant' ? 'automatically via Allie' : 'from a paste here'
  const n = prior?.items_added != null ? ` (${prior.items_added} items)` : ''
  return `⚠️ Order ${orderId} was already processed${when} ${via}${n}. I did NOT add it again — that would double your stock. If something from it is genuinely missing, tell me what and I'll update inventory directly.`
}

// Learned freezer-meal corrections from the app, keyed EXACTLY as the frontend
// writes them: lower(trim(display name)). For an import-created freezer meal the
// display name is cleanProductName(raw), so the same key resolves here — that's
// how a "moved back to Inventory" store-bought item stops getting re-filed as a
// meal on the next order. Best-effort: an empty map just falls back to the
// heuristic.
const fzKey = (s: string) => String(s || '').toLowerCase().trim()
async function loadFreezerOverrides(db: DB): Promise<Map<string, boolean>> {
  try {
    const { data } = await db.from('freezer_meal_overrides').select('norm_name, is_meal')
    return new Map(((data || []) as Record<string, unknown>[]).map(o => [o.norm_name as string, o.is_meal as boolean] as [string, boolean]))
  } catch (_e) { return new Map() }
}

// Pure parse (Steps 1–3): lines → normalised groups → net quantity per product,
// classified. No DB, no writes — used both by the writer and the pre-write guard.
// `overrides` (learned meal/not-meal corrections) wins over the heuristic.
function parseGroceryOrder(rawText: string, overrides: Map<string, boolean> = new Map()) {
  const groups = new Map<string, GroceryGroup>()
  for (const rawLine of rawText.split(/\r?\n/)) {
    const p = parseOrderLine(rawLine)
    if (!p) continue
    const key = NORM(p.name)
    if (!key) continue
    const g = groups.get(key) || { name: p.name, norm: key, net: 0, hasPositive: false, vat: p.vat }
    g.net += p.qty
    if (p.qty > 0) { g.hasPositive = true; g.name = p.name }   // prefer an original (positive) line's display name
    if (p.vat != null) g.vat = p.vat
    groups.set(key, g)
  }
  const all = [...groups.values()]
  const isNF = (g: GroceryGroup) => isNonFood(g.name, g.vat)
  const food = all.filter(g => !isNF(g))
  // Non-food (cleaning, paper, toiletries…) is no longer rejected: net>0 groups
  // are imported into inventory as food_category='non_food' (their own tab in the
  // app), and feed grocery-list generation like everything else.
  const nonFood = all.filter(g => isNF(g) && g.net > 0)
  // Ready-to-heat meals (net > 0) go to freezer_stash, not inventory. A learned
  // override (from the app's Move to / Move back actions) beats the heuristic.
  const freezerMeals = food.filter(g => {
    if (g.net <= 0) return false
    const ov = overrides.get(fzKey(cleanProductName(g.name)))
    if (ov !== undefined) return ov
    return isFreezerMeal(g.name)
  })
  const isMeal = new Set(freezerMeals.map(g => g.norm))
  const toUpdate    = food.filter(g => g.net > 0 && !isMeal.has(g.norm))   // net > 0 → update / create
  const cancelled   = food.filter(g => g.net === 0)                   // net = 0 → skip, list to user
  const parseErrors = food.filter(g => g.net < 0 && g.hasPositive)    // reductions exceeded additions
  const corrections = food.filter(g => g.net < 0 && !g.hasPositive)   // negative-only → decrement existing
  // Fingerprint spans inventory writes AND freezer additions so the re-paste
  // guard catches a duplicate all-freezer order (stash inserts aren't idempotent).
  const fingerprint = fingerprintOf([...toUpdate, ...freezerMeals, ...nonFood].map(g => `${g.norm}:${g.net}`))
  return { food, toUpdate, freezerMeals, cancelled, parseErrors, corrections, nonFood, fingerprint }
}

async function toolImportGroceryOrder(input: Record<string, unknown>, db: DB, emit: (label: string) => void = () => {}) {
  const rawText = (input.raw_text as string) || ''
  if (!rawText.trim()) return { error: 'No order text provided to parse.' }

  emit('Reading your order confirmation…')
  emit('Parsing order lines…')

  const freezerOverrides = await loadFreezerOverrides(db)
  const { food, toUpdate, freezerMeals, cancelled, parseErrors, corrections, nonFood, fingerprint } = parseGroceryOrder(rawText, freezerOverrides)

  emit(`Found ${food.length} items. Net: ${toUpdate.length} to update, ${cancelled.length + parseErrors.length + corrections.length} cancelled or adjusted.`)

  // ── Step 4: load inventory (active + inactive) + master vocabulary. ──
  emit('Matching items to inventory…')
  const [{ data: inv }, { data: masters }] = await Promise.all([
    db.from('inventory').select('id, name, quantity, category, food_category, master_ingredient_id, typical_quantity, active, expiry_date'),
    db.from('master_ingredients').select('id, canonical_name, aliases').eq('active', true),
  ])
  const invRows = (inv || []) as Record<string, unknown>[]
  const invById = new Map(invRows.map(r => [r.id as string, r]))
  const masterByNorm = new Map<string, string>()
  for (const m of (masters || []) as Record<string, unknown>[]) {
    masterByNorm.set(NORM(m.canonical_name as string), m.id as string)
    for (const a of ((m.aliases as string[]) || [])) masterByNorm.set(NORM(a), m.id as string)
  }
  // Deterministic match: active (normalised name OR resolved master_id) → inactive.
  const detMatch = (g: GroceryGroup): { row: Record<string, unknown>; wasInactive: boolean } | null => {
    const masterId = masterByNorm.get(g.norm) || null
    const hit = (r: Record<string, unknown>) => NORM(r.name as string) === g.norm || (!!masterId && r.master_ingredient_id === masterId)
    const active = invRows.find(r => r.active !== false && hit(r))
    if (active) return { row: active, wasInactive: false }
    const inactive = invRows.find(r => r.active === false && hit(r))
    if (inactive) return { row: inactive, wasInactive: true }
    return null
  }

  // Resolve every net>0 item to an inventory row (or null = create new, with an
  // English display name). Items that miss the deterministic matcher get a Claude
  // pass that both matches AND translates a new-item name to English.
  type Resolved = { g: GroceryGroup; row: Record<string, unknown> | null; wasInactive: boolean; newName?: string }
  const resolved: Resolved[] = []
  const unresolved: GroceryGroup[] = []
  for (const g of toUpdate) {
    const m = detMatch(g)
    if (m) resolved.push({ g, row: m.row, wasInactive: m.wasInactive })
    else unresolved.push(g)
  }
  if (unresolved.length) {
    emit(`Matching ${unresolved.length} item${unresolved.length === 1 ? '' : 's'} with the Absurd Chef…`)
    const aiMap = await aiMatchGrocery(unresolved, invRows)
    for (const g of unresolved) {
      const hit = aiMap.get(g.norm)
      if (hit?.id) {
        const row = invById.get(hit.id) || null
        resolved.push({ g, row, wasInactive: !!row && row.active === false })
      } else {
        resolved.push({ g, row: null, wasInactive: false, newName: hit?.name })
      }
    }
  }

  const nowIso = new Date().toISOString()
  const todayDate = nowIso.slice(0, 10)
  const updatedNames: string[] = []
  const createdNames: string[] = []
  const freezerAdded: string[] = []
  const nonFoodAdded: string[] = []
  const flagged: string[] = []

  // ── Step 5: write net>0 items in batches of 10; progress between batches. ──
  const X = resolved.length
  let done = 0
  for (let b = 0; b < resolved.length; b += 10) {
    for (const { g, row, wasInactive, newName } of resolved.slice(b, b + 10)) {
      if (row) {
        const upd: Record<string, unknown> = {
          quantity: (Number(row.quantity) || 0) + g.net,   // delivered qty adds to current stock
          last_updated_at: nowIso,
        }
        if (wasInactive) upd.active = true                              // buying it → relevant again
        if (Number(row.typical_quantity) === 0) upd.status = 'some'     // atypical restock has stock again
        // Inferred shelf life on restock — only when no valid manual date exists.
        const rowFc = (row.food_category as string) || inferFoodCategory(g.name)
        const rowLife = rowFc ? SHELF_LIFE_DAYS[rowFc] : undefined
        if (rowLife && row.category !== 'freezer' && (!row.expiry_date || (row.expiry_date as string) < todayDate)) {
          upd.expiry_date = addDays(todayDate, rowLife)
        }
        const { error } = await db.from('inventory').update(upd).eq('id', row.id as string)
        if (error) flagged.push(`${g.name} — write failed (${error.message})`)
        else updatedNames.push(wasInactive ? `${row.name as string} (reactivated)` : (row.name as string))
      } else {
        const fc = inferFoodCategory(g.name)                 // category from the full raw name
        const storage = inferStorageCategory(g.name, fc)
        // Inferred shelf life for a NEW perishable row (never for freezer items).
        const life = fc ? SHELF_LIFE_DAYS[fc] : undefined
        // English name from the AI pass; deterministic Swedish-stripped fallback.
        const cleanName = (newName && newName.trim()) || cleanProductName(g.name)
        const { error } = await db.from('inventory').insert({
          name: cleanName, quantity: g.net, status: 'enough',
          food_category: fc, category: storage,
          source: 'grocery_import', active: true, last_updated_at: nowIso,
          ...(life && storage !== 'freezer' ? { expiry_date: addDays(todayDate, life) } : {}),
        })
        if (error) flagged.push(`${cleanName} — create failed (${error.message})`)
        else createdNames.push(cleanName)
      }
      done++
    }
    emit(`Updating stock — ${done} of ${X}…`)
  }

  // ── Negative-only groups: correction to existing stock (subtract |net|). ──
  for (const g of corrections) {
    const match = detMatch(g)
    if (!match) { flagged.push(`${g.name} — negative quantity with no matching original line`); continue }
    const r = match.row
    const cur = Number(r.quantity) || 0
    const dropped = Math.abs(g.net)
    let newQty = cur - dropped
    const floored = newQty < 0
    if (floored) newQty = 0
    const upd: Record<string, unknown> = { quantity: newQty, last_updated_at: nowIso }
    if (Number(r.typical_quantity) === 0 && newQty <= 0) { upd.status = 'out'; upd.active = false }
    else if (Number(r.typical_quantity) === 0) upd.status = 'some'
    await db.from('inventory').update(upd).eq('id', r.id as string)
    flagged.push(floored
      ? `${r.name as string} — reduced by ${dropped} (had ${cur}); floored to 0`
      : `${r.name as string} — reduced by ${dropped} (correction, no original line in this order)`)
  }
  for (const g of parseErrors) flagged.push(`${g.name} — net negative (${g.net}); reductions exceeded additions, not written`)

  // ── Ready-to-heat freezer meals → freezer_stash (store-bought, no recipe). ──
  if (freezerMeals.length) {
    emit(`Adding ${freezerMeals.length} ready-made meal${freezerMeals.length === 1 ? '' : 's'} to the freezer…`)
    for (const g of freezerMeals) {
      const dish = cleanProductName(g.name)
      const { error } = await db.from('freezer_stash').insert({
        recipe_name: dish, recipe_id: null,
        portions: g.net, source: 'store_bought', typically_restocked: false,
        frozen_date: todayDate, use_by_date: null,
        notes: extractSizeNote(g.name),
      })
      if (error) flagged.push(`${dish} — freezer add failed (${error.message})`)
      else freezerAdded.push(`${dish} (${g.net})`)
    }
  }

  // ── Non-food items → inventory as food_category='non_food'. Same net-quantity
  // treatment as food (match an existing row to add to it on reorder, else
  // create) but never expiring and never a freezer meal. Shown in the app's
  // Non-food tab and pulled into grocery-list generation. ──
  if (nonFood.length) {
    emit(`Logging ${nonFood.length} non-food item${nonFood.length === 1 ? '' : 's'}…`)
    for (const g of nonFood) {
      const m = detMatch(g)
      // Only merge into an existing NON-food row; a name collision with a food
      // item must not add non-food quantity onto that food row.
      if (m && m.row.food_category === 'non_food') {
        const upd: Record<string, unknown> = {
          quantity: (Number(m.row.quantity) || 0) + g.net,
          last_updated_at: nowIso,
        }
        if (m.wasInactive) upd.active = true
        if (Number(m.row.typical_quantity) === 0) upd.status = 'some'
        const { error } = await db.from('inventory').update(upd).eq('id', m.row.id as string)
        if (error) flagged.push(`${g.name} — non-food write failed (${error.message})`)
        else nonFoodAdded.push(m.wasInactive ? `${m.row.name as string} (reactivated)` : (m.row.name as string))
      } else {
        const cleanName = cleanProductName(g.name)
        const { error } = await db.from('inventory').insert({
          name: cleanName, quantity: g.net, typical_quantity: 1, status: 'enough',
          food_category: 'non_food', category: 'pantry', nonfood_group: nonFoodGroup(cleanName),
          source: 'grocery_import', active: true, last_updated_at: nowIso,
        })
        if (error) flagged.push(`${cleanName} — non-food create failed (${error.message})`)
        else nonFoodAdded.push(cleanName)
      }
    }
  }

  // Log the committed import so the 24h large-order re-paste guard can see it
  // (fingerprint = which order, count = size). Best-effort; never blocks writes.
  await db.from('grocery_import_batches').insert({
    status: 'committed', committed_at: nowIso,
    raw_text: rawText.slice(0, 20000),
    items: { fingerprint, count: toUpdate.length + freezerMeals.length + nonFood.length },
  }).then(() => {}, () => {})

  const parts: string[] = [`Done. Updated inventory for ${updatedNames.length} item${updatedNames.length === 1 ? '' : 's'}.`]
  if (createdNames.length)   parts.push(`${createdNames.length} new item${createdNames.length === 1 ? '' : 's'} added: ${createdNames.join(', ')}.`)
  if (freezerAdded.length)   parts.push(`Added ${freezerAdded.length} item${freezerAdded.length === 1 ? '' : 's'} to Freezer Meals: ${freezerAdded.join(', ')}. If anything landed in the wrong place, remove it from Freezer Meals or Pantry directly.`)
  if (cancelled.length)      parts.push(`${cancelled.length} fully cancelled and skipped: ${cancelled.map(g => g.name).join(', ')}.`)
  if (nonFoodAdded.length)   parts.push(`${nonFoodAdded.length} non-food item${nonFoodAdded.length === 1 ? '' : 's'} added to the Non-food list: ${nonFoodAdded.join(', ')}.`)
  if (flagged.length)        parts.push(`${flagged.length} flagged for review: ${flagged.join('; ')}.`)

  return {
    parsed_items: food.length,
    updated: updatedNames.length,
    created: createdNames,
    freezer_meals_added: freezerAdded,
    cancelled: cancelled.map(g => g.name),
    non_food_added: nonFoodAdded,
    flagged,
    summary: parts.join(' '),
    note: 'Inventory, freezer meals and non-food items have already been written directly (no confirmation step). Present the summary to the user as-is; do NOT regenerate the grocery list.',
  }
}

// Persist a cooking learning or correction onto an existing recipe. The model
// is instructed to OFFER first and call only after the user agrees. append_note
// is date-prefixed and appended to recipes.notes; replace_instructions swaps
// original_instructions wholesale; set covers protein/style/times.
async function toolUpdateRecipe(input: Record<string, unknown>, db: DB) {
  const { recipe_id, recipe_name, append_note, replace_instructions } = input as
    { recipe_id?: string; recipe_name?: string; append_note?: string; replace_instructions?: string }
  const setFields = (input.set || {}) as Record<string, unknown>

  // Resolve by id, else case-insensitive exact name match on active recipes.
  let recipe: Record<string, unknown> | null = null
  if (recipe_id) {
    const { data } = await db.from('recipes').select('id, name, notes').eq('id', recipe_id).maybeSingle()
    recipe = data
  } else if (recipe_name) {
    // Exact (case-insensitive) match first; fall back to a partial substring
    // match so a slightly-off name ("tikka" for "Chicken Tikka Masala") still
    // resolves instead of failing outright.
    const nm = String(recipe_name).trim()
    let { data } = await db.from('recipes').select('id, name, notes').ilike('name', nm).eq('active', true)
    if (!data || !data.length) {
      ;({ data } = await db.from('recipes').select('id, name, notes').ilike('name', `%${nm}%`).eq('active', true))
    }
    if (data && data.length === 1) recipe = data[0]
    else if (data && data.length > 1)
      return { error: `Multiple recipes match "${recipe_name}" (${data.map(r => r.name).join(', ')}) — pass recipe_id.` }
  }
  if (!recipe) return { error: 'Recipe not found — check the name or pass recipe_id.' }

  const upd: Record<string, unknown> = {}
  const changed: string[] = []
  if (append_note && String(append_note).trim()) {
    // recipes.notes is a text[] (one tip per element, shown as bullets in the
    // recipe detail view) — append a new element, never string-concatenate,
    // or Postgres rejects the write as a malformed array literal.
    const dated = `[${today()}] ${String(append_note).trim()}`
    const existing = Array.isArray(recipe.notes) ? recipe.notes as string[] : []
    upd.notes = [...existing, dated]
    changed.push('notes (appended)')
  }
  if (replace_instructions && String(replace_instructions).trim()) {
    upd.original_instructions = String(replace_instructions).trim()
    changed.push('original_instructions (replaced)')
  }
  for (const k of ['protein', 'style', 'prep_time_min', 'cook_time_min']) {
    if (setFields[k] !== undefined && setFields[k] !== null) { upd[k] = setFields[k]; changed.push(k) }
  }
  if (!changed.length) return { error: 'Nothing to update — provide append_note, replace_instructions, or set fields.' }

  const { error } = await db.from('recipes').update(upd).eq('id', recipe.id as string)
  if (error) return { success: false, error: error.message }
  return { success: true, recipe: recipe.name, changed }
}

// Log a prepped component (e.g. "cooked frozen onion, 10 cubes") conversationally.
async function toolAddPreppedComponent(input: Record<string, unknown>, db: DB) {
  const name = ((input.name as string) || '').trim()
  if (!name) return { error: 'name is required' }
  const batches = Number(input.batches) > 0 ? Math.round(Number(input.batches)) : 1
  const row = {
    name,
    batches_made: batches,
    batches_remaining: batches,
    storage_notes: (input.storage_notes as string) || null,
    recipe_id: (input.recipe_id as string) || null,
    made_date: today(),
    active: true,
  }
  const { data, error } = await db.from('prepped_components').insert(row).select('id').single()
  if (error) return { success: false, error: error.message }
  return { success: true, id: data?.id, ...row }
}

async function toolUpdatePlanSlot(input: Record<string, unknown>, db: DB, userMsg: string) {
  const { plan_date, meal_type, recipe_id, instruction_text } = input
  const cook_source = (input.cook_source as string) || 'home'
  // The reason (if any) is shown on the plan card; clear stale notes otherwise.
  const notes = (input.reason as string) || null

  const { data: existing } = await db.from('meal_plans')
    .select('recipe_id').eq('plan_date', plan_date).eq('meal_type', meal_type).single()
  const prevId = existing?.recipe_id || null

  const { error } = await db.from('meal_plans').upsert(
    { plan_date, meal_type, recipe_id, cook_source, slot_locked: true, notes },
    { onConflict: 'plan_date,meal_type' }
  )
  if (error) return { success: false, error: error.message }

  await db.from('plan_edits').insert({
    plan_date, meal_type,
    previous_recipe_id: prevId,
    new_recipe_id: recipe_id,
    edit_source: 'chat_instruction',
    instruction_text: ((instruction_text as string) || userMsg).slice(0, 500),
  })
  return { success: true, plan_date, meal_type, recipe_id, previous_recipe_id: prevId }
}

async function toolUpdateActualOutcome(input: Record<string, unknown>, db: DB) {
  const plan_date = input.plan_date as string
  const meal_type = (input.meal_type as string) || 'dinner'
  const madeAsPlanned = input.made_as_planned === true
  const actualRecipeId = (input.actual_recipe_id as string) || null
  const actualNotes    = (input.actual_notes as string) || null

  if (plan_date >= today()) return { success: false, error: 'Actual outcomes can only be logged for past dates.' }

  const { data: row } = await db.from('meal_plans')
    .select('recipe_id').eq('plan_date', plan_date).eq('meal_type', meal_type).maybeSingle()

  let update: Record<string, unknown>
  let recipeToMark: string | null = null
  if (madeAsPlanned) {
    // "Made as planned" needs something that WAS planned. Breakfast/snack are
    // never planned, so there's nothing to confirm — ask what was eaten instead.
    if (!row) return { success: false, error: `Nothing was planned for ${meal_type} on ${plan_date}, so there's nothing to confirm as made-as-planned. Pass actual_recipe_id or actual_notes for what was eaten.` }
    update = { actually_made: true, actual_recipe_id: null, actual_notes: null }
    recipeToMark = row.recipe_id || null
  } else if (actualRecipeId) {
    update = { actually_made: false, actual_recipe_id: actualRecipeId, actual_notes: null }
    recipeToMark = actualRecipeId
  } else if (actualNotes) {
    update = { actually_made: false, actual_recipe_id: null, actual_notes: actualNotes }
  } else {
    return { success: false, error: 'Provide made_as_planned, actual_recipe_id, or actual_notes.' }
  }

  // If a slot row exists (dinner/lunch usually), update it in place. If none
  // exists (the normal case for breakfast/snack, which the planner never writes),
  // create the row carrying just the actual outcome — recipe_id stays null since
  // nothing was ever planned. This is what makes historical breakfasts editable.
  const { error } = row
    ? await db.from('meal_plans').update(update)
        .eq('plan_date', plan_date).eq('meal_type', meal_type)
    : await db.from('meal_plans').upsert(
        { plan_date, meal_type, recipe_id: null, ...update },
        { onConflict: 'plan_date,meal_type' })
  if (error) return { success: false, error: error.message }

  // Keep recipe-level recency truthful: what was actually eaten counts for
  // no-repeat (search_recipes reads recipes.last_made).
  if (recipeToMark) {
    await db.from('recipes').update({ last_made: plan_date }).eq('id', recipeToMark)
  }

  return { success: true, plan_date, meal_type, ...update }
}

async function toolUseStashItem(input: Record<string, unknown>, db: DB) {
  const { stash_id, portions_used } = input as { stash_id: string; portions_used?: number }
  if (portions_used == null) {
    const { error } = await db.from('freezer_stash')
      .update({ used: true, used_date: today() }).eq('id', stash_id)
    return { success: !error, error: error?.message }
  }
  const { data: entry } = await db.from('freezer_stash').select('portions').eq('id', stash_id).single()
  const remaining = Math.max(0, (entry?.portions || 0) - portions_used)
  const upd: Record<string, unknown> = { portions: remaining }
  if (remaining === 0) { upd.used = true; upd.used_date = today() }
  const { error } = await db.from('freezer_stash').update(upd).eq('id', stash_id)
  return { success: !error, remaining, error: error?.message }
}

async function toolAddRecipe(input: Record<string, unknown>, db: DB) {
  type Ingredient = { name: string; quantity?: number; unit?: string; notes?: string }
  const {
    name, original_instructions, ingredients,
    meal_type, protein, style, cooking_method, serves_base,
  } = input as {
    name: string; original_instructions: string; ingredients: Ingredient[]
    meal_type?: string; protein?: string; style?: string; cooking_method?: string; serves_base?: number
  }

  // Only the four section values are valid; map anything else (incl. a natural
  // "dinner"/"dessert"/"kids" guess) so the recipe shows on the Recipes tab.
  const mt = String(meal_type || '').toLowerCase().trim()
  const normalizedMealType =
    mt === 'breakfast' ? 'breakfast'
    : mt === 'snack' ? 'snack'
    : (mt === 'special' || mt === 'dessert') ? 'special'
    : 'lunch_dinner'

  const recipeFields = {
    name, original_instructions, meal_type: normalizedMealType,
    protein: protein || null, style: style || null,
    cooking_method: cooking_method || null, serves_base: serves_base || 4, active: true,
  }

  // Dedup guard: look for an existing active, non-placeholder recipe by name.
  const trimmedName = (name || '').trim()
  const { data: existingRecipes } = await db.from('recipes')
    .select('id, name, original_instructions')
    .ilike('name', trimmedName)
    .eq('active', true)
    .or('is_placeholder.is.null,is_placeholder.eq.false')
    .limit(5)

  let recipeId: string
  let populatedExisting = false

  if (existingRecipes && existingRecipes.length) {
    // A real duplicate (has instructions) → reuse it, don't regenerate.
    const withContent = existingRecipes.find(r => (r.original_instructions || '').trim())
    if (withContent) {
      return { success: true, recipe_id: withContent.id, name: withContent.name, already_existed: true }
    }
    // No match has instructions. If the first match is an empty name-only stub
    // (no instructions AND no ingredients) — the case where a recipe was created
    // shell-first — fill it IN PLACE, keeping its id and any plan slots, instead
    // of silently no-op'ing as "already added" (which left it blank).
    const stub = existingRecipes[0]
    const { count: ingCount } = await db.from('recipe_ingredients')
      .select('id', { count: 'exact', head: true })
      .eq('recipe_id', stub.id)
    if (ingCount) {
      // Has ingredients but no instructions — unusual; treat as a real recipe.
      return { success: true, recipe_id: stub.id, name: stub.name, already_existed: true }
    }
    await db.from('recipes').update(recipeFields).eq('id', stub.id)
    recipeId = stub.id
    populatedExisting = true
  } else {
    const { data: newRec, error } = await db.from('recipes').insert(recipeFields).select('id').single()
    if (error || !newRec) return { success: false, error: error?.message }
    recipeId = newRec.id
  }

  await db.from('recipe_ingredients').insert(
    ingredients.map((ing, i) => ({
      recipe_id: recipeId, name: ing.name,
      quantity: ing.quantity ?? null, unit: ing.unit ?? null,
      notes: ing.notes ?? null, order_index: i + 1,
    }))
  )

  // Generate ADHD layers via recipe-agent (optional — recipe still saved if this fails)
  try {
    const res = await fetch(`${FUNCTIONS_URL}/recipe-agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'generate_adhd_layers', recipe_name: name, original_instructions, ingredients }),
    })
    const layers = await res.json()
    if (layers.night_before || layers.when_cooking) {
      await db.from('recipes').update({
        night_before: layers.night_before || null, morning_of: layers.morning_of || null,
        when_cooking: layers.when_cooking || null,
        // hacks_and_shortcuts retired → AI tips seed the global notes (new recipe).
        notes: (layers.hacks_and_shortcuts && layers.hacks_and_shortcuts.length) ? layers.hacks_and_shortcuts : null,
      }).eq('id', recipeId)
    }
  } catch (_) { /* layers optional */ }

  return { success: true, recipe_id: recipeId, name, populated_existing: populatedExisting }
}

async function toolLogPlanEdit(input: Record<string, unknown>, db: DB) {
  const { error } = await db.from('plan_edits').insert({
    plan_date: input.plan_date, meal_type: input.meal_type,
    previous_recipe_id: input.previous_recipe_id || null,
    new_recipe_id: input.new_recipe_id || null,
    edit_source: 'chat_instruction',
    instruction_text: input.instruction_text || null,
  })
  return { success: !error, error: error?.message }
}

async function toolTriggerReplan(input: Record<string, unknown>) {
  const { mode } = input as { mode: string; reason: string }
  const startDate = getMondayOf(today())
  try {
    const res = await fetch(`${FUNCTIONS_URL}/plan-generator`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, start_date: startDate }),
    })
    const data = await res.json()
    return { success: !!data.success, mode, start_date: startDate, unresolved: data.unresolved || [] }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

// ── Plan verification pass ────────────────────────────────

type ToolCall   = { name: string; input: Record<string, unknown> }
type ToolResult = { tool: string; result: unknown }

function isMultiDayPlanTurn(calls: ToolCall[]): boolean {
  if (calls.some(c => c.name === 'trigger_replan')) return true
  if (calls.filter(c => c.name === 'update_plan_slot').length >= 3) return true
  const planCall = calls.find(c => c.name === 'get_plan')
  return !!(planCall && Number(planCall.input.days ?? 0) >= 7)
}

function collectVerifiedFacts(results: ToolResult[]): Record<string, unknown> {
  const facts: Record<string, unknown> = {}
  for (const { tool, result } of results) {
    if (tool === 'get_plan')            facts.existing_plan = result
    if (tool === 'get_commute_days')    facts.commute_days = result
    if (tool === 'get_freezer_stash')   facts.freezer_stash = result
    if (tool === 'get_family_context')  facts.family_context = result
    if (tool === 'get_weekly_template') facts.weekly_template = result
    if (tool === 'search_recipes')      facts.recipe_search_results = result
  }
  return facts
}

async function runVerificationPass(
  draft: string,
  allToolCalls: unknown[],
  allToolResults: unknown[],
  userMsg: string,
  db: DB,
): Promise<string | null> {
  const facts = collectVerifiedFacts(allToolResults as ToolResult[])
  if (Object.keys(facts).length === 0) return null

  const verifyPrompt = `You are a plan consistency verifier. Return JSON only — no prose, no markdown fences.

VERIFIED REFERENCE DATA:
${JSON.stringify(facts)}

DRAFT REPLY TO VERIFY:
${draft}

Check each claim in the draft against the verified data above:
1. WEEKDAY_NAME — Is each date labeled with the correct day name? Use day_name fields in existing_plan. Convention: 0=Sun,1=Mon,2=Tue,3=Wed,4=Thu,5=Fri,6=Sat.
2. COMMUTE_DAY — Are commute days correctly identified per day_settings data?
3. STASH_REF — Does the draft reference a recipe from stash that is not present in freezer_stash?
4. ALLERGY — Does the draft suggest any fish or seafood (forbidden — hard allergy)?
5. RECENCY — Does the draft call a recipe "not used recently" when it appears in existing_plan within 7 days?

Return ONLY valid JSON (no other text):
{"mismatches":[{"type":"weekday_name|commute_day|stash_ref|allergy|recency","claim":"exact text from draft","fact":"what the data shows","date":"YYYY-MM-DD or null"}]}`

  type Mismatch = { type: string; claim: string; fact: string; date: string | null }
  let mismatches: Mismatch[] = []
  try {
    const vResp = await ac.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{ role: 'user', content: verifyPrompt }],
    })
    const raw = ((vResp.content[0] as Anthropic.TextBlock).text || '').trim()
    const jsonStr = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    mismatches = (JSON.parse(jsonStr) as { mismatches: Mismatch[] }).mismatches || []
  } catch (e) {
    console.error('[verify] parse error:', e)
    return null
  }

  if (mismatches.length === 0) return null
  console.log('[verify] mismatches:', JSON.stringify(mismatches))

  // Attempt correction with a second haiku call
  let correctedReply: string | null = null
  try {
    const correctPrompt = `You are AbsurdChef. Fix ONLY the identified mismatches in the draft below. Do not change anything else.

ORIGINAL DRAFT:
${draft}

MISMATCHES TO FIX:
${JSON.stringify(mismatches)}

VERIFIED FACTS:
${JSON.stringify(facts)}

Output the corrected reply text only. No preamble.`

    const cResp = await ac.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: buildSystem(),
      messages: [{ role: 'user', content: correctPrompt }],
    })
    correctedReply = ((cResp.content[0] as Anthropic.TextBlock).text || '').trim() || null
  } catch (e) {
    console.error('[verify] correction error:', e)
  }

  // Log results (fire and forget — table may not exist in dev)
  db.from('plan_verification_log').insert(
    mismatches.map(m => ({
      user_message:  userMsg.slice(0, 500),
      mismatch_type: m.type,
      claim:         m.claim,
      fact:          m.fact,
      plan_date:     m.date || null,
      corrected:     !!correctedReply,
    }))
  ).then(() => {})

  if (correctedReply) return correctedReply

  // Correction failed — append a review note rather than silently shipping bad data
  const types = [...new Set(mismatches.map(m => m.type))].join(', ')
  return draft + `\n\n_(Heads up: I spotted potential inconsistencies in this plan (${types}) — please double-check before committing.)_`
}

// ── Tool dispatcher ───────────────────────────────────────

async function dispatch(name: string, input: Record<string, unknown>, db: DB, userMsg: string, emit: (label: string) => void = () => {}): Promise<string> {
  try {
    let result: unknown
    switch (name) {
      case 'get_plan':               result = await toolGetPlan(input, db); break
      case 'get_today_recipe':       result = await toolGetTodayRecipe(db); break
      case 'search_recipes':         result = await toolSearchRecipes(input, db); break
      case 'get_inventory':          result = await toolGetInventory(input, db); break
      case 'get_freezer_stash':      result = await toolGetFreezerStash(db); break
      case 'get_expiry_recommendations': result = await toolGetExpiryRecommendations(input, db); break
      case 'get_prepped_components': result = await toolGetPreppedComponents(db); break
      case 'check_substitutes':      result = await toolCheckSubstitutes(input, db); break
      case 'get_family_context':     result = await toolGetFamilyContext(db); break
      case 'get_weekly_template':    result = await toolGetWeeklyTemplate(db); break
      case 'get_special_days':       result = await toolGetSpecialDays(input, db); break
      case 'get_commute_days':                   result = await toolGetCommuteDays(db); break
      case 'update_inventory_from_description':  result = await toolUpdateInventoryFromDescription(input, db); break
      case 'import_grocery_order':               result = await toolImportGroceryOrder(input, db, emit); break
      case 'update_plan_slot':                   result = await toolUpdatePlanSlot(input, db, userMsg); break
      case 'update_actual_outcome':              result = await toolUpdateActualOutcome(input, db); break
      case 'use_stash_item':         result = await toolUseStashItem(input, db); break
      case 'add_recipe':             result = await toolAddRecipe(input, db); break
      case 'update_recipe':          result = await toolUpdateRecipe(input, db); break
      case 'add_prepped_component':  result = await toolAddPreppedComponent(input, db); break
      case 'log_plan_edit':          result = await toolLogPlanEdit(input, db); break
      case 'trigger_replan':         result = await toolTriggerReplan(input); break
      default:                       result = { error: `Unknown tool: ${name}` }
    }
    return JSON.stringify(result)
  } catch (e) {
    return JSON.stringify({ error: String(e) })
  }
}

// ── Agent loop ────────────────────────────────────────────

// Human-readable progress label for a tool call (shown as the live status line).
function statusLabel(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'get_plan':               return 'Checking the plan…'
    case 'get_today_recipe':       return "Looking up today's recipe…"
    case 'search_recipes':         return 'Searching recipes…'
    case 'get_inventory':          return 'Checking your inventory…'
    case 'get_freezer_stash':      return 'Checking the freezer stash…'
    case 'get_expiry_recommendations': return 'Checking what needs using up…'
    case 'get_prepped_components': return 'Checking prepped components…'
    case 'check_substitutes':      return 'Finding substitutes…'
    case 'get_family_context':     return 'Checking family details…'
    case 'get_weekly_template':    return 'Reading the weekly template…'
    case 'get_special_days':       return 'Checking the calendar…'
    case 'get_commute_days':       return 'Checking commute days…'
    case 'update_inventory_from_description': return 'Updating your stock…'
    case 'import_grocery_order':   return 'Reading your order confirmation…'
    case 'update_plan_slot':       return 'Updating the plan…'
    case 'update_actual_outcome':  return 'Logging what you had…'
    case 'use_stash_item':         return 'Updating the freezer stash…'
    case 'add_recipe':             return `Adding ${(input?.name as string) || 'the recipe'}…`
    case 'update_recipe':          return 'Saving that to the recipe…'
    case 'add_prepped_component':  return 'Logging your prepped item…'
    case 'log_plan_edit':          return 'Saving the change…'
    case 'trigger_replan':         return 'Regenerating the plan…'
    default:                       return 'Working on it…'
  }
}

async function runLoop(
  userMessage: string,
  history: { role: 'user' | 'assistant'; content: string }[],
  db: DB,
  emit: (label: string) => void = () => {},
): Promise<{ reply: string; toolCalls: unknown[]; toolResults: unknown[] }> {
  const messages: Anthropic.MessageParam[] = [
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user' as const, content: userMessage },
  ]

  const allToolCalls: unknown[] = []
  const allToolResults: unknown[] = []

  for (let iter = 0; iter < 6; iter++) {
    const resp = await ac.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: buildSystem(),
      tools: TOOLS,
      messages,
    })

    const toolUseBlocks = resp.content.filter(b => b.type === 'tool_use') as Anthropic.ToolUseBlock[]
    const textBlocks    = resp.content.filter(b => b.type === 'text')    as Anthropic.TextBlock[]

    if (!toolUseBlocks.length || resp.stop_reason === 'end_turn' || resp.stop_reason === 'max_tokens') {
      const draftReply = textBlocks.map(b => b.text).join('').trim() || 'Done.'
      const finalReply = isMultiDayPlanTurn(allToolCalls as ToolCall[])
        ? (await runVerificationPass(draftReply, allToolCalls, allToolResults, userMessage, db)) ?? draftReply
        : draftReply
      return { reply: finalReply, toolCalls: allToolCalls, toolResults: allToolResults }
    }

    messages.push({ role: 'assistant', content: resp.content })
    allToolCalls.push(...toolUseBlocks.map(b => ({ name: b.name, input: b.input })))

    const toolResults: Anthropic.ToolResultBlockParam[] = []
    for (const block of toolUseBlocks) {
      // Grocery tools emit their own fine-grained progress (Reading → Parsing N →
      // Matching → Updating stock N of X); everything else gets one label here.
      const ownsProgress = block.name === 'import_grocery_order'
      if (!ownsProgress) emit(statusLabel(block.name, block.input as Record<string, unknown>))
      const raw = await dispatch(block.name, block.input as Record<string, unknown>, db, userMessage, emit)
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: raw })
      allToolResults.push({ tool: block.name, result: JSON.parse(raw) })
    }
    messages.push({ role: 'user', content: toolResults })
  }

  // Hit max iterations — surface last text found in assistant turns
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const txt = (m.content as Anthropic.ContentBlock[])
        .filter(b => b.type === 'text')
        .map(b => (b as Anthropic.TextBlock).text).join('')
      if (txt) {
        const finalReply = isMultiDayPlanTurn(allToolCalls as ToolCall[])
          ? (await runVerificationPass(txt, allToolCalls, allToolResults, userMessage, db)) ?? txt
          : txt
        return { reply: finalReply, toolCalls: allToolCalls, toolResults: allToolResults }
      }
    }
  }
  return {
    reply: 'Sorry, I ran into a problem with that. Please try rephrasing.',
    toolCalls: allToolCalls, toolResults: allToolResults,
  }
}

// Shared-secret auth for the automated hand-off path. Constant-time: both
// sides are SHA-256 hashed first (fixed length, so length differences can't
// short-circuit), then XOR-accumulated byte-by-byte — never === on the raw
// key. An unset ALLIE_HANDOFF_KEY fails CLOSED (every hand-off rejected).
// The key value itself is never logged.
async function allieKeyValid(header: string | null): Promise<boolean> {
  const secret = Deno.env.get('ALLIE_HANDOFF_KEY')
  if (!secret || !header) return false
  const enc = new TextEncoder()
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(header)),
    crypto.subtle.digest('SHA-256', enc.encode(secret)),
  ])
  const av = new Uint8Array(a), bv = new Uint8Array(b)
  let diff = 0
  for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i]
  return diff === 0
}

// ── Automated order hand-off (AbsurdAssistant / "Allie") ──
// Payload: { source: 'absurdassistant', order_id, retailer, email_body, delivered_at }
// Machine-to-machine: Allie mails the delivered order's confirmation email
// body here so inventory updates without a manual paste. Same parse + write
// pipeline as a paste (toolImportGroceryOrder), with three differences:
//   1. Dedupe is decided by the order_id ledger, not the interactive 24h
//      fingerprint guard — nobody is in the PWA to answer "confirm".
//   2. A clean parse auto-accepts; ambiguity/partial failure comes back as
//      needs_review so Allie asks Manasa in WhatsApp instead of guessing.
//   3. The response is one JSON object { status: added|duplicate|needs_review
//      |error, items_added, message } — never SSE, never a silent failure.
// A short synthetic exchange is written to chat_history so the PWA log shows
// the hand-off and the agent treats it as completed work.
async function handleAutomatedOrder(body: Record<string, unknown>, db: DB): Promise<Response> {
  const json = (obj: Record<string, unknown>) =>
    new Response(JSON.stringify(obj), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  try {
    const emailBody = String(body.email_body || '')
    if (!emailBody.trim()) {
      return json({ status: 'error', items_added: 0, message: 'No email_body in the hand-off — nothing to parse.' })
    }
    const orderId = normalizeOrderId(body.order_id) ?? extractOrderId(emailBody)
    if (!orderId) {
      return json({ status: 'needs_review', items_added: 0, message: 'No order_id in the hand-off and none found in the email — not processed (dedupe needs an order number). Paste the order in AbsurdChef instead.' })
    }
    const retailer = String(body.retailer || '').toLowerCase().trim() || detectRetailer(emailBody)
    const deliveredAt = /^\d{4}-\d{2}-\d{2}/.test(String(body.delivered_at || ''))
      ? String(body.delivered_at).slice(0, 10) : null

    // Parse preview BEFORE claiming the ledger: an email the parser can't read
    // at all must stay unclaimed, so a later manual paste isn't refused as a
    // duplicate of an order that never actually landed in inventory.
    const preview = parseGroceryOrder(emailBody, await loadFreezerOverrides(db))
    if (preview.toUpdate.length + preview.freezerMeals.length + preview.corrections.length === 0) {
      return json({ status: 'needs_review', items_added: 0, message: `Order ${orderId}: couldn't parse any product lines from the email — nothing written. Paste the order in AbsurdChef to review it.` })
    }

    // Atomic dedupe claim (unique order_id; 23505 = already processed).
    const claim = await db.from('processed_orders')
      .insert({ order_id: orderId, retailer, source: 'absurdassistant', status: 'processing', delivered_at: deliveredAt })
      .select('id').single()
    if (claim.error) {
      if ((claim.error as { code?: string }).code === '23505') {
        const { data: prior } = await db.from('processed_orders')
          .select('created_at, source, items_added').eq('order_id', orderId).maybeSingle()
        const p = prior as { created_at: string; source: string; items_added: number | null } | null
        const via = p?.source === 'absurdassistant' ? 'from an earlier hand-off' : 'from a manual paste in AbsurdChef'
        return json({ status: 'duplicate', items_added: 0, message: `Order ${orderId} was already processed${p ? ' ' + agoText(p.created_at) : ''} ${via} — ignored, nothing added twice.` })
      }
      // Ledger unavailable → refuse to write. Auto-adding without dedupe is
      // exactly the double-inventory risk this path must never take.
      return json({ status: 'error', items_added: 0, message: `Order ${orderId}: couldn't record it in the dedupe ledger (${claim.error.message}) — nothing written, a retry is safe.` })
    }
    const claimId = (claim.data as { id: string }).id

    try {
      const result = await toolImportGroceryOrder({ raw_text: emailBody }, db) as {
        error?: string; updated?: number; created?: string[]; freezer_meals_added?: string[]; flagged?: string[]; summary?: string
      }
      if (result.error) {
        // Nothing was written (the tool only errors before writing) — release
        // the claim so a manual paste or retry isn't blocked.
        await db.from('processed_orders').delete().eq('id', claimId)
        return json({ status: 'error', items_added: 0, message: `Order ${orderId}: ${result.error}` })
      }
      const itemsAdded = (result.updated || 0) + (result.created?.length || 0) + (result.freezer_meals_added?.length || 0)
      const flagged = result.flagged || []
      const status = flagged.length ? 'needs_review' : 'added'
      const message = flagged.length
        ? `Order ${orderId}: added ${itemsAdded} item${itemsAdded === 1 ? '' : 's'}, but ${flagged.length} need${flagged.length === 1 ? 's' : ''} review: ${flagged.join('; ').slice(0, 400)}`
        : `Order ${orderId}: added ${itemsAdded} item${itemsAdded === 1 ? '' : 's'} to AbsurdChef.`
      await db.from('processed_orders')
        .update({ status, items_added: itemsAdded, summary: (result.summary || '').slice(0, 2000) })
        .eq('id', claimId)

      // Mirror the hand-off into the PWA chat log — a short synthetic user
      // line (never the full email) plus the import summary as the reply.
      const nowMs = Date.now()
      await db.from('chat_history').insert([
        { role: 'user', content: `📦 [Allie] ${retailer ? retailer + ' ' : ''}order ${orderId} delivered — confirmation handed off automatically.`, created_at: new Date(nowMs).toISOString() },
        { role: 'assistant', content: result.summary || message, created_at: new Date(nowMs + 1).toISOString() },
      ]).then(() => {}, () => {})

      return json({ status, items_added: itemsAdded, message })
    } catch (e) {
      // Import threw MID-WRITE: some items may already be in inventory, so the
      // claim stays (marked error) — a blind retry would double those items.
      await db.from('processed_orders')
        .update({ status: 'error', summary: String(e).slice(0, 2000) }).eq('id', claimId)
        .then(() => {}, () => {})
      return json({ status: 'error', items_added: 0, message: `Order ${orderId}: import failed partway (${String(e)}). I kept it marked as processed so a retry can't double-add — check the Pantry tab in AbsurdChef and fix up manually.` })
    }
  } catch (err) {
    console.error('handleAutomatedOrder:', err)
    return json({ status: 'error', items_added: 0, message: `Hand-off failed: ${String(err)}` })
  }
}

// ── Handler ───────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

  try {
    const body = await req.json()

    // Automated grocery-order hand-off from AbsurdAssistant — plain JSON in,
    // plain JSON out; everything else is the normal PWA chat (SSE) below.
    // This branch (and only this branch) requires the X-Allie-Key shared
    // secret; a missing/wrong key is rejected before anything is parsed or
    // written. PWA chat traffic is not key-checked.
    if (body?.source === 'absurdassistant') {
      if (!(await allieKeyValid(req.headers.get('x-allie-key')))) {
        return new Response(
          JSON.stringify({ status: 'error', items_added: 0, message: 'Unauthorized — missing or invalid X-Allie-Key.' }),
          { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } }
        )
      }
      return await handleAutomatedOrder(body as Record<string, unknown>, createClient(SUPABASE_URL, SUPABASE_KEY))
    }

    const { message, tz_offset } = body
    // Client's Date.getTimezoneOffset() (minutes, UTC−local) so status timestamps
    // render in the user's local wall-clock time. Falls back to UTC.
    const tz = Number.isFinite(Number(tz_offset)) ? Number(tz_offset) : 0
    if (!message?.trim()) return new Response(
      JSON.stringify({ reply: 'No message received.' }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
    )

    const db = createClient(SUPABASE_URL, SUPABASE_KEY)

    // 30-day cleanup (fire and forget)
    const cutoff30 = new Date(Date.now() - 30 * 86_400_000).toISOString()
    db.from('chat_history').delete().lt('created_at', cutoff30).then(() => {})
    db.from('grocery_import_batches').delete().lt('created_at', cutoff30).then(() => {})

    // Load last 20 messages for context
    const { data: histRows } = await db.from('chat_history')
      .select('role, content')
      .in('role', ['user', 'assistant'])
      .order('created_at', { ascending: false })
      .limit(20)
    const history = (histRows || []).reverse() as { role: 'user' | 'assistant'; content: string }[]

    // Server-Sent Events: emit a status event before each step of work, then a
    // final `done` event carrying the full reply (the reply itself is NOT
    // token-streamed). The function runs to completion server-side regardless of
    // whether the client stays connected, so chat_history is always written.
    const enc = new TextEncoder()
    let lastLabel = 'Reading your message…'
    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj: Record<string, unknown>) => {
          try { controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`)) } catch (_e) { /* client gone */ }
        }
        send({ type: 'status', label: lastLabel, ts: fmtTs(tz) })
        try {
          const emit = (label: string) => { lastLabel = label; send({ type: 'status', label, ts: fmtTs(tz) }) }

          // A pasted Mathem order is handled DETERMINISTICALLY: the parser runs
          // directly on the verbatim paste (no model discretion — the model was
          // unreliably skipping the tool and replying "Done" without writing, and
          // a model-built raw_text arg could truncate the paste). Everything else
          // goes through the normal tool-calling agent loop.
          const userMsg = message.trim()
          let reply = ''
          let toolCalls: unknown[] = []
          let toolResults: unknown[] = []

          const runImport = async (rawText: string) => {
            // Claim the order id in the shared ledger BEFORE writing (see
            // "Processed-order ledger" above). If Allie already handed this
            // order off — or it was pasted before — the unique index rejects
            // the claim and we stop without touching inventory. A ledger
            // failure that ISN'T a duplicate never blocks a manual import.
            const oid = extractOrderId(rawText)
            let claimId: string | null = null
            if (oid) {
              const claim = await db.from('processed_orders')
                .insert({ order_id: oid, retailer: detectRetailer(rawText), source: 'manual_paste', status: 'processing' })
                .select('id').single()
              if (claim.error && (claim.error as { code?: string }).code === '23505') {
                const { data: prior } = await db.from('processed_orders')
                  .select('created_at, source, items_added').eq('order_id', oid).maybeSingle()
                reply = duplicateReplyText(oid, prior as { created_at?: string; source?: string; items_added?: number | null } | null)
                return
              }
              if (!claim.error) claimId = (claim.data as { id: string }).id
            }
            const result = await toolImportGroceryOrder({ raw_text: rawText }, db, emit)
            const r = result as { summary?: string; error?: string; updated?: number; created?: string[]; freezer_meals_added?: string[]; flagged?: string[] }
            reply = r.summary || r.error || 'Order processed.'
            toolCalls = [{ name: 'import_grocery_order', input: { raw_text: '[verbatim order text]' } }]
            toolResults = [{ tool: 'import_grocery_order', result }]
            if (claimId) {
              await db.from('processed_orders').update({
                status: r.error ? 'error' : (r.flagged?.length ? 'needs_review' : 'added'),
                items_added: (r.updated || 0) + (r.created?.length || 0) + (r.freezer_meals_added?.length || 0),
                summary: (r.summary || r.error || '').slice(0, 2000),
              }).eq('id', claimId)
            }
          }

          // A short affirmative right after a paused large order = the user
          // confirming it → process the stashed pending order.
          const affirmative = userMsg.length <= 40 &&
            /^(confirm|yes|yep|yeah|ja|ok|okay|go ahead|do it|proceed|process( it)?|add( it)?( anyway)?)\b/i.test(userMsg)
          const pending = affirmative
            ? (await db.from('grocery_import_batches')
                .select('id, raw_text').eq('status', 'pending')
                .gte('created_at', new Date(Date.now() - 30 * 60000).toISOString())
                .order('created_at', { ascending: false }).limit(1).maybeSingle()).data as { id: string; raw_text: string } | null
            : null

          if (pending?.raw_text) {
            await db.from('grocery_import_batches').update({ status: 'confirmed' }).eq('id', pending.id)
            await runImport(pending.raw_text)
          } else if (isGroceryOrderPaste(userMsg)) {
            // Order-id dedupe FIRST (shared ledger with Allie's automated
            // hand-offs): a paste whose order number is already in
            // processed_orders is refused outright, before the fingerprint
            // guard runs. runImport re-checks atomically at write time — this
            // early read just gives a fast, clear reply.
            const pastedId = extractOrderId(userMsg)
            const priorOrder = pastedId
              ? (await db.from('processed_orders').select('created_at, source, items_added')
                  .eq('order_id', pastedId).maybeSingle()).data as { created_at: string; source: string; items_added: number | null } | null
              : null
            if (priorOrder) {
              reply = duplicateReplyText(pastedId!, priorOrder)
            } else {
              const preview = parseGroceryOrder(userMsg, await loadFreezerOverrides(db))
              const foodCount = preview.toUpdate.length + preview.freezerMeals.length
              if (foodCount < 10) {
                await runImport(userMsg)                     // small order (<10) — free pass
              } else {
                // Large order → guard against an accidental re-paste / double-add.
                emit('Checking your recent orders…')
                const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
                const { data: recent } = await db.from('grocery_import_batches')
                  .select('created_at, items').eq('status', 'committed').gte('created_at', dayAgo)
                  .order('created_at', { ascending: false })
                const rec = (recent || []) as Array<{ created_at: string; items: { fingerprint?: string } | null }>
                const dup = rec.find(r => r.items && r.items.fingerprint === preview.fingerprint)
                if (dup || rec.length) {
                  // Pause: stash the pending order, ask the user to confirm.
                  await db.from('grocery_import_batches').update({ status: 'discarded' }).eq('status', 'pending')
                  await db.from('grocery_import_batches').insert({
                    status: 'pending', raw_text: userMsg.slice(0, 20000),
                    items: { fingerprint: preview.fingerprint, count: foodCount },
                  })
                  reply = dup
                    ? `⚠️ This looks like the same order you already processed ${agoText(dup.created_at)} — ${foodCount} items, identical contents. I did NOT add it again (that would double your stock). Reply "confirm" to process it anyway.`
                    : `⚠️ You processed a grocery order ${agoText(rec[0].created_at)}, and this is another large order (${foodCount} items). I paused before writing so you don't double up by accident. Reply "confirm" to process it — or ignore this if it was a re-paste.`
                } else {
                  await runImport(userMsg)                   // first large order in 24h — process
                }
              }
            }
          } else {
            const loop = await runLoop(userMsg, history, db, emit)
            reply = loop.reply; toolCalls = loop.toolCalls; toolResults = loop.toolResults
          }

          // Distinct timestamps so the user message sorts before its reply.
          const nowMs = Date.now()
          await db.from('chat_history').insert([
            { role: 'user', content: message.trim(), created_at: new Date(nowMs).toISOString() },
            { role: 'assistant', content: reply, tool_calls: toolCalls, tool_results: toolResults, created_at: new Date(nowMs + 1).toISOString() },
          ])

          send({ type: 'done', text: reply, ts: fmtTs(tz) })
        } catch (err) {
          console.error('chat-agent stream:', err)
          send({ type: 'error', label: lastLabel, ts: fmtTs(tz), message: 'Something went wrong while ' + lastLabel.replace(/…$/, '').toLowerCase() + '. Try again or check the relevant tab.' })
        } finally {
          controller.close()
        }
      },
    })

    return new Response(stream, {
      headers: { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
    })
  } catch (err) {
    console.error('chat-agent:', err)
    return new Response(
      JSON.stringify({ reply: 'Something went wrong — please try again.', _error: String(err) }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
    )
  }
})

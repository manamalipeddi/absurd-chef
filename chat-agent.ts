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
- GROCERY ORDER IMPORT: when the user pastes a block of grocery receipt / order-confirmation text (ICA, Mathem, etc.), call import_grocery_order with the verbatim text (and source if they named the store, else 'other'). This is a TWO-STEP, REVIEW-FIRST flow — it does NOT write anything yet. Present the returned review clearly: items to add (name · qty · category), restocks (show old → new quantity), anything flagged_for_review (unsure category or possible duplicate — call these out for a decision), and list the excluded_non_food items collapsed at the end ("Skipped N non-food items: …") so the user sees they were recognised, not missed. Then ask the user to confirm or edit. Only AFTER explicit confirmation, call commit_grocery_import — passing adjustments for any edits the user asked for (remove a row, change a category/quantity/name, force new-vs-restock), or no adjustments for a clean approve-all. You usually won't have the batch_id on the confirmation turn — that's fine, omit it and the latest pending import is used. Reference items by the idx shown in the review. Never call commit_grocery_import without that confirmation. If a restock carries a leftover_warning (a perishable that still had stock left), pass that nudge along to the user — once, plainly. After committing, report the summary (added / restocked / skipped) and relay any leftover_notices returned.
- WHY-NOTES: when you change a plan slot via update_plan_slot and there's a reason ("swap Thursday, Gintas is craving curry"), pass it as the reason argument — one short sentence. It's saved to the slot's notes and shown on the plan card, separate from the audit log. If the user gives no reason, omit it (the card then shows nothing for that slot).
- ACTUAL vs PLANNED: meal_plans records what was planned AND what was actually eaten. When the user says they made something different on a past day ("we ended up ordering pizza Monday", "I made tacos instead of the curry Tuesday"), call update_actual_outcome with that date — actual_recipe_id if it's a tracked recipe, else actual_notes for an untracked meal (takeout, leftovers). Use made_as_planned: true if they confirm they made the plan. get_plan returns actually_made / actual_recipe / actual_notes so you can report what really happened. The recipe actually eaten is what counts for no-repeat — never claim a planned recipe was eaten if actually_made is false.
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
    description: 'Search the recipe catalogue by protein, style, cooking method, template slot, or tags.',
    input_schema: {
      type: 'object' as const,
      properties: {
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
    description: "Parse a pasted grocery order confirmation / receipt (ICA, Mathem, or similar) into structured inventory candidates and stage them for review. Does NOT write to inventory — it returns a review list (items to add, items to restock, items flagged for a decision, and non-food items that were recognised and excluded). ALWAYS show this review to the user and get explicit confirmation or edits before calling commit_grocery_import. Use this whenever the user pastes a block of receipt/order text.",
    input_schema: {
      type: 'object' as const,
      properties: {
        raw_text: { type: 'string', description: 'The full pasted order-confirmation / receipt text, verbatim.' },
        source:   { type: 'string', description: "Store the order is from, if the user said: 'ica' | 'mathem' | 'other'. Default 'other'. Do NOT guess from the text shape — only use a store the user named." },
      },
      required: ['raw_text'],
    },
  },
  {
    name: 'commit_grocery_import',
    description: "Commit a previously staged grocery import to inventory (insert new items, increase quantity for restocks). Call ONLY after import_grocery_order and explicit user confirmation. Pass any edits the user asked for via adjustments — otherwise omit adjustments to commit the batch as reviewed. Non-food items are never written regardless.",
    input_schema: {
      type: 'object' as const,
      properties: {
        batch_id: { type: 'string', description: 'The batch_id from import_grocery_order if you still have it. Optional — if omitted, the latest pending import is committed (the usual case, since only one import is pending at a time).' },
        adjustments: {
          type: 'array',
          description: 'Per-item edits the user requested, keyed by the item idx shown in the review. Omit for a clean approve-all.',
          items: {
            type: 'object',
            properties: {
              idx:                { type: 'integer', description: 'The item idx from the review list.' },
              remove:             { type: 'boolean', description: "true to drop this item entirely (don't write it)." },
              category:           { type: 'string', description: 'Override category: fridge | freezer | pantry.' },
              quantity_purchased: { type: 'number', description: 'Override the quantity bought.' },
              name:               { type: 'string', description: 'Override the cleaned inventory name.' },
              treat_as:           { type: 'string', description: "Force handling: 'new' (add as a new row) or 'restock' (merge into the matched existing row)." },
              matched_inventory_id: { type: 'string', description: "When forcing treat_as 'restock', the existing inventory row id to merge into." },
            },
            required: ['idx'],
          },
        },
      },
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
    description: "Record what was ACTUALLY eaten on a PAST date (distinct from what was planned). Use when the user says they made something different, or confirms they made the plan. e.g. \"I made tacos instead of the curry on Tuesday\". Past dates only.",
    input_schema: {
      type: 'object' as const,
      properties: {
        plan_date:        { type: 'string', description: 'YYYY-MM-DD (must be in the past).' },
        meal_type:        { type: 'string', description: 'dinner|lunch. Default: dinner.' },
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

// ── Grocery order import (parse → review → commit) ────────

type GroceryItem = {
  idx: number
  name: string
  quantity_purchased: number | null
  package_size: string | null
  category: 'fridge' | 'freezer' | 'pantry'
  category_confident: boolean
  food_category: string                       // meat|seafood|produce|dairy|eggs|pantry|other
  is_food: boolean
  exclude_reason: string | null
  matched_inventory_id: string | null
  matched_inventory_name: string | null
  master_ingredient_id: string | null
  match_uncertain: boolean
  note: string | null
}

const FOOD_CATS = ['meat', 'seafood', 'produce', 'dairy', 'eggs', 'pantry', 'other']
const PERISHABLE = new Set(['meat', 'seafood', 'produce', 'dairy', 'eggs'])

function normaliseSource(s: unknown): string {
  const v = String(s || '').toLowerCase().trim()
  return v === 'ica' || v === 'mathem' ? v : 'other'
}

async function toolImportGroceryOrder(input: Record<string, unknown>, db: DB) {
  const rawText = (input.raw_text as string) || ''
  const source  = normaliseSource(input.source)
  if (!rawText.trim()) return { error: 'No order text provided to parse.' }

  const [{ data: inv }, { data: masters }] = await Promise.all([
    // Include INACTIVE rows too: a purchased item that matches a deactivated row
    // must reactivate it, never create a duplicate.
    db.from('inventory').select('id, name, category, food_category, quantity, unit, master_ingredient_id, active')
      .order('name'),
    db.from('master_ingredients').select('id, canonical_name, aliases')
      .eq('active', true).order('canonical_name'),
  ])
  const inventory = (inv || []) as Record<string, unknown>[]
  const masterList = (masters || []) as Record<string, unknown>[]
  const invById = new Map(inventory.map(i => [i.id as string, i]))
  const masterById = new Map(masterList.map(m => [m.id as string, m]))

  const parsePrompt = `You are a grocery receipt / order-confirmation parser for a household inventory app. Parse the pasted order text (from ${source}) into structured inventory candidates. Ignore all prices and money entirely — only items, counts, and package sizes matter.

NEVER OUTPUT (drop silently — they are not products): delivery/shipping fees, bag/box/cardboard charges, VAT/moms summary lines, discounts and promos ("2 för 30:-", "−10:-", "rabatt"), subtotals, totals, rounding, loyalty points, deposit/pant lines.

FOOD vs NON-FOOD (is_food):
- is_food=false for non-food PRODUCTS that should never reach a food inventory: diapers (Libero), dishwasher tablets/powder (Finish), cleaning products, sanitary/hygiene products, paper plates/napkins, foil/cling film, pet food, batteries, toiletries. Still LIST these (is_food=false + a short exclude_reason) so the user sees they were recognised and deliberately skipped — but they will not be written.
- Supplement-type items that are consumed as food (protein powder, etc.): is_food=true, category "pantry".
- Every cooking ingredient and fresh/pantry food: is_food=true.

For EACH item output these fields:
- name: cleaned, human-readable. Prefer "Category - Variant" when natural (e.g. raw "Eggs Free Range ECO M/L 1060g 20 pcs" → "Eggs - Free Range"; "ICA Havregryn 1,5kg" → "Oats - Rolled"). Strip brand/marketing/size noise from the NAME; the size goes in package_size.
- quantity_purchased: the Number/quantity column — how many units were bought — as a number (e.g. 2 from "2,00"). null if genuinely unclear.
- package_size: the per-package size string, separate from quantity_purchased (e.g. "1060g", "250 ml", "20 pcs"). null if none. NOTE "2 x 1060g" means quantity_purchased=2, package_size="1060g".
- category: best guess of WHERE it is stored — fridge | freezer | pantry. Frozen → freezer; fresh dairy/produce/meat/eggs → fridge; dry/canned/oils/spices/bread/shelf-stable → pantry. ALWAYS give a best guess even when unsure.
- category_confident: false when you are genuinely unsure which storage category fits.
- food_category: WHAT KIND of food it is (drives shelf-life), one of: meat | seafood | produce | dairy | eggs | pantry | other. meat=any animal flesh incl. sausages/mince; seafood=fish/shellfish; produce=fresh fruit/veg/herbs; dairy=milk/cheese/yoghurt/butter/cream (NOT plant milks → other); eggs=eggs; pantry=dry/canned/shelf-stable/oils/spices/bread/supplements; other=anything else (incl. plant milks, drinks). Always provide a value.
- is_food, exclude_reason (null unless is_food=false).
- matched_inventory_id: if this clearly RESTOCKS an existing inventory row (same item), that row's id; else null. If similar but you're not sure it's the same, leave null and set match_uncertain=true with a one-line note.
- master_ingredient_id: if the item confidently equals a master ingredient (by canonical_name or any alias), that id; else null.
- match_uncertain (boolean), note (short string or null).

EXISTING INVENTORY (match against ALL of these, including currently-inactive items — a purchase reactivates a matched inactive row): ${JSON.stringify(inventory.map(i => ({ id: i.id, name: i.name, category: i.category })))}
MASTER INGREDIENTS: ${JSON.stringify(masterList.map(m => ({ id: m.id, canonical_name: m.canonical_name, aliases: m.aliases })))}

ORDER TEXT:
"""
${rawText}
"""

Return ONLY valid JSON, no prose, no markdown fences:
{"items":[{"name":"","quantity_purchased":null,"package_size":null,"category":"pantry","category_confident":true,"food_category":"other","is_food":true,"exclude_reason":null,"matched_inventory_id":null,"master_ingredient_id":null,"match_uncertain":false,"note":null}]}`

  let parsed: Partial<GroceryItem>[] = []
  try {
    const resp = await ac.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 6000,
      messages: [{ role: 'user', content: parsePrompt }],
    })
    const raw = ((resp.content[0] as Anthropic.TextBlock).text || '').trim()
    const jsonStr = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    parsed = (JSON.parse(jsonStr) as { items: Partial<GroceryItem>[] }).items || []
  } catch (e) {
    return { error: `Couldn't parse that order text: ${String(e)}` }
  }

  // Normalise + validate matches server-side (never trust a hallucinated id).
  const cat = (c: unknown) => (c === 'fridge' || c === 'freezer' || c === 'pantry') ? c : 'pantry'
  const items: GroceryItem[] = parsed.map((p, idx) => {
    const matchedId = p.matched_inventory_id && invById.has(p.matched_inventory_id) ? p.matched_inventory_id : null
    const masterId  = p.master_ingredient_id && masterById.has(p.master_ingredient_id) ? p.master_ingredient_id : null
    return {
      idx,
      name: (p.name || '').trim() || 'Unknown item',
      quantity_purchased: typeof p.quantity_purchased === 'number' ? p.quantity_purchased : null,
      package_size: p.package_size ? String(p.package_size) : null,
      category: cat(p.category),
      category_confident: p.category_confident !== false,
      food_category: FOOD_CATS.includes(p.food_category as string) ? (p.food_category as string) : 'other',
      is_food: p.is_food !== false,
      exclude_reason: p.is_food === false ? (p.exclude_reason || 'non-food item') : null,
      matched_inventory_id: matchedId,
      matched_inventory_name: matchedId ? (invById.get(matchedId)!.name as string) : null,
      master_ingredient_id: masterId,
      match_uncertain: !!p.match_uncertain,
      note: p.note || null,
    }
  })

  // Only one pending batch at a time — supersede any earlier un-committed paste so
  // "the latest pending import" is always unambiguous on the commit turn (the
  // chat loop reloads only role+content, so the batch_id isn't in later context).
  await db.from('grocery_import_batches').update({ status: 'discarded' }).eq('status', 'pending')

  const { data: batch, error } = await db.from('grocery_import_batches')
    .insert({ source, items, raw_text: rawText.slice(0, 20000), status: 'pending' })
    .select('id').single()
  if (error || !batch) return { error: `Couldn't stage the import: ${error?.message}` }

  // Build the review view. Food items keep a best-guess default action so an
  // "approve all" works; flagged ones are surfaced for a decision too.
  const food = items.filter(i => i.is_food)
  const toRestock = food.filter(i => i.matched_inventory_id).map(i => {
    const existing = invById.get(i.matched_inventory_id!)!
    const cur = Number(existing.quantity) || 0
    const add = i.quantity_purchased ?? 1
    // Leftover nudge: restocking a perishable that still had stock left. The
    // existing row's food_category determines perishability + the fresh-date refresh.
    const perishable = PERISHABLE.has((existing.food_category as string) || '')
    const leftover_warning = (perishable && cur > 0)
      ? `You still had ${cur} left before this restock — use the older stock first.`
      : null
    return {
      idx: i.idx, name: i.name, restocks: i.matched_inventory_name,
      current_quantity: cur, add_quantity: add, projected_quantity: cur + add,
      package_size: i.package_size, category: i.category,
      leftover_warning,
      flagged: i.match_uncertain, flag_reason: i.match_uncertain ? (i.note || 'not sure this is the same item') : null,
    }
  })
  const toAdd = food.filter(i => !i.matched_inventory_id).map(i => ({
    idx: i.idx, name: i.name, quantity_purchased: i.quantity_purchased ?? 1,
    package_size: i.package_size, category: i.category,
    linked_master: i.master_ingredient_id ? (masterById.get(i.master_ingredient_id)!.canonical_name as string) : null,
    flagged: !i.category_confident || i.match_uncertain,
    flag_reason: !i.category_confident ? 'unsure which category' : (i.match_uncertain ? (i.note || 'possible duplicate of an existing item') : null),
  }))
  const excluded = items.filter(i => !i.is_food).map(i => ({ name: i.name, reason: i.exclude_reason }))

  return {
    batch_id: batch.id,
    source,
    summary: {
      to_add: toAdd.length, to_restock: toRestock.length,
      flagged_for_review: [...toAdd, ...toRestock].filter(x => x.flagged).length,
      excluded_non_food: excluded.length,
    },
    to_add: toAdd,
    to_restock: toRestock,
    excluded_non_food: excluded,
    next_step: 'Show this as a review list (new items, restocks with old→new quantity, anything flagged for a decision, and the excluded non-food items collapsed for transparency). If any restock has a leftover_warning, surface that one-liner to the user (they still had perishable stock left before this restock — use older stock first). Do NOT write anything yet. After the user confirms or asks for edits, call commit_grocery_import with this batch_id (and adjustments for any edits).',
  }
}

async function toolCommitGroceryImport(input: Record<string, unknown>, db: DB) {
  const batchId = (input.batch_id as string) || null

  // Resolve the batch: by id when known, else fall back to the single pending
  // batch (the loop drops tool results between turns, so batch_id is often gone).
  let batch: { id: string; status: string; items: unknown } | null = null
  if (batchId) {
    const { data } = await db.from('grocery_import_batches')
      .select('id, status, items').eq('id', batchId).single()
    batch = data as typeof batch
  }
  if (!batch || batch.status !== 'pending') {
    const { data } = await db.from('grocery_import_batches')
      .select('id, status, items').eq('status', 'pending')
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    batch = (data as typeof batch) || batch
  }
  if (!batch) return { error: 'No grocery import to commit — paste the order first.' }
  if (batch.status !== 'pending') return { error: `That import was already ${batch.status}. Re-paste the order to import again.` }

  type Adj = {
    idx: number; remove?: boolean; category?: string
    quantity_purchased?: number; name?: string
    treat_as?: 'new' | 'restock'; matched_inventory_id?: string
  }
  const adjustments = (Array.isArray(input.adjustments) ? input.adjustments : []) as Adj[]
  const adjByIdx = new Map(adjustments.map(a => [a.idx, a]))

  const items = (batch.items as GroceryItem[]).map(i => ({ ...i }))

  // Refetch current quantities for any restock targets (avoid stale staged values).
  const restockIds = [...new Set(items
    .map(i => adjByIdx.get(i.idx)?.matched_inventory_id ?? i.matched_inventory_id)
    .filter(Boolean) as string[])]
  // No active filter — an inactive matched row must be found (and reactivated),
  // not skipped (which would insert a duplicate).
  const curQty = new Map<string, { quantity: number; unit: string | null; name: string; food_category: string; active: boolean; typical: number | null }>()
  if (restockIds.length) {
    const { data: rows } = await db.from('inventory')
      .select('id, quantity, unit, name, food_category, active, typical_quantity').in('id', restockIds)
    for (const r of (rows || []) as Record<string, unknown>[])
      curQty.set(r.id as string, { quantity: Number(r.quantity) || 0, unit: (r.unit as string) || null, name: r.name as string, food_category: (r.food_category as string) || 'other', active: r.active !== false, typical: r.typical_quantity == null ? null : Number(r.typical_quantity) })
  }

  const added: { name: string; quantity: number; category: string }[] = []
  const restocked: { name: string; from: number; to: number }[] = []
  const reactivated: string[] = []   // inactive rows brought back by a purchase
  const skipped: { name: string; reason: string }[] = []
  const removed: string[] = []
  const leftover_notices: string[] = []

  for (const item of items) {
    const adj = adjByIdx.get(item.idx)
    if (adj?.remove) { removed.push(item.name); continue }
    if (!item.is_food) continue   // non-food is never written, ever

    const name = (adj?.name || item.name).trim()
    const category = (adj?.category === 'fridge' || adj?.category === 'freezer' || adj?.category === 'pantry')
      ? adj.category : item.category
    const qty = typeof adj?.quantity_purchased === 'number' ? adj.quantity_purchased : (item.quantity_purchased ?? 1)

    // Decide restock vs new (user override wins).
    let matchedId = item.matched_inventory_id
    if (adj?.treat_as === 'new') matchedId = null
    if (adj?.treat_as === 'restock') matchedId = adj.matched_inventory_id || item.matched_inventory_id || null

    if (matchedId && curQty.has(matchedId)) {
      const cur = curQty.get(matchedId)!
      const to = cur.quantity + qty
      // Leftover nudge: perishable still had stock when fresh stock arrives.
      // (The trigger refreshes expiry_date to a fresh count on the increase.)
      if (PERISHABLE.has(cur.food_category) && cur.quantity > 0) {
        leftover_notices.push(`${cur.name}: you still had ${cur.quantity} before this restock — use the older stock first.`)
      }
      const upd: Record<string, unknown> = { quantity: to }
      if (!cur.unit && item.package_size) upd.unit = item.package_size
      // Buying it is an unambiguous signal it's relevant again → reactivate.
      if (!cur.active) upd.active = true
      // Atypical item (typical = 0) restocked → it has stock again, mark 'some'.
      if (cur.typical === 0 && to > 0) upd.status = 'some'
      const { error } = await db.from('inventory').update(upd).eq('id', matchedId)
      if (error) { skipped.push({ name, reason: error.message }); continue }
      if (!cur.active) { cur.active = true; reactivated.push(cur.name) }
      restocked.push({ name: cur.name, from: cur.quantity, to })
      cur.quantity = to   // in case two lines restock the same row
    } else {
      // New item — triggers auto-link master + set last_updated_at/default expiry.
      const { error } = await db.from('inventory').insert({
        name, quantity: qty, unit: item.package_size || null,
        category, food_category: item.food_category || 'other',
        source: 'grocery_import', active: true,
      })
      if (error) { skipped.push({ name, reason: error.message }); continue }
      added.push({ name, quantity: qty, category })
    }
  }

  await db.from('grocery_import_batches')
    .update({ status: 'committed', committed_at: new Date().toISOString() })
    .eq('id', batch.id)

  return {
    success: true,
    added, restocked, reactivated, skipped, removed, leftover_notices,
    summary: `${added.length} added, ${restocked.length} restocked${reactivated.length ? `, ${reactivated.length} reactivated` : ''}${removed.length ? `, ${removed.length} removed` : ''}${skipped.length ? `, ${skipped.length} skipped` : ''}.`,
    note: leftover_notices.length ? 'Relay each leftover_notice to the user as a brief heads-up about using older perishable stock first.' : undefined,
  }
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
    .select('recipe_id').eq('plan_date', plan_date).eq('meal_type', meal_type).single()
  if (!row) return { success: false, error: `No ${meal_type} planned on ${plan_date} to confirm.` }

  let update: Record<string, unknown>
  let recipeToMark: string | null = null
  if (madeAsPlanned) {
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

  const { error } = await db.from('meal_plans').update(update)
    .eq('plan_date', plan_date).eq('meal_type', meal_type)
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

async function dispatch(name: string, input: Record<string, unknown>, db: DB, userMsg: string): Promise<string> {
  try {
    let result: unknown
    switch (name) {
      case 'get_plan':               result = await toolGetPlan(input, db); break
      case 'get_today_recipe':       result = await toolGetTodayRecipe(db); break
      case 'search_recipes':         result = await toolSearchRecipes(input, db); break
      case 'get_inventory':          result = await toolGetInventory(input, db); break
      case 'get_freezer_stash':      result = await toolGetFreezerStash(db); break
      case 'get_prepped_components': result = await toolGetPreppedComponents(db); break
      case 'check_substitutes':      result = await toolCheckSubstitutes(input, db); break
      case 'get_family_context':     result = await toolGetFamilyContext(db); break
      case 'get_weekly_template':    result = await toolGetWeeklyTemplate(db); break
      case 'get_special_days':       result = await toolGetSpecialDays(input, db); break
      case 'get_commute_days':                   result = await toolGetCommuteDays(db); break
      case 'update_inventory_from_description':  result = await toolUpdateInventoryFromDescription(input, db); break
      case 'import_grocery_order':               result = await toolImportGroceryOrder(input, db); break
      case 'commit_grocery_import':              result = await toolCommitGroceryImport(input, db); break
      case 'update_plan_slot':                   result = await toolUpdatePlanSlot(input, db, userMsg); break
      case 'update_actual_outcome':              result = await toolUpdateActualOutcome(input, db); break
      case 'use_stash_item':         result = await toolUseStashItem(input, db); break
      case 'add_recipe':             result = await toolAddRecipe(input, db); break
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
    case 'get_prepped_components': return 'Checking prepped components…'
    case 'check_substitutes':      return 'Finding substitutes…'
    case 'get_family_context':     return 'Checking family details…'
    case 'get_weekly_template':    return 'Reading the weekly template…'
    case 'get_special_days':       return 'Checking the calendar…'
    case 'get_commute_days':       return 'Checking commute days…'
    case 'update_inventory_from_description': return 'Updating your stock…'
    case 'import_grocery_order':   return 'Parsing order confirmation…'
    case 'commit_grocery_import':  return 'Updating stock levels…'
    case 'update_plan_slot':       return 'Updating the plan…'
    case 'update_actual_outcome':  return 'Logging what you had…'
    case 'use_stash_item':         return 'Updating the freezer stash…'
    case 'add_recipe':             return `Adding ${(input?.name as string) || 'the recipe'}…`
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
      emit(statusLabel(block.name, block.input as Record<string, unknown>))
      const raw = await dispatch(block.name, block.input as Record<string, unknown>, db, userMessage)
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

// ── Handler ───────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

  try {
    const { message } = await req.json()
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
        send({ type: 'status', label: lastLabel })
        try {
          const emit = (label: string) => { lastLabel = label; send({ type: 'status', label }) }
          const { reply, toolCalls, toolResults } = await runLoop(message.trim(), history, db, emit)

          // Distinct timestamps so the user message sorts before its reply.
          const nowMs = Date.now()
          await db.from('chat_history').insert([
            { role: 'user', content: message.trim(), created_at: new Date(nowMs).toISOString() },
            { role: 'assistant', content: reply, tool_calls: toolCalls, tool_results: toolResults, created_at: new Date(nowMs + 1).toISOString() },
          ])

          send({ type: 'done', text: reply })
        } catch (err) {
          console.error('chat-agent stream:', err)
          send({ type: 'error', label: lastLabel, message: 'Something went wrong while ' + lastLabel.replace(/…$/, '').toLowerCase() + '. Try again or check the relevant tab.' })
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

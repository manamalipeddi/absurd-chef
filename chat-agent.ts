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
- GROCERY ORDER IMPORT: when the user pastes a Mathem grocery order confirmation, call import_grocery_order once with the verbatim text. This is a SINGLE-PASS, NO-CONFIRMATION tool — it parses AND writes inventory immediately (net quantity per item, incl. adjustment/negative lines). Do NOT ask the user to confirm first, and do NOT call it a second time for the same paste. When it returns, relay its "summary" field to the user as-is (items updated, any fully-cancelled items, any new rows created, anything flagged for review). Do NOT regenerate the grocery list afterwards — that only happens on the Sunday cron or the manual Regenerate button.
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
    description: "Parse a pasted Mathem grocery order confirmation AND write inventory in one shot. This is a single-pass, no-confirmation tool: it discards headers / change-notification / price lines, computes the NET quantity per product (summing adjustment lines incl. negatives), then updates or creates inventory rows directly. It streams progress and returns a plain-English summary — present that summary to the user as-is. Do NOT ask for confirmation before calling it, do NOT call it twice for the same paste, and do NOT regenerate the grocery list afterwards. Use it whenever the user pastes a block of Mathem order text.",
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

// ── Grocery order import (Mathem) — deterministic single-pass parse + write ──
// Parses a pasted Mathem order confirmation, computes NET quantity per product
// (summing adjustment lines, including negatives), and writes inventory DIRECTLY
// — there is no confirmation step (the pre-write summary is informational only).
// Steps mirror the grocery spec: discard headers / "Ändring i din beställning" /
// price lines; Swedish decimals; net>0 update-or-create, net=0 cancelled,
// net<0 parse-error or (negative-only) correction to existing stock. Non-food
// PRODUCTS (diapers, cleaning, hygiene…) are recognised and skipped, not written.
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

// Non-food PRODUCTS that must never land in a food inventory. Focused, low
// false-positive list (Swedish + English); ambiguous words are deliberately out.
const NON_FOOD_RE = /\b(blöj\w*|diaper\w*|libero|hushållspapper|toapapper|toalettpapper|toilet\s*paper|servett\w*|napkin\w*|aluminiumfolie|plastfilm|gladpack|cling\s*film|diskmedel|disktablett\w*|disktabs|maskindisk\w*|dishwash\w*|tvättmedel|sköljmedel|detergent|rengöring\w*|allrengöring|tvål|soap|schampo|shampoo|balsam|conditioner|tandkräm|toothpaste|deodorant|bindor|tampong\w*|batteri\w*|glödlampa|djurfoder|kattmat|hundmat)\b/i
function isNonFood(name: string): boolean { return NON_FOOD_RE.test(name) }

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

// Parse one line → { name, qty } or null (header / notification / price / noise).
function parseOrderLine(rawLine: string): { name: string; qty: number } | null {
  const line = rawLine.replace(/ /g, ' ').trim()   // normalise non-breaking spaces
  if (!line) return null
  if (/ändring i din beställning/i.test(line)) return null   // change-notification metadata
  const words = line.replace(/\t/g, ' ').split(/\s+/).filter(Boolean)
  if (words.length && words.every(w => HEADER_WORDS.has(w.toLowerCase()))) return null   // header row

  // Primary: tab-separated columns [name][qty][vat][price].
  const tabs = line.split('\t').map(s => s.trim()).filter(s => s.length)
  if (tabs.length >= 2) {
    const q = swedishNum(tabs[1])
    if (q != null && tabs[0]) return { name: tabs[0], qty: Math.round(q) }
  }
  // Fallback (tabs lost in the paste): trailing "<qty> <vat>% <price> kr".
  const m = line.match(/^(.*?)[\s\t]+(-?\d+(?:[.,]\d+)?)[\s\t]+\d{1,3}\s*%[\s\t]+[\d.,\s]+kr\.?$/i)
  if (m && m[1].trim()) {
    const q = swedishNum(m[2])
    if (q != null) return { name: m[1].trim(), qty: Math.round(q) }
  }
  return null   // price-summary / delivery-fee / unrecognised
}

type GroceryGroup = { name: string; norm: string; net: number; hasPositive: boolean }

// Claude pass: map purchased items that missed the deterministic matcher onto an
// existing inventory row (same product, ignoring brand/size/pack wording), else
// null → create new. Ids are validated against the real set; failure → all new.
async function aiMatchGrocery(items: GroceryGroup[], invRows: Record<string, unknown>[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!items.length || !invRows.length) return out
  const invForAI = invRows.map(r => ({ id: r.id, name: r.name, food_category: r.food_category, active: r.active !== false }))
  const prompt = `You match purchased grocery items to a household's existing inventory rows. For each PURCHASED item, decide whether it is the SAME product as an existing inventory row (same food; ignore brand, size, pack count, and marketing words). Return that row's id, or null if none is clearly the same (it will be created as a new row).

PURCHASED ITEMS:
${JSON.stringify(items.map((g, i) => ({ i, name: g.name })))}

EXISTING INVENTORY (you MAY match an inactive row; ids are the only valid outputs):
${JSON.stringify(invForAI)}

Rules:
- Match only when clearly the same product, e.g. "Arla Mild Kvarg Vanilj 0,2% 450 g" → an existing "Kvarg - Vanilla". A different flavour/variant/type → null.
- Never invent an id. Use only ids from the list above, or null.

Return ONLY JSON, no prose: {"matches":[{"i":0,"inventory_id":"<uuid or null>"}]}`
  try {
    const resp = await ac.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] })
    const raw = ((resp.content[0] as Anthropic.TextBlock).text || '').trim()
    const jsonStr = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    const parsed = JSON.parse(jsonStr) as { matches?: Array<{ i: number; inventory_id: string | null }> }
    const idSet = new Set(invRows.map(r => r.id as string))
    for (const m of (parsed.matches || [])) {
      const g = items[m.i]
      if (g && m.inventory_id && idSet.has(m.inventory_id)) out.set(g.norm, m.inventory_id)
    }
  } catch (_e) { /* AI match unavailable → everything falls back to create-new */ }
  return out
}

async function toolImportGroceryOrder(input: Record<string, unknown>, db: DB, emit: (label: string) => void = () => {}) {
  const rawText = (input.raw_text as string) || ''
  if (!rawText.trim()) return { error: 'No order text provided to parse.' }

  emit('Reading your order confirmation…')
  emit('Parsing order lines…')

  // ── Steps 1–3: parse lines, normalise names, net quantity per product. ──
  const groups = new Map<string, GroceryGroup>()
  for (const rawLine of rawText.split(/\r?\n/)) {
    const p = parseOrderLine(rawLine)
    if (!p) continue
    const key = NORM(p.name)
    if (!key) continue
    const g = groups.get(key) || { name: p.name, norm: key, net: 0, hasPositive: false }
    g.net += p.qty
    if (p.qty > 0) { g.hasPositive = true; g.name = p.name }   // prefer an original (positive) line's display name
    groups.set(key, g)
  }
  const all = [...groups.values()]

  // Non-food PRODUCTS are recognised and skipped (never written to inventory).
  const skippedNonFood = all.filter(g => isNonFood(g.name)).map(g => g.name)
  const food = all.filter(g => !isNonFood(g.name))

  const toUpdate    = food.filter(g => g.net > 0)                     // net > 0 → update / create
  const cancelled   = food.filter(g => g.net === 0)                   // net = 0 → skip, list to user
  const parseErrors = food.filter(g => g.net < 0 && g.hasPositive)    // reductions exceeded additions
  const corrections = food.filter(g => g.net < 0 && !g.hasPositive)   // negative-only → decrement existing

  emit(`Found ${food.length} items. Net: ${toUpdate.length} to update, ${cancelled.length + parseErrors.length + corrections.length} cancelled or adjusted.`)

  // ── Step 4: load inventory (active + inactive) + master vocabulary. ──
  emit('Matching items to inventory…')
  const [{ data: inv }, { data: masters }] = await Promise.all([
    db.from('inventory').select('id, name, quantity, category, food_category, master_ingredient_id, typical_quantity, active'),
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

  // Resolve every net>0 item to an inventory row (or null = create new). Items
  // that miss the deterministic matcher get a Claude matching pass.
  type Resolved = { g: GroceryGroup; row: Record<string, unknown> | null; wasInactive: boolean }
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
      const id = aiMap.get(g.norm)
      const row = id ? (invById.get(id) || null) : null
      resolved.push({ g, row, wasInactive: !!row && row.active === false })
    }
  }

  const nowIso = new Date().toISOString()
  const updatedNames: string[] = []
  const createdNames: string[] = []
  const flagged: string[] = []

  // ── Step 5: write net>0 items in batches of 10; progress between batches. ──
  const X = resolved.length
  let done = 0
  for (let b = 0; b < resolved.length; b += 10) {
    for (const { g, row, wasInactive } of resolved.slice(b, b + 10)) {
      if (row) {
        const upd: Record<string, unknown> = {
          quantity: (Number(row.quantity) || 0) + g.net,   // delivered qty adds to current stock
          last_updated_at: nowIso,
        }
        if (wasInactive) upd.active = true                              // buying it → relevant again
        if (Number(row.typical_quantity) === 0) upd.status = 'some'     // atypical restock has stock again
        const { error } = await db.from('inventory').update(upd).eq('id', row.id as string)
        if (error) flagged.push(`${g.name} — write failed (${error.message})`)
        else updatedNames.push(wasInactive ? `${row.name as string} (reactivated)` : (row.name as string))
      } else {
        const fc = inferFoodCategory(g.name)
        const { error } = await db.from('inventory').insert({
          name: g.name, quantity: g.net, status: 'enough',
          food_category: fc, category: inferStorageCategory(g.name, fc),
          source: 'grocery_import', active: true, last_updated_at: nowIso,
        })
        if (error) flagged.push(`${g.name} — create failed (${error.message})`)
        else createdNames.push(g.name)
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

  const parts: string[] = [`Done. Updated inventory for ${updatedNames.length} item${updatedNames.length === 1 ? '' : 's'}.`]
  if (createdNames.length)   parts.push(`${createdNames.length} new item${createdNames.length === 1 ? '' : 's'} added: ${createdNames.join(', ')}.`)
  if (cancelled.length)      parts.push(`${cancelled.length} fully cancelled and skipped: ${cancelled.map(g => g.name).join(', ')}.`)
  if (skippedNonFood.length) parts.push(`${skippedNonFood.length} non-food item${skippedNonFood.length === 1 ? '' : 's'} skipped: ${skippedNonFood.join(', ')}.`)
  if (flagged.length)        parts.push(`${flagged.length} flagged for review: ${flagged.join('; ')}.`)

  return {
    parsed_items: food.length,
    updated: updatedNames.length,
    created: createdNames,
    cancelled: cancelled.map(g => g.name),
    skipped_non_food: skippedNonFood,
    flagged,
    summary: parts.join(' '),
    note: 'Inventory has already been written directly (no confirmation step). Present the summary to the user as-is; do NOT regenerate the grocery list.',
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

async function dispatch(name: string, input: Record<string, unknown>, db: DB, userMsg: string, emit: (label: string) => void = () => {}): Promise<string> {
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
      case 'import_grocery_order':               result = await toolImportGroceryOrder(input, db, emit); break
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
    case 'import_grocery_order':   return 'Reading your order confirmation…'
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

// ── Handler ───────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

  try {
    const { message, tz_offset } = await req.json()
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
          const { reply, toolCalls, toolResults } = await runLoop(message.trim(), history, db, emit)

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

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

BEHAVIOR:
- Always fetch data before answering. Never guess current plan, inventory, or stash state.
- Propose ONE specific recommendation, not a list of options.
- After any plan edit, confirm the change in plain text and ask if anything else needs adjusting.
- Mid-cook urgent messages ("out of X", "no Y") → direct one-line answer, skip all preamble.
- When citing inventory for substitutions, add a brief hedge — inventory may not be fully current.
- Day-of-week convention used throughout: 0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday. Tool results include pre-computed day_name fields — always use day_name directly, never convert day_of_week integers yourself.
- stash_still_valid: false in a tool result means a meal planned from freezer_stash has no matching valid stash entry — always flag this to the user.
- Guest days: get_special_days returns known_guests[] (resolved member data) and guest_allergies[] (one-off). Both are hard allergy constraints for that date only — treat them with the same enforcement strength as household allergens when suggesting meals for that specific day.
- Inventory item names follow the pattern "Category - Variant" (e.g. "Milk - Oat", "Bread - Lingon Grova"). When the user describes what they have in stock, call update_inventory_from_description. The tool handles parsing, matching, and writing; your job is to relay what was done and ask about any ambiguous items it surfaces.
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
    description: "Get today's planned dinner with full recipe: ingredients, night_before / morning_of / when_cooking steps, hacks_and_shortcuts.",
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
    name: 'update_plan_slot',
    description: 'Set or change a meal plan entry. Logs the change to plan_edits. Call only after confirming with the user.',
    input_schema: {
      type: 'object' as const,
      properties: {
        plan_date:        { type: 'string', description: 'YYYY-MM-DD' },
        meal_type:        { type: 'string', description: 'dinner|lunch|breakfast' },
        recipe_id:        { type: 'string', description: 'UUID of recipe to assign.' },
        cook_source:      { type: 'string', description: 'home|freezer_stash|slow_cook|store_bought. Default: home.' },
        instruction_text: { type: 'string', description: 'User message that prompted this change (for audit).' },
      },
      required: ['plan_date', 'meal_type', 'recipe_id'],
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
    description: 'Add a new recipe to the catalogue and generate ADHD prep layers. Use only when user explicitly requests it.',
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
        meal_type:      { type: 'string' },
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
    .select('plan_date, meal_type, cook_source, is_commute_day, is_holiday, guest_count, slot_locked, notes, stash_item_id, recipes(id, name, emoji, protein, cooking_method, template_slot)')
    .gte('plan_date', start).lte('plan_date', end)
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
    .select('plan_date, meal_type, cook_source, guest_count, stash_item_id, recipes(id, name, emoji, protein, serves_base, original_instructions, night_before, morning_of, when_cooking, hacks_and_shortcuts, recipe_ingredients(name, quantity, unit, notes, order_index))')
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
    .select('id, recipe_name, recipe_id, portions, frozen_date, use_by_date, notes')
    .eq('used', false).eq('active', true).gt('portions', 0)
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
  const { data } = await db.from('special_days').select('*').gte('day', start).lte('day', end).order('day')
  const rows = data || []

  // Resolve known guest members for guest days
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
      ...row,
      day_name: dayNameFromDate(row.day as string),
      known_guests: ((row.guest_family_member_ids as string[]) || [])
        .map(id => guestMemberMap[id])
        .filter(Boolean),
    })),
  }
}

async function toolGetCommuteDays(db: DB) {
  const { data } = await db.from('commute_days')
    .select('day_of_week, label, notes, family_members(name)')
    .eq('active', true).order('day_of_week')
  return {
    commute_days: (data || []).map((row: Record<string, unknown>) => ({
      ...row,
      day_name: dayName(row.day_of_week as number),
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
  for (const item of updateItems) {
    const { error } = await db.from('inventory')
      .update({ quantity: item.quantity ?? null, unit: item.unit ?? null })
      .eq('id', item.matched_id!)
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

async function toolUpdatePlanSlot(input: Record<string, unknown>, db: DB, userMsg: string) {
  const { plan_date, meal_type, recipe_id, instruction_text } = input
  const cook_source = (input.cook_source as string) || 'home'

  const { data: existing } = await db.from('meal_plans')
    .select('recipe_id').eq('plan_date', plan_date).eq('meal_type', meal_type).single()
  const prevId = existing?.recipe_id || null

  const { error } = await db.from('meal_plans').upsert(
    { plan_date, meal_type, recipe_id, cook_source, slot_locked: true },
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

  const { data: newRec, error } = await db.from('recipes').insert({
    name, original_instructions, meal_type: meal_type || 'lunch_dinner',
    protein: protein || null, style: style || null,
    cooking_method: cooking_method || null, serves_base: serves_base || 4, active: true,
  }).select('id').single()
  if (error || !newRec) return { success: false, error: error?.message }

  await db.from('recipe_ingredients').insert(
    ingredients.map((ing, i) => ({
      recipe_id: newRec.id, name: ing.name,
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
        when_cooking: layers.when_cooking || null, hacks_and_shortcuts: layers.hacks_and_shortcuts || null,
      }).eq('id', newRec.id)
    }
  } catch (_) { /* layers optional */ }

  return { success: true, recipe_id: newRec.id, name }
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
2. COMMUTE_DAY — Are commute days correctly identified per commute_days data?
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
      case 'update_plan_slot':                   result = await toolUpdatePlanSlot(input, db, userMsg); break
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

async function runLoop(
  userMessage: string,
  history: { role: 'user' | 'assistant'; content: string }[],
  db: DB,
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
    db.from('chat_history')
      .delete()
      .lt('created_at', new Date(Date.now() - 30 * 86_400_000).toISOString())
      .then(() => {})

    // Load last 20 messages for context
    const { data: histRows } = await db.from('chat_history')
      .select('role, content')
      .in('role', ['user', 'assistant'])
      .order('created_at', { ascending: false })
      .limit(20)
    const history = (histRows || []).reverse() as { role: 'user' | 'assistant'; content: string }[]

    const { reply, toolCalls, toolResults } = await runLoop(message.trim(), history, db)

    await db.from('chat_history').insert([
      { role: 'user', content: message.trim() },
      { role: 'assistant', content: reply, tool_calls: toolCalls, tool_results: toolResults },
    ])

    return new Response(JSON.stringify({ reply }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('chat-agent:', err)
    return new Response(
      JSON.stringify({ reply: 'Something went wrong — please try again.', _error: String(err) }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
    )
  }
})

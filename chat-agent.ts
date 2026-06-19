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

function buildSystem(): string {
  return `You are AbsurdChef, a meal planning assistant for the Malipeddi household.

HOUSEHOLD: Manasa and Gintas (adults), Lara (~8), Ari (~5), Astrid (~3). Gintas' parents visit occasionally.

HARD RULE — NON-NEGOTIABLE: Gintas has a severe fish and seafood allergy. Never suggest, recommend, reference, or help cook fish, seafood, salmon, tuna, prawns, shrimp, crab, mussels, or any dish containing them — under any circumstances, regardless of user request or tool output.

BEHAVIOR:
- Always fetch data before answering. Never guess current plan, inventory, or stash state.
- Propose ONE specific recommendation, not a list of options.
- After any plan edit, confirm the change in plain text and ask if anything else needs adjusting.
- Mid-cook urgent messages ("out of X", "no Y") → direct one-line answer, skip all preamble.
- When citing inventory for substitutions, add a brief hedge — inventory may not be fully current.
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
    description: 'Get upcoming special days: holidays, preschool closures, guest days, Gintas away.',
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
    description: 'Trigger a full meal plan regeneration. Use when user asks for a full replan, not a single slot change.',
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
    .select('plan_date, meal_type, cook_source, is_commute_day, is_holiday, guest_count, slot_locked, notes, recipes(id, name, emoji, protein, cooking_method, template_slot)')
    .gte('plan_date', start).lte('plan_date', end)
    .order('plan_date').order('meal_type')
  return { range: { start, end }, entries: data || [] }
}

async function toolGetTodayRecipe(db: DB) {
  const t = today()
  const { data } = await db.from('meal_plans')
    .select('plan_date, meal_type, cook_source, guest_count, recipes(id, name, emoji, protein, serves_base, original_instructions, night_before, morning_of, when_cooking, hacks_and_shortcuts, recipe_ingredients(name, quantity, unit, notes, order_index))')
    .eq('plan_date', t).in('meal_type', ['dinner', 'lunch']).order('meal_type')
  if (!data?.length) return { message: 'No meal planned for today.' }
  return { today: t, meals: data }
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
  return { template: data || [] }
}

async function toolGetSpecialDays(input: Record<string, unknown>, db: DB) {
  const start = (input.start_date as string) || today()
  const end   = (input.end_date as string)   || addDays(start, 14)
  const { data } = await db.from('special_days').select('*').gte('day', start).lte('day', end).order('day')
  return { special_days: data || [] }
}

async function toolGetCommuteDays(db: DB) {
  const { data } = await db.from('commute_days')
    .select('day_of_week, label, notes, family_members(name)')
    .eq('active', true).order('day_of_week')
  return { commute_days: data || [] }
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
      case 'get_commute_days':       result = await toolGetCommuteDays(db); break
      case 'update_plan_slot':       result = await toolUpdatePlanSlot(input, db, userMsg); break
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
      return {
        reply: textBlocks.map(b => b.text).join('').trim() || 'Done.',
        toolCalls: allToolCalls, toolResults: allToolResults,
      }
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
      if (txt) return { reply: txt, toolCalls: allToolCalls, toolResults: allToolResults }
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

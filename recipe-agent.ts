import Anthropic from 'npm:@anthropic-ai/sdk'
import { createClient } from 'npm:@supabase/supabase-js@2'

const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') })
const supabase  = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}
function parseJSON(text: string) {
  return JSON.parse(text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim())
}

// ── Unit conversion (mirrors screens/convert.js; uses central master data) ──
type MasterConv = { unit_type?: string; grams_per_cup?: number | null }
function gram(g: number) { const r = g >= 100 ? Math.round(g / 5) * 5 : Math.round(g); return `${r}g` }
function kg(g: number) { return `${(g / 1000).toFixed(g % 1000 === 0 ? 0 : 1)}kg` }
function mlFmt(ml: number) { return `${Math.round(ml / 5) * 5}ml` }
function convBracket(q: number | undefined, unit: string | undefined, m?: MasterConv): string {
  if (q == null || !unit) return ''
  const u = unit.toLowerCase().trim()
  const t = m?.unit_type
  if (['oz', 'oz.', 'ounce', 'ounces'].includes(u)) return ` (${gram(q * 28.3495)})`
  if (['lb', 'lbs', 'lb.', 'pound', 'pounds'].includes(u)) { const g = q * 453.592; return ` (${g >= 1000 ? kg(g) : gram(g)})` }
  if (['cup', 'cups', 'c'].includes(u)) {
    if (t === 'liquid_volume') return ` (${mlFmt(q * 240)})`
    if (t === 'solid_volume' && m?.grams_per_cup) return ` (~${gram(q * m.grams_per_cup)})`
    if (t === 'count' || t === 'weight_only') return ''
    return ` (~${gram(q * 150)})`
  }
  const isTbsp = ['tbsp', 'tbsp.', 'tablespoon', 'tablespoons', 'tbs'].includes(u)
  const isTsp = ['tsp', 'tsp.', 'teaspoon', 'teaspoons'].includes(u)
  if (isTbsp || isTsp) {
    if (t === 'liquid_volume') return ` (${mlFmt(q * (isTbsp ? 15 : 5))})`
    if (t === 'solid_volume' && m?.grams_per_cup) return ` (~${gram(q * m.grams_per_cup / (isTbsp ? 16 : 48))})`
  }
  return ''
}
// Match free-text ingredient names to a master row (canonical or alias).
async function buildMasterMatcher() {
  const { data } = await supabase.from('master_ingredients')
    .select('canonical_name, aliases, unit_type, grams_per_cup').eq('active', true)
  const byName: Record<string, MasterConv> = {}
  for (const m of data || []) {
    const conv = { unit_type: m.unit_type, grams_per_cup: m.grams_per_cup }
    byName[(m.canonical_name as string).toLowerCase().trim()] = conv
    for (const a of (m.aliases as string[] | null) || []) byName[a.toLowerCase().trim()] = conv
  }
  return (name: string): MasterConv | undefined => byName[name.toLowerCase().trim()]
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  const body = await req.json()
  switch (body.action) {
    case 'extract_recipe':       return handleExtractRecipe(body)
    case 'generate_adhd_layers': return handleGenerateAdhdLayers(body)
    case 'add_more_hacks':       return handleAddMoreHacks(body)
    case 'check_substitute':     return handleCheckSubstitute(body)
    case 'suggest_easier':       return handleSuggestEasier(body)
    case 'scale_recipe':           return handleScaleRecipe(body)
    case 'parse_preschool_menu':  return handleParsePreschoolMenu(body)
    default:                      return json({ error: 'Unknown action' }, 400)
  }
})

// ── extract_recipe ────────────────────────────────────────
async function handleExtractRecipe({ raw_text }: { raw_text: string }) {
  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 3000,
    system: `Recipe parser. Extract structured data from pasted recipe text. Return ONLY valid JSON, no markdown. Only include fields you're confident about — leave unsure fields as null.`,
    messages: [{
      role: 'user',
      content: `Extract recipe data from this text:\n\n${raw_text}\n\nReturn JSON:\n{\n  "name": "recipe name",\n  "emoji": "single emoji",\n  "meal_type": "breakfast|lunch_dinner|snack|special",\n  "cuisine": "e.g. Indian or null",\n  "protein": "e.g. chicken or null",\n  "style": "e.g. slow simmer or null",\n  "cooking_method": "e.g. stovetop or null",\n  "serves_base": <number or null>,\n  "prep_time_min": <number or null>,\n  "cook_time_min": <number or null>,\n  "is_freezable": <true/false/null>,\n  "can_double": <true/false/null — true for stews/curries/sauces, false for delicate bakes>,\n  "tags": [],\n  "original_instructions": "full instructions, lightly cleaned only — do not summarize",\n  "ingredients": [\n    {"name": "name", "quantity": <number|null>, "unit": "unit or null", "notes": "notes or null"}\n  ]\n}`,
    }],
  })
  try {
    const text = msg.content[0].type === 'text' ? msg.content[0].text : '{}'
    return json(parseJSON(text))
  } catch {
    return json({ error: 'Failed to parse AI response' }, 500)
  }
}

// ── generate_adhd_layers ──────────────────────────────────
async function handleGenerateAdhdLayers({ recipe_name, original_instructions, ingredients }: {
  recipe_name: string
  original_instructions: string
  ingredients: { name: string; quantity?: number; unit?: string; notes?: string }[]
}) {
  // Each ingredient line carries its centrally-computed metric conversion so the
  // generated steps include dual units directly, e.g. "1 cup flour (~120g)".
  const matchMaster = await buildMasterMatcher()
  const ingList = ingredients.map(i => {
    const base = `${i.quantity != null ? i.quantity + (i.unit ? ' ' + i.unit + ' ' : ' ') : ''}${i.name}`
    return `${base}${convBracket(i.quantity, i.unit, matchMaster(i.name))}${i.notes ? ' (' + i.notes + ')' : ''}`
  }).join('\n')

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    system: `You are creating ADHD-friendly cooking preparation layers for a family meal app.

CRITICAL QUALITY RULE — exact quantities mandatory in ALL THREE step arrays (night_before, morning_of, AND when_cooking — not just the prep layers):
BAD:  "Mix the dry spices the night before" / "Add the yoghurt and top with berries"
GOOD: "In a small jar, mix: 1.5 tsp cumin, 1 tsp turmeric, 1 tsp coriander powder, ½ tsp chili powder, ½ tsp salt. Shake to combine." / "Add 200g yoghurt to a bowl, top with a handful of berries (about 100g)"
Any step that involves measurable ingredients MUST include the exact amounts from the ingredient list above — in when_cooking just as strictly as in night_before/morning_of. Never use vague descriptions like "the spices" or "a handful of" when a number exists.
EXCEPTION — do not invent precision the source lacks: if an ingredient has no quantity entered in the list, refer to it plainly (e.g. "add the yoghurt") rather than fabricating a number.

DUAL UNITS: the ingredient list already includes metric conversions in brackets for imperial amounts, e.g. "1 cup flour (~120g)". When you reference such an ingredient in a step, carry the dual unit through exactly as given — original first, metric in brackets — e.g. "Mix 1 cup flour (~120g) with 2 eggs." Keep the "~" where shown. For any oven temperature in Fahrenheit, write it as °F with °C in brackets, e.g. "Bake at 400°F (200°C)."

Tone: plain, direct, reassuring. No fluff or motivational filler.
Return ONLY valid JSON, no markdown.`,
    messages: [{
      role: 'user',
      content: `Recipe: "${recipe_name}"

INGREDIENTS:
${ingList}

INSTRUCTIONS:
${original_instructions}

Return JSON:
{
  "night_before": ["step with exact quantities"],
  "morning_of": ["step with exact quantities"],
  "when_cooking": ["step with exact quantities", "step with exact quantities"],
  "hacks_and_shortcuts": [
    "specific shortcut or tip for this exact dish"
  ]
}

For hacks_and_shortcuts (3-6 entries minimum), look for:
- Store-bought substitutes for homemade components (name the exact product category)
- Skippable steps that don't affect weeknight food safety or taste
- Equipment shortcuts (one pan vs several, food processor vs hand-chop, Instant Pot setting)
- Batch-ahead opportunities worth doing (mention in text, e.g. "the spice mix keeps 3 months — triple it now")
- Ordering tricks: steps that can run simultaneously
Each hack must be specific to THIS recipe. Empty arrays are valid if no prep is genuinely needed.`,
    }],
  })

  try {
    const text = msg.content[0].type === 'text' ? msg.content[0].text : '{}'
    return json(parseJSON(text))
  } catch {
    return json({ error: 'Failed to parse AI response' }, 500)
  }
}

// ── add_more_hacks ────────────────────────────────────────
async function handleAddMoreHacks({ recipe_name, original_instructions, ingredients, existing_hacks }: {
  recipe_name: string
  original_instructions: string
  ingredients: { name: string; quantity?: number; unit?: string; notes?: string }[]
  existing_hacks: string[]
}) {
  const ingList = ingredients.map(i =>
    `${i.quantity != null ? i.quantity + (i.unit ? ' ' + i.unit + ' ' : ' ') : ''}${i.name}${i.notes ? ' (' + i.notes + ')' : ''}`
  ).join('\n')
  const existingList = existing_hacks.map((h, i) => `${i + 1}. ${h}`).join('\n')

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 600,
    system: `Find additional cooking tips for this recipe. Be specific to this exact dish. Return ONLY valid JSON, no markdown.`,
    messages: [{
      role: 'user',
      content: `Recipe: "${recipe_name}"

INGREDIENTS: ${ingList}

INSTRUCTIONS: ${original_instructions}

EXISTING TIPS (do not duplicate or rephrase):
${existingList || 'none yet'}

Find 1-3 genuinely new tips not already covered above. Return:
{"new_hacks": ["tip 1", "tip 2"]}
If nothing new, return {"new_hacks": []}`,
    }],
  })

  try {
    const text = msg.content[0].type === 'text' ? msg.content[0].text : '{"new_hacks":[]}'
    return json(parseJSON(text))
  } catch {
    return json({ new_hacks: [] })
  }
}

// ── check_substitute ──────────────────────────────────────
async function handleCheckSubstitute({ ingredient_name }: { ingredient_name: string }) {
  const { data: inv } = await supabase
    .from('inventory').select('name, quantity, unit').eq('active', true).order('name')
  const pantry = inv?.map(i =>
    `${i.name}${i.quantity != null ? ' (' + i.quantity + (i.unit ? ' ' + i.unit : '') + ')' : ''}`
  ).join(', ') || 'nothing in pantry'

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 100,
    system: 'Kitchen helper. Reply in ONE sentence only. Family has a hard fish/seafood allergy — never suggest fish or seafood.',
    messages: [{
      role: 'user',
      content: `Missing: "${ingredient_name}". Pantry: ${pantry}. Suggest a substitute with quantity, or say nothing obvious is available.`,
    }],
  })
  const message = msg.content[0].type === 'text' ? msg.content[0].text : ''
  return json({ message })
}

// ── suggest_easier ────────────────────────────────────────
async function handleSuggestEasier({ recipe_name, current_serves, ingredients, instructions, constraint }: {
  recipe_name: string
  current_serves: number
  ingredients: { name: string; quantity?: number; unit?: string; notes?: string }[]
  instructions: { night_before?: string[]; morning_of?: string[]; when_cooking?: string[]; hacks_and_shortcuts?: string[] }
  constraint: string
}) {
  const { data: inv } = await supabase
    .from('inventory').select('name, quantity, unit').eq('active', true)
  const pantry = inv?.map(i =>
    `${i.name}${i.quantity != null ? ' (' + i.quantity + (i.unit ? ' ' + i.unit : '') + ')' : ''}`
  ).join(', ') || 'unknown'

  const ingText = ingredients.map(i =>
    `${i.quantity != null ? i.quantity + (i.unit ? ' ' + i.unit + ' ' : ' ') : ''}${i.name}${i.notes ? ' (' + i.notes + ')' : ''}`
  ).join('\n')
  const instrText = [
    instructions.night_before?.length ? `Night before:\n${instructions.night_before.map(s => '- ' + s).join('\n')}` : '',
    instructions.morning_of?.length   ? `Morning of:\n${instructions.morning_of.map(s => '- ' + s).join('\n')}` : '',
    instructions.when_cooking?.length ? `When cooking:\n${instructions.when_cooking.map(s => '- ' + s).join('\n')}` : '',
  ].filter(Boolean).join('\n\n')

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1800,
    system: `Meal planning assistant creating an easier cooking variant. Return ONLY valid JSON, no markdown. Family has a hard fish/seafood allergy.
EXACT QUANTITIES: in night_before, morning_of AND when_cooking, every step that uses a measurable ingredient must state the real amount from the INGREDIENTS list (e.g. "stir in 400g chopped tomatoes", not "add the tomatoes"). Apply this to when_cooking just as strictly as the prep layers. Do not invent precision for ingredients that have no quantity given.`,
    messages: [{
      role: 'user',
      content: `Recipe: "${recipe_name}" (serves ${current_serves})\n\nINGREDIENTS:\n${ingText}\n\nINSTRUCTIONS:\n${instrText}\n\nPANTRY: ${pantry}\n\nSITUATION: ${constraint}\n\nReturn JSON:\n{\n  "label": "short variant name",\n  "serves": ${current_serves},\n  "night_before": [],\n  "morning_of": [],\n  "when_cooking": ["step"],\n  "hacks_and_shortcuts": ["specific tip for this easier version"],\n  "notes": "1-2 sentences on the tradeoff",\n  "ingredient_changes": [\n    {"action": "substitute", "from": "old name", "to": "new name", "quantity": null, "unit": null, "notes": null},\n    {"action": "remove", "name": "ingredient to drop"}\n  ]\n}`,
    }],
  })

  try {
    const text = msg.content[0].type === 'text' ? msg.content[0].text : '{}'
    return json(parseJSON(text))
  } catch {
    return json({ error: 'Failed to parse AI response' }, 500)
  }
}

// ── parse_preschool_menu ──────────────────────────────────
async function handleParsePreschoolMenu({ raw_text, iso_week }: { raw_text: string; iso_week: string }) {
  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    system: `Parse weekly preschool lunch menus into structured JSON. Return ONLY valid JSON, no markdown.`,
    messages: [{
      role: 'user',
      content: `Parse this preschool menu (translated to English) for week ${iso_week}.

Format: main dish, ingredients in parens, vegetarian alt in second parens prefixed "Veg:", then sides.
Ignore "Salad & Fruit" — it appears every day and has no signal.

Extract one record per weekday (Mon–Fri) with:
- day_of_week: 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri
- meal_description: clean main dish description
- protein: chicken|beef|pork|fish|vegetarian|egg (infer from dish; no clear meat = vegetarian)
- style: soup|stew|curry|pasta|rice_dish|casserole|other
- lunch_weight: light (soup+bread or explicitly light) | heavy (stew/curry with rice or couscous) | medium (everything else)
- raw_text: that day's original line, unmodified

Omit days that are blank, missing, or explicitly closed/holiday.

MENU:
${raw_text}

Return: {"meals": [{"day_of_week": 1, "meal_description": "...", "protein": "...", "style": "...", "lunch_weight": "...", "raw_text": "..."}]}`,
    }],
  })
  try {
    const text = msg.content[0].type === 'text' ? msg.content[0].text : '{}'
    return json(parseJSON(text))
  } catch {
    return json({ error: 'Failed to parse AI response' }, 500)
  }
}

// ── scale_recipe ──────────────────────────────────────────
async function handleScaleRecipe({ recipe_name, current_serves, ingredients, target }: {
  recipe_name: string
  current_serves: number
  ingredients: { name: string; quantity?: number; unit?: string; notes?: string }[]
  target: string
}) {
  const ingText = ingredients.map((i, n) =>
    `${n + 1}. ${i.quantity != null ? i.quantity + (i.unit ? ' ' + i.unit + ' ' : ' ') : ''}${i.name}${i.notes ? ' (' + i.notes + ')' : ''}`
  ).join('\n')

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    system: `Recipe scaling assistant. Return ONLY valid JSON, no markdown. Account for: non-linear spice scaling, awkward unit rounding (1.5 eggs→2), pan/pot limits at scale.`,
    messages: [{
      role: 'user',
      content: `Recipe: "${recipe_name}" currently serves ${current_serves}.\n\nINGREDIENTS:\n${ingText}\n\nTARGET: ${target}\n\nReturn JSON:\n{\n  "serves": <number>,\n  "label": "e.g. 'For 8' or 'Doubled'",\n  "ingredients": [\n    {"name": "name", "quantity": <number|null>, "unit": "unit|null", "notes": "clarification|null"}\n  ],\n  "when_cooking_changes": ["step change at this scale"],\n  "scaling_notes": "one sentence on key adjustments"\n}`,
    }],
  })

  try {
    const text = msg.content[0].type === 'text' ? msg.content[0].text : '{}'
    return json(parseJSON(text))
  } catch {
    return json({ error: 'Failed to parse AI response' }, 500)
  }
}

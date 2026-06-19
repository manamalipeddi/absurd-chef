import Anthropic from 'npm:@anthropic-ai/sdk'
import { createClient } from 'npm:@supabase/supabase-js@2'

const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') })
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

function parseJSON(text: string) {
  return JSON.parse(text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim())
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  const body = await req.json()
  const { action } = body
  if (action === 'check_substitute') return handleCheckSubstitute(body)
  if (action === 'suggest_easier')   return handleSuggestEasier(body)
  if (action === 'scale_recipe')     return handleScaleRecipe(body)
  return json({ error: 'Unknown action' }, 400)
})

// ── check_substitute ──────────────────────────────────────
async function handleCheckSubstitute({ ingredient_name }: { ingredient_name: string }) {
  const { data: inv } = await supabase
    .from('inventory').select('name, quantity, unit').eq('active', true).order('name')
  const pantry = inv?.map(i =>
    `${i.name}${i.quantity ? ' (' + i.quantity + (i.unit ? ' ' + i.unit : '') + ')' : ''}`
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
  instructions: { night_before?: string[]; morning_of?: string[]; when_cooking?: string[]; the_scary_bit?: string }
  constraint: string
}) {
  const { data: inv } = await supabase
    .from('inventory').select('name, quantity, unit').eq('active', true)
  const pantry = inv?.map(i =>
    `${i.name}${i.quantity ? ' (' + i.quantity + (i.unit ? ' ' + i.unit : '') + ')' : ''}`
  ).join(', ') || 'unknown'

  const ingText = ingredients.map(i =>
    `${i.quantity ? i.quantity + (i.unit ? ' ' + i.unit + ' ' : ' ') : ''}${i.name}${i.notes ? ' (' + i.notes + ')' : ''}`
  ).join('\n')

  const instrText = [
    instructions.night_before?.length ? `Night before:\n${instructions.night_before.map(s => '- ' + s).join('\n')}` : '',
    instructions.morning_of?.length   ? `Morning of:\n${instructions.morning_of.map(s => '- ' + s).join('\n')}` : '',
    instructions.when_cooking?.length ? `When cooking:\n${instructions.when_cooking.map(s => '- ' + s).join('\n')}` : '',
    instructions.the_scary_bit        ? `Scary bit: ${instructions.the_scary_bit}` : '',
  ].filter(Boolean).join('\n\n')

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    system: `Meal planning assistant creating an easier cooking variant. Return ONLY valid JSON with no markdown or code fences. Family has a hard fish/seafood allergy.`,
    messages: [{
      role: 'user',
      content: `Recipe: "${recipe_name}" (serves ${current_serves})

INGREDIENTS:
${ingText}

INSTRUCTIONS:
${instrText}

PANTRY: ${pantry}

SITUATION: ${constraint}

Create an easier version for this situation. Return JSON:
{
  "label": "short name e.g. 'No-Prep Version'",
  "serves": ${current_serves},
  "night_before": ["step"],
  "morning_of": ["step"],
  "when_cooking": ["step"],
  "the_scary_bit": "one line or null",
  "notes": "1-2 sentences on the tradeoff",
  "ingredient_changes": [
    { "action": "substitute", "from": "old name", "to": "new name", "quantity": null, "unit": null, "notes": null },
    { "action": "remove", "name": "ingredient to drop" }
  ]
}`,
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
    `${n + 1}. ${i.quantity ? i.quantity + (i.unit ? ' ' + i.unit + ' ' : ' ') : ''}${i.name}${i.notes ? ' (' + i.notes + ')' : ''}`
  ).join('\n')

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    system: `Recipe scaling assistant. Return ONLY valid JSON, no markdown. Account for: non-linear spice scaling, awkward unit rounding (1.5 eggs→2), pan/pot limits at larger scale.`,
    messages: [{
      role: 'user',
      content: `Recipe: "${recipe_name}" currently serves ${current_serves}.

INGREDIENTS:
${ingText}

TARGET: ${target}

Return JSON:
{
  "serves": <number>,
  "label": "short label e.g. 'For 8' or 'Doubled'",
  "ingredients": [
    { "name": "name", "quantity": <number|null>, "unit": "unit|null", "notes": "clarification|null" }
  ],
  "when_cooking_changes": ["step that changes at this scale"],
  "scaling_notes": "one sentence on key adjustments"
}`,
    }],
  })

  try {
    const text = msg.content[0].type === 'text' ? msg.content[0].text : '{}'
    return json(parseJSON(text))
  } catch {
    return json({ error: 'Failed to parse AI response' }, 500)
  }
}

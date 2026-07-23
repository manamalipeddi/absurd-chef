// AbsurdChef — Grocery Snapshot Edge Function
// Builds a cleaned, AI-deduplicated "Absurd Plan Requirements" shopping list for
// the current 14-day plan window and saves it to grocery_list_snapshot.
// Triggered manually (Grocery tab "Regenerate") or by the Sunday cron (chained
// from plan-generator after a scheduled run).
// Deploy: supabase functions deploy grocery-snapshot --no-verify-jwt

import Anthropic from 'npm:@anthropic-ai/sdk'
import { createClient } from 'npm:@supabase/supabase-js@2'

const ac  = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY')! })
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'content-type',
}

const LOW = new Set(['out', 'very_low', 'some'])

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

  try {
    const body = await req.json().catch(() => ({}))
    const triggeredBy = body.triggered_by === 'cron' ? 'cron' : 'manual'
    const db = createClient(SUPABASE_URL, SUPABASE_KEY)

    const today = new Date().toISOString().slice(0, 10)
    // Fixed shopping horizon: today through the Wednesday of week 2 (the next
    // Wednesday on/after today + 7 days). Anything later is covered by next
    // week's order, which arrives Tue/Wed. No shelf-life math — just the cutoff
    // that matches how the household actually shops. (The plan still runs 14
    // days; only the grocery list has this shorter horizon.)
    const cutoff = new Date(today + 'T12:00:00Z')
    cutoff.setUTCDate(cutoff.getUTCDate() + 7)
    cutoff.setUTCDate(cutoff.getUTCDate() + ((3 - cutoff.getUTCDay() + 7) % 7))   // 3 = Wednesday
    const end = cutoff.toISOString().slice(0, 10)

    // 1. Ingredients needed by planned, home-cooked meals in the window.
    const { data: plan } = await db.from('meal_plans')
      .select('cook_source, recipes!meal_plans_recipe_id_fkey(name, recipe_ingredients(name, master_ingredient_id))')
      .gte('plan_date', today).lte('plan_date', end)
      .not('recipe_id', 'is', null).neq('meal_type', 'snack')

    // Count distinct recipes each ingredient appears in (for the "needed across N
    // recipes" note), keyed by lowercased name.
    const byName: Record<string, { name: string; masterId: string | null; recipes: Set<string> }> = {}
    for (const row of (plan || []) as Record<string, unknown>[]) {
      if (row.cook_source === 'freezer_stash' || row.cook_source === 'store_bought') continue
      const r = row.recipes as { name?: string; recipe_ingredients?: Array<{ name: string; master_ingredient_id: string | null }> } | null
      if (!r?.recipe_ingredients) continue
      for (const ing of r.recipe_ingredients) {
        const key = (ing.name || '').toLowerCase().trim()
        if (!key) continue
        if (!byName[key]) byName[key] = { name: ing.name, masterId: ing.master_ingredient_id, recipes: new Set() }
        if (ing.master_ingredient_id && !byName[key].masterId) byName[key].masterId = ing.master_ingredient_id
        if (r.name) byName[key].recipes.add(r.name)
      }
    }

    // 2. Exclude anything we already have sufficient stock of. (Simplified: an
    //    ingredient is covered if a matching inventory item is in stock and not
    //    low — master-ingredient-level aggregation is intentionally out of scope.)
    const { data: inv } = await db.from('inventory').select('name, master_ingredient_id, quantity, status').eq('active', true)
    const stockedMasters = new Set<string>()
    const stockedNames: string[] = []
    for (const it of (inv || []) as Record<string, unknown>[]) {
      const inStock = it.quantity != null && Number(it.quantity) > 0 && !LOW.has(it.status as string)
      if (!inStock) continue
      if (it.master_ingredient_id) stockedMasters.add(it.master_ingredient_id as string)
      stockedNames.push(String(it.name || '').toLowerCase())
    }
    const isStocked = (entry: { name: string; masterId: string | null }) => {
      if (entry.masterId && stockedMasters.has(entry.masterId)) return true
      const n = entry.name.toLowerCase()
      return stockedNames.some(s => s === n || s.includes(n) || n.includes(s))
    }

    const needed = Object.values(byName).filter(e => !isStocked(e))

    // No shortfall → save an empty snapshot (the list IS up to date).
    let items: unknown[] = []
    if (needed.length) {
      const listText = needed
        .map(e => `- ${e.name} (recipes: ${[...e.recipes].join(', ')})`)
        .join('\n')

      const prompt = `You are cleaning up a raw grocery list pulled from a 2-week meal plan. The raw list repeats ingredients across recipes and uses inconsistent names and quantities. Each line shows which recipe(s) need that ingredient.

Produce a clean, consolidated shopping list. Merge duplicates and obvious variants (e.g. "onion", "onions", "1 red onion" → one "Onions" entry).

Rules:
- "name": clean display name, Title Case, plural where natural
- "quantity": a rough human amount if sensible ("several", "1 bunch", "~500g"), else "as needed"
- "category": exactly one of: produce | meat | dairy | pantry | other (infer from the ingredient type)
- "note": which recipe(s) need this item — recipe names only, comma-separated, no dates or meal-type detail. If more than 3 recipes need it, list the first 2 then "+ N more" (e.g. "Chicken Tagine, White Bean Soup + 2 more"). When you merge variants, combine their recipes into this list.

Return ONLY a JSON array — your entire response must start with [ and end with ]. No prose.
[{"name":"Onions","quantity":"several","category":"produce","note":"Chicken Tagine, White Bean Soup + 1 more"}]

RAW LIST:
${listText}`

      const msg = await ac.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }],
      })
      const raw = (msg.content?.[0] as { text?: string })?.text ?? ''
      let clean = raw.replace(/```json|```/g, '').trim()
      const fb = clean.indexOf('['), lb = clean.lastIndexOf(']')
      if (fb !== -1 && lb !== -1 && lb > fb) clean = clean.slice(fb, lb + 1)
      try {
        const parsed = JSON.parse(clean)
        if (Array.isArray(parsed)) items = parsed
      } catch (_e) {
        return json({ success: false, error: 'Could not parse the cleaned list — please try again.' }, 502)
      }
    }

    // Non-food restock: low/out-of-stock non-food items (cleaning, paper,
    // toiletries, pet) belong on the shopping list too — same stock treatment as
    // food (quantity 0 or a low status), but independent of any recipe. Appended
    // directly; their names are already clean, so no AI dedup pass is needed.
    const { data: nf } = await db.from('inventory')
      .select('name, quantity, status')
      .eq('active', true).eq('food_category', 'non_food')
    const nfNeeded = ((nf || []) as Record<string, unknown>[])
      .filter(it => it.quantity == null || Number(it.quantity) <= 0 || LOW.has(it.status as string))
      .map(it => ({ name: it.name, quantity: 'as needed', category: 'other', note: 'Restock (non-food)' }))
    if (nfNeeded.length) items = [...(items as unknown[]), ...nfNeeded]

    const { data: snap, error } = await db.from('grocery_list_snapshot').insert({
      triggered_by: triggeredBy,
      plan_date_range_start: today,
      plan_date_range_end: end,
      items,
    }).select().single()
    if (error) return json({ success: false, error: error.message }, 500)

    return json({ success: true, snapshot: snap })
  } catch (e) {
    return json({ success: false, error: String((e as Error)?.message || e) }, 500)
  }
})

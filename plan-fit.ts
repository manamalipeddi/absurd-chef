// AbsurdChef — Plan Fit Edge Function
// A weekly self-evaluation of how well the CHEF'S PLAN matched the household's
// actual week. It measures the PLAN's fit to real life — never the family's
// adherence to the plan. A low score means the plan should change, never that
// the family failed it; the diagnosis copy follows that direction.
//
// Triggered by Allie (~Sunday 19:30 local, X-Allie-Key protected) so the
// 19:00 log-prompt → 19:30 compute → 20:00 relay sequence stays DST-correct.
// Scores the closing Mon–Sun week, writes one plan_fit_reports row.
// Deploy: supabase functions deploy plan-fit --no-verify-jwt
//
// SCORING (per planned slot in the window):
//   3 — planned recipe made in its exact slot (same date + meal_type)
//   2 — planned recipe made the same date, different meal slot
//   1 — planned recipe made elsewhere in the window (different date)
//   0 — planned recipe not made at all in the window
// Matches against actual_recipe_id, made-as-planned (actually_made + null
// actual), and the additional_recipes tracking field. Freezer-assigned slots
// score identically. Denominator = 3 × scorable slots, where a slot is dropped
// if the day was is_vacation, or a weekday lunch whose kids_home later flipped
// off (the slot stopped existing through no fault of the plan).

import Anthropic from 'npm:@anthropic-ai/sdk'
import { createClient } from 'npm:@supabase/supabase-js@2'

const ac  = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY')! })
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'content-type, x-allie-key',
}
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const addDays = (iso: string, n: number) => {
  const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

  // Keyed — this is a write + a paid Claude call. Fail closed if the shared
  // secret is unset or mismatched.
  const secret = Deno.env.get('ALLIE_HANDOFF_KEY')
  if (!secret || req.headers.get('x-allie-key') !== secret) {
    return json({ error: 'Unauthorized — missing or invalid X-Allie-Key.' }, 401)
  }

  try {
    const body = await req.json().catch(() => ({}))
    // Allie passes its LOCAL Sunday date as week_end (avoids UTC edge cases);
    // default to UTC today if absent. Window is the Mon–Sun ending that day.
    const weekEnd   = /^\d{4}-\d{2}-\d{2}$/.test(String(body.week_end || ''))
      ? String(body.week_end) : new Date().toISOString().slice(0, 10)
    const weekStart = addDays(weekEnd, -6)
    const db = createClient(SUPABASE_URL, SUPABASE_KEY)

    // Planned + actual state for every dinner/lunch slot in the window.
    const { data: planRows } = await db.from('meal_plans')
      .select('plan_date, meal_type, recipe_id, actually_made, actual_recipe_id, additional_recipes, ' +
              'planned:recipes!meal_plans_recipe_id_fkey(name), actual:recipes!meal_plans_actual_recipe_id_fkey(name)')
      .gte('plan_date', weekStart).lte('plan_date', weekEnd)
      .in('meal_type', ['dinner', 'lunch'])
      .order('plan_date').order('meal_type')
    const rows = (planRows || []) as Array<{
      plan_date: string; meal_type: string; recipe_id: string | null
      actually_made: boolean | null; actual_recipe_id: string | null
      additional_recipes: Array<{ recipe_id?: string | null }> | null
      planned: { name: string } | null; actual: { name: string } | null
    }>

    const { data: dsRows } = await db.from('day_settings')
      .select('day, is_vacation, kids_home').gte('day', weekStart).lte('day', weekEnd)
    const daySettings = new Map<string, { is_vacation: boolean | null; kids_home: boolean | null }>()
    for (const d of (dsRows || []) as Array<{ day: string; is_vacation: boolean | null; kids_home: boolean | null }>) {
      daySettings.set(d.day, { is_vacation: d.is_vacation, kids_home: d.kids_home })
    }

    // ── Made-index: what recipe was actually eaten, and where ──
    // A swap records the actual recipe (actual_recipe_id); a made-as-planned
    // records the planned recipe; additional_recipes records extra dishes. All
    // count as "made" at that (date, meal) for matching OTHER planned slots too.
    const madeSlot = new Map<string, Set<string>>()   // "date|meal" → recipe ids
    const madeDay  = new Map<string, Set<string>>()    // "date"      → recipe ids
    const madeWin  = new Set<string>()                 // anywhere in the window
    const record = (date: string, meal: string, id: string | null | undefined) => {
      if (!id) return
      const k = date + '|' + meal
      if (!madeSlot.has(k)) madeSlot.set(k, new Set())
      madeSlot.get(k)!.add(id)
      if (!madeDay.has(date)) madeDay.set(date, new Set())
      madeDay.get(date)!.add(id)
      madeWin.add(id)
    }
    for (const r of rows) {
      if (r.actual_recipe_id) record(r.plan_date, r.meal_type, r.actual_recipe_id)
      else if (r.actually_made === true && r.recipe_id) record(r.plan_date, r.meal_type, r.recipe_id)
      for (const a of (r.additional_recipes || [])) record(r.plan_date, r.meal_type, a?.recipe_id)
    }

    // ── Score each planned, scorable slot ──
    let earned = 0, scorable = 0, excluded = 0
    const slotDetail: Array<Record<string, unknown>> = []
    for (const r of rows) {
      if (!r.recipe_id) continue                       // only slots with a planned recipe
      const ds  = daySettings.get(r.plan_date)
      const dow = new Date(r.plan_date + 'T00:00:00Z').getUTCDay()
      if (ds?.is_vacation) {
        excluded++; slotDetail.push({ date: r.plan_date, meal_type: r.meal_type, planned: r.planned?.name || null, excluded: 'vacation' }); continue
      }
      // A weekday lunch existed only because the kids were home; if kids_home
      // later flipped off, that slot stopped existing — not the plan's fault.
      if (r.meal_type === 'lunch' && dow >= 1 && dow <= 5 && ds && ds.kids_home === false) {
        excluded++; slotDetail.push({ date: r.plan_date, meal_type: r.meal_type, planned: r.planned?.name || null, excluded: 'kids_home_off' }); continue
      }
      scorable++
      const k = r.plan_date + '|' + r.meal_type
      let score = 0, where = 'none'
      if (madeSlot.get(k)?.has(r.recipe_id))      { score = 3; where = 'exact' }
      else if (madeDay.get(r.plan_date)?.has(r.recipe_id)) { score = 2; where = 'same_day' }
      else if (madeWin.has(r.recipe_id))          { score = 1; where = 'window' }
      earned += score
      slotDetail.push({
        date: r.plan_date, day: DOW[dow], meal_type: r.meal_type,
        planned: r.planned?.name || null,
        actual: r.actual?.name || (r.actually_made ? r.planned?.name : null) || null,
        score, where,
      })
    }
    const maxScore = 3 * scorable
    const fitPercent = scorable > 0 ? Math.round((earned / maxScore) * 1000) / 10 : null

    // ── Diagnosis (one Claude call) — the PLAN-improvement pattern summary ──
    const { data: prior } = await db.from('plan_fit_reports')
      .select('week_start, fit_percent, diagnosis')
      .lt('week_start', weekStart).order('week_start', { ascending: false }).limit(3)
    const priorText = ((prior || []) as Array<{ week_start: string; fit_percent: number | null; diagnosis: string | null }>)
      .map(p => `Week of ${p.week_start}: ${p.fit_percent ?? '—'}% — ${p.diagnosis || ''}`).join('\n') || '(no prior weeks yet)'

    let diagnosis = 'No scorable slots this week (vacation or an empty week) — nothing to score.'
    if (scorable > 0) {
      const prompt = `You are analysing "Plan Fit" for a household meal planner. Plan Fit measures how well THE PLAN fit the household's actual week — NEVER how well the family followed the plan. A low score means THE PLAN should change, never that the family failed. Write every observation as a plan-improvement note; never phrase anything as the household failing to comply.

This week (${weekStart} to ${weekEnd}): ${fitPercent}% (${earned} of ${maxScore} points across ${scorable} slots).
Per-slot results (score: 3 = made as planned in its slot, 2 = same day but a different meal, 1 = made later that week, 0 = not made in the window):
${JSON.stringify(slotDetail.filter(s => !s.excluded), null, 2)}

Recent prior weeks (for spotting misfits that recur):
${priorText}

Write a SHORT diagnosis (2-4 sentences, no preamble). Cover briefly what fit well and what didn't, and identify the PATTERN in lost points — which slot types, days, or recipes consistently didn't fit — phrased as plan-improvement observations (e.g. "weekend lunch planning may need looser rules"; "Tuesday's dinner has missed several weeks running — worth retiring or replacing that template slot"). If a recipe or slot type recurs in the prior weeks above, call it out. Output ONLY the diagnosis text.`
      try {
        const msg = await ac.messages.create({
          model: 'claude-sonnet-4-6', max_tokens: 500,
          messages: [{ role: 'user', content: prompt }],
        })
        diagnosis = ((msg.content?.[0] as { text?: string })?.text || '').trim() || diagnosis
      } catch (_e) {
        diagnosis = `The plan fit ${fitPercent}% of the week (${earned}/${maxScore}). (Diagnosis unavailable this week.)`
      }
    }

    const { data: saved, error } = await db.from('plan_fit_reports')
      .upsert({
        week_start: weekStart, week_end: weekEnd,
        scorable_slots: scorable, max_score: maxScore, earned_score: earned,
        fit_percent: fitPercent, slot_detail: slotDetail, diagnosis,
      }, { onConflict: 'week_start' })
      .select().single()
    if (error) return json({ error: error.message }, 500)

    return json({ success: true, report: saved, excluded_slots: excluded })
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500)
  }
})

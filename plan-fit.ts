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
//   3 — made as planned in its exact slot: the owner logged "all good", OR never
//       edited the slot at all (see UNEDITED below), OR the planned recipe was
//       recorded as actually made in that exact slot.
//   2 — a LOGGED deviation, but the planned recipe was made the same date in the
//       other meal slot.
//   1 — a LOGGED deviation, but the planned recipe was made elsewhere that week.
//   0 — a LOGGED deviation and the planned recipe never happened that week.
// Partial credit (2/1) matches against the made-index: actual_recipe_id,
// made-as-planned recipes, and additional_recipes. Denominator = 3 × scorable
// slots; a slot is dropped if the day was is_vacation, a weekday lunch whose
// kids_home later flipped off, or the slot was planned as "Other" (a self-defined
// flexible slot — picnic/leftovers/eating-out — not a real plan to grade).
//
// UNEDITED SLOTS (owner directive): the household logs DEVIATIONS, not every
// meal — a week often reaches Sunday with slots never touched. Per the owner,
// an unedited slot (no actual_recipe_id / actually_made / actual_notes /
// additional_recipes) is DEEMED made as planned — "I didn't update it because
// the AI got that one right" — so it scores a full 3 (tagged where:"deemed")
// and counts as a genuine success, NOT a neutral unknown. Only a LOGGED
// deviation can cost points. The deemed count is stored (assumed_slots column).
//
// "OTHER" PLACEHOLDER: a single shared recipe id every free-text entry rides.
// It is kept out of the made-index (matching one "Other" against another is
// meaningless and used to leak phantom points), and slots planned as "Other" are
// dropped from scoring. When a logged actual is "Other", slot_detail records the
// typed free text (actual_notes, e.g. "leftover quesadillas") — not the bare word
// "Other" — so the diagnosis sees the real shape of the week.

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
      .select('plan_date, meal_type, recipe_id, actually_made, actual_recipe_id, actual_notes, notes, additional_recipes, ' +
              'planned:recipes!meal_plans_recipe_id_fkey(name, is_placeholder), actual:recipes!meal_plans_actual_recipe_id_fkey(name, is_placeholder)')
      .gte('plan_date', weekStart).lte('plan_date', weekEnd)
      .in('meal_type', ['dinner', 'lunch'])
      .order('plan_date').order('meal_type')
    const rows = (planRows || []) as Array<{
      plan_date: string; meal_type: string; recipe_id: string | null
      actually_made: boolean | null; actual_recipe_id: string | null
      actual_notes: string | null; notes: string | null
      additional_recipes: Array<{ recipe_id?: string | null }> | null
      planned: { name: string; is_placeholder: boolean | null } | null
      actual: { name: string; is_placeholder: boolean | null } | null
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
      // The "Other" placeholder is a SINGLE shared recipe id that every free-text
      // entry rides (leftovers, takeout, "sandwich out"). It must NEVER enter the
      // made-index: matching one "Other" slot against another is meaningless and
      // used to hand out phantom same-day/window points (e.g. a planned "Other"
      // lunch scoring 1 just because an unrelated "Other" was eaten that week).
      if (r.actual_recipe_id && !r.actual?.is_placeholder) record(r.plan_date, r.meal_type, r.actual_recipe_id)
      // The planned recipe counts as "made" ONLY on a genuine made-as-planned:
      // actually_made true with NO logged deviation. An "Other" free-text deviation
      // sets actual_recipe_id to the Other PLACEHOLDER (so the first branch above is
      // skipped) — it must NOT fall through here and credit the planned recipe as
      // eaten, or every "Waffles instead of Rajma" slot scores a phantom 3. This
      // mirrors the madeAsPlanned test used by the scorer below (keep them in sync).
      else if (r.actually_made === true && !r.actual_recipe_id && (r.actual_notes || '').trim() === '' &&
               r.recipe_id && !r.planned?.is_placeholder) record(r.plan_date, r.meal_type, r.recipe_id)
      for (const a of (r.additional_recipes || [])) record(r.plan_date, r.meal_type, a?.recipe_id)
    }

    // ── Score each planned, scorable slot ──
    let earned = 0, scorable = 0, excluded = 0, deemed = 0
    const slotDetail: Array<Record<string, unknown>> = []
    for (const r of rows) {
      if (!r.recipe_id) continue                       // only slots with a planned recipe
      const plannedName = r.planned?.name || null
      const ds  = daySettings.get(r.plan_date)
      const dow = new Date(r.plan_date + 'T00:00:00Z').getUTCDay()
      if (ds?.is_vacation) {
        excluded++; slotDetail.push({ date: r.plan_date, meal_type: r.meal_type, planned: plannedName, excluded: 'vacation' }); continue
      }
      // A weekday lunch existed only because the kids were home; if kids_home
      // later flipped off, that slot stopped existing — not the plan's fault.
      if (r.meal_type === 'lunch' && dow >= 1 && dow <= 5 && ds && ds.kids_home === false) {
        excluded++; slotDetail.push({ date: r.plan_date, meal_type: r.meal_type, planned: plannedName, excluded: 'kids_home_off' }); continue
      }
      // A slot the owner planned as "Other" is a self-defined flexible slot
      // (picnic / leftovers / eating out), not a real recipe whose fit can be
      // measured — drop it from scoring rather than always counting it right.
      if (r.planned?.is_placeholder) {
        excluded++; slotDetail.push({ date: r.plan_date, meal_type: r.meal_type, planned: (r.notes || '').trim() || 'Other', excluded: 'planned_other' }); continue
      }
      scorable++
      const k = r.plan_date + '|' + r.meal_type
      // MADE AS PLANNED — the owner logged "all good" (actually_made true, no
      // different recipe or note). UNTOUCHED — never logged at all; per the
      // owner's rule an unedited slot is ALSO deemed made as planned (an unedited
      // slot means the plan got it right, it just wasn't confirmed by hand).
      // Both are a full 3-point exact fit. Only a LOGGED DEVIATION can lose
      // points, and then the planned recipe still earns partial credit if it
      // turned up elsewhere that week.
      const madeAsPlanned = r.actually_made === true && !r.actual_recipe_id && (r.actual_notes || '').trim() === ''
      const untouched = r.actually_made === null && r.actual_recipe_id === null &&
        (r.actual_notes || '').trim() === '' &&
        !(Array.isArray(r.additional_recipes) && r.additional_recipes.length > 0)
      let score = 0, where = 'none'
      if (madeAsPlanned)                                   { score = 3; where = 'exact' }
      else if (untouched)                                  { score = 3; where = 'deemed'; deemed++ }
      else if (madeSlot.get(k)?.has(r.recipe_id))          { score = 3; where = 'exact' }
      else if (madeDay.get(r.plan_date)?.has(r.recipe_id)) { score = 2; where = 'same_day' }
      else if (madeWin.has(r.recipe_id))                   { score = 1; where = 'window' }
      earned += score
      // What was actually eaten. Made-as-planned / deemed show the planned recipe;
      // an "Other" deviation shows the typed free text (e.g. "leftover quesadillas").
      const actualName = (madeAsPlanned || untouched)
        ? plannedName
        : r.actual?.is_placeholder
          ? ((r.actual_notes || '').trim() || 'Other')
          : (r.actual?.name || (r.actually_made ? plannedName : null) || null)
      slotDetail.push({
        date: r.plan_date, day: DOW[dow], meal_type: r.meal_type,
        planned: plannedName,
        actual: actualName,
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
Per-slot results (score: 3 = made as planned in its slot, 2 = same day but a different meal, 1 = made later that week, 0 = a logged deviation that never happened that week). where:"deemed" means the owner never edited that slot — which the household treats as "the plan got it right, so I didn't need to touch it": count these as genuine successes, NOT as unknowns. ${deemed} of ${scorable} slots this week were deemed (unedited = plan was right). Points are ONLY lost where the owner LOGGED a deviation (where:"same_day"/"window"/"none"). An "actual" that is free text (e.g. "leftover quesadillas", "takeout") is an off-recipe meal the family had instead — a real signal about the shape of the week:
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
        assumed_slots: deemed,
        fit_percent: fitPercent, slot_detail: slotDetail, diagnosis,
      }, { onConflict: 'week_start' })
      .select().single()
    if (error) return json({ error: error.message }, 500)

    return json({ success: true, report: saved, excluded_slots: excluded })
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500)
  }
})

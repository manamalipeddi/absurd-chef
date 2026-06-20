import { supabase, FUNCTIONS_URL, toast, navigateTo, navState } from '../app.js'

// ── Slot config ───────────────────────────────────────────
const MEAL_SLOTS = [
  { type: 'breakfast', label: 'Breakfast', icon: '🍳' },
  { type: 'lunch',     label: 'Lunch',     icon: '🥗' },
  { type: 'dinner',    label: 'Dinner',    icon: '🍽️' },
  { type: 'snack',     label: 'Snack',     icon: '🍿' },
]

// Recipes for these meal_plan slot types come from these recipe categories
const RECIPE_CATEGORY = {
  breakfast: 'breakfast',
  lunch:     'lunch_dinner',
  dinner:    'lunch_dinner',
  snack:     'snack',
}

// ── State ─────────────────────────────────────────────────
let screenEl        = null
let allRecipes      = []   // for the recipe picker
let generating      = false
let householdCount  = 0
let currentStartDate = null  // start of the currently displayed plan window

// ── Date helpers ──────────────────────────────────────────
function addDays(s, n) {
  const d = new Date(s + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
function todayStr() { return new Date().toISOString().slice(0, 10) }
function thisWeekMonday() {
  const d = new Date(); d.setHours(12, 0, 0, 0)
  const dow = d.getDay()
  d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1))
  return d.toISOString().slice(0, 10)
}
function upcomingMonday() {
  const d = new Date(); d.setHours(12, 0, 0, 0)
  const dow = d.getDay()
  if (dow === 1) return d.toISOString().slice(0, 10)
  d.setDate(d.getDate() + (dow === 0 ? 1 : 8 - dow))
  return d.toISOString().slice(0, 10)
}
function fmtDate(s) {
  const d = new Date(s + 'T12:00:00Z')
  const dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()]
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]
  return `${dow} ${d.getUTCDate()} ${mon}`
}
function fmtDayMon(s) {
  const d = new Date(s + 'T12:00:00Z')
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]
  return `${d.getUTCDate()} ${mon}`
}
// ISO 8601 week number (weeks start Monday; week 1 contains the first Thursday).
function isoWeek(s) {
  const d = new Date(s + 'T12:00:00Z')
  const day = (d.getUTCDay() + 6) % 7        // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - day + 3)      // Thursday of this week
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4))
  const ft = (firstThu.getUTCDay() + 6) % 7
  firstThu.setUTCDate(firstThu.getUTCDate() - ft + 3)
  return 1 + Math.round((d - firstThu) / (7 * 86400000))
}

// ── Lifecycle ─────────────────────────────────────────────
export function init(el) {
  screenEl = el
  document.addEventListener('plan-updated', () => loadAndRender())
}

export async function activate({ headerLeft, headerRight }) {
  // Generation actions now live as labelled buttons in the plan body.
  headerRight.innerHTML = ''
  await loadAndRender()
}

// ── Data ──────────────────────────────────────────────────
async function getPlanWindow() {
  const monday = thisWeekMonday()
  const { count } = await supabase
    .from('meal_plans')
    .select('*', { count: 'exact', head: true })
    .gte('plan_date', monday)
    .lt('plan_date', addDays(monday, 7))
  const startDate = (count > 0) ? monday : upcomingMonday()
  return { startDate, endDate: addDays(startDate, 13) }
}

async function loadAndRender() {
  if (!screenEl) return
  screenEl.innerHTML = `<div class="loading-row"><div class="spinner"></div>Loading…</div>`

  const { startDate, endDate } = await getPlanWindow()
  currentStartDate = startDate
  const today = todayStr()
  // History covers past dinners older than the forward window (no overlap with
  // the current-week past days shown in the forward cards).
  const histBefore = startDate < today ? startDate : today
  const histFrom   = addDays(histBefore, -90)

  // planned + actual recipe both reference recipes — disambiguate by FK.
  const planSelect =
    'plan_date, meal_type, recipe_id, slot_locked, is_commute_day, is_holiday, is_preschool_closed, guest_count, ' +
    'actually_made, actual_recipe_id, actual_notes, ' +
    'recipes!meal_plans_recipe_id_fkey(id, name, emoji, serves_base), ' +
    'actual_recipe:recipes!meal_plans_actual_recipe_id_fkey(id, name, emoji)'

  const [planRes, specialRes, recipeRes, householdRes, schedLogRes, histRes] = await Promise.all([
    supabase
      .from('meal_plans')
      .select(planSelect)
      .gte('plan_date', startDate).lte('plan_date', endDate)
      .order('plan_date'),
    supabase
      .from('special_days')
      .select('day, type')
      .gte('day', startDate).lte('day', endDate),
    supabase
      .from('recipes')
      .select('id, name, meal_type, emoji')
      .eq('active', true)
      .order('name'),
    supabase
      .from('family_members')
      .select('id', { count: 'exact', head: true })
      .eq('is_default_household', true)
      .eq('active', true),
    supabase
      .from('plan_generation_log')
      .select('success, completed_at, started_at, error_message')
      .eq('triggered_by', 'scheduled')
      .order('started_at', { ascending: false })
      .limit(1),
    supabase
      .from('meal_plans')
      .select(planSelect)
      .eq('meal_type', 'dinner')
      .gte('plan_date', histFrom).lt('plan_date', histBefore)
      .order('plan_date', { ascending: false }),
  ])

  householdCount = householdRes.count ?? 0

  allRecipes = recipeRes.data || []

  const days = buildDayData(
    planRes.data  || [],
    specialRes.data || [],
    startDate
  )

  render(days, startDate, computeGenWarning(schedLogRes.data?.[0]), histRes.data || [])
}

// Decide whether to warn about scheduled generation. Returns null (all good),
// or { kind, msg }. Only fires when a scheduled row exists — a brand-new setup
// with no scheduled runs yet stays quiet until the first Sunday.
function computeGenWarning(row) {
  if (!row) return null
  if (row.success === false) return { kind: 'failed', msg: row.error_message }
  const ref = row.completed_at || row.started_at
  if (!ref) return null
  const ageDays = (Date.now() - new Date(ref).getTime()) / 86400000
  if (ageDays > 8) return { kind: 'overdue' }
  return null
}

function buildDayData(planRows, specialRows, startDate) {
  // special_days map: date → Set of types
  const specialMap = {}
  for (const s of specialRows) {
    if (!specialMap[s.day]) specialMap[s.day] = new Set()
    specialMap[s.day].add(s.type)
  }

  // plan rows grouped by date
  const planByDate = {}
  for (const row of planRows) {
    if (!planByDate[row.plan_date]) planByDate[row.plan_date] = { meta: {}, slots: {} }
    const entry = planByDate[row.plan_date]
    entry.slots[row.meal_type] = row
    // accumulate meta (any row for a date carries the day's context flags)
    if (row.is_holiday)          entry.meta.isHoliday        = true
    if (row.is_preschool_closed) entry.meta.isPreschoolClosed = true
    if (row.is_commute_day)      entry.meta.isCommute         = true
    if (row.guest_count > 0)     entry.meta.guestCount        = row.guest_count
  }

  return Array.from({ length: 14 }, (_, i) => {
    const date  = addDays(startDate, i)
    const entry = planByDate[date] || { meta: {}, slots: {} }
    const sset  = specialMap[date] || new Set()
    // Kids-home reflects LIVE special_days (kids_home/preschool_closed/holiday)
    // as well as the flags baked into the plan rows — so adding a kids-home day
    // shows immediately, without needing to regenerate the plan.
    const isKidsHome =
      entry.meta.isHoliday || entry.meta.isPreschoolClosed ||
      sset.has('kids_home') || sset.has('preschool_closed') || sset.has('holiday')
    return {
      date,
      slots: entry.slots,
      meta: {
        isHoliday:        entry.meta.isHoliday        || false,
        isPreschoolClosed: entry.meta.isPreschoolClosed || false,
        isKidsHome,
        isCommute:        entry.meta.isCommute         || false,
        guestCount:       entry.meta.guestCount        || 0,
        isGintasAway:     sset.has('gintas_away'),
      },
    }
  })
}

// ── Render ────────────────────────────────────────────────
function render(days, startDate, genWarning, history) {
  if (!screenEl) return
  screenEl.innerHTML = ''

  if (genWarning) screenEl.appendChild(buildGenBanner(genWarning))

  if (!days.some(d => Object.keys(d.slots).length > 0)) {
    screenEl.appendChild(buildEmpty())
    if (history && history.length) screenEl.appendChild(buildHistorySection(history))
    return
  }

  screenEl.appendChild(buildPlanSubhead(startDate))
  screenEl.appendChild(buildActionBar())

  const wrap = document.createElement('div')
  wrap.className = 'plan-cards'
  days.forEach(day => wrap.appendChild(buildDayCard(day)))
  screenEl.appendChild(wrap)

  if (history && history.length) screenEl.appendChild(buildHistorySection(history))
}

// Date range + ISO week numbers for the displayed 14-day window.
function buildPlanSubhead(startDate) {
  const endDate = addDays(startDate, 13)
  const w1 = isoWeek(startDate)
  const w2 = isoWeek(endDate)
  const weeks = w1 === w2 ? `Week ${w1}` : `Weeks ${w1}–${w2}`
  const el = document.createElement('div')
  el.className = 'plan-subhead'
  el.innerHTML = `
    <span class="plan-subhead__dates">${fmtDayMon(startDate)} – ${fmtDayMon(endDate)}</span>
    <span class="plan-subhead__weeks">${weeks}</span>`
  return el
}

// ── History (past actual outcomes) ────────────────────────
function buildHistorySection(historyRows) {
  const section = document.createElement('div')
  section.className = 'plan-history'

  const heading = document.createElement('div')
  heading.className = 'plan-history__heading'
  heading.textContent = '📜 History'
  section.appendChild(heading)

  const cards = document.createElement('div')
  cards.className = 'plan-cards'
  for (const row of historyRows) {
    // each history row is a single dinner entry; wrap it as a day for reuse
    const day = {
      date: row.plan_date,
      slots: { dinner: row },
      meta: {
        isHoliday: row.is_holiday || false,
        isPreschoolClosed: row.is_preschool_closed || false,
        isKidsHome: row.is_holiday || row.is_preschool_closed || false,
        isCommute: row.is_commute_day || false,
        guestCount: row.guest_count || 0,
        isGintasAway: false,
      },
    }
    cards.appendChild(buildDayCard(day, { history: true }))
  }
  section.appendChild(cards)
  return section
}

// Two generation actions near the top of the plan:
//  • Regenerate plan  — full_14 rebuild of the current window (current params)
//  • Generate next week — rolling_7 failsafe if Sunday's cron didn't run
function buildActionBar() {
  const bar = document.createElement('div')
  bar.className = 'plan-actionbar'

  const regen = document.createElement('button')
  regen.className = 'plan-roll-btn'
  regen.id = 'btn-regenerate'
  regen.innerHTML = '🔄 Regenerate plan'
  regen.addEventListener('click', onRegeneratePlan)

  const next = document.createElement('button')
  next.className = 'plan-roll-btn plan-roll-btn--alt'
  next.id = 'btn-roll-week'
  next.innerHTML = '📅 Generate next week'
  next.addEventListener('click', onRollNextWeek)

  bar.append(regen, next)
  return bar
}

// Proactive failure banner — tap to retry via the manual trigger.
function buildGenBanner(warning) {
  const banner = document.createElement('button')
  banner.className = 'plan-banner'
  banner.id = 'plan-gen-banner'
  banner.textContent = warning.kind === 'failed'
    ? "⚠ Last automatic update didn't complete — tap to retry"
    : "⚠ Automatic weekly update is overdue — tap to run it now"
  banner.addEventListener('click', onRollNextWeek)
  return banner
}

// ── Day card ──────────────────────────────────────────────
function buildDayCard(day, opts = {}) {
  const today = todayStr()
  const isPast = day.date < today
  const card  = document.createElement('div')
  card.className = 'day-card'
  if (day.date === today) card.classList.add('day-card--today')
  if (isPast)             card.classList.add('day-card--past')

  card.appendChild(buildContextStrip(day))
  card.appendChild(hr())

  // History cards are dinner-only and read-only; full cards show all slots.
  const slots = opts.history ? MEAL_SLOTS.filter(s => s.type === 'dinner') : MEAL_SLOTS
  slots.forEach(slot => card.appendChild(buildSlotRow(day.date, slot, day.slots[slot.type], day.meta, isPast)))

  // Past dinners get an outcome footer (confirm / correct / show actual).
  if (isPast) {
    const footer = buildOutcomeFooter(day)
    if (footer) card.appendChild(footer)
  }

  return card
}

// Outcome footer for a past dinner: confirm "made as planned", correct it, or
// display what was actually eaten once logged.
function buildOutcomeFooter(day) {
  const dinner = day.slots.dinner
  if (!dinner) return null

  const footer = document.createElement('div')
  footer.className = 'day-outcome'
  const am = dinner.actually_made

  if (am === true) {
    const tag = document.createElement('span')
    tag.className = 'day-outcome__confirmed'
    tag.textContent = '✅ Made as planned'
    footer.appendChild(tag)
  } else if (am === false) {
    const label = document.createElement('span')
    label.className = 'day-outcome__label'
    label.textContent = 'Actually made:'
    const actual = document.createElement('span')
    actual.className = 'day-outcome__actual'
    actual.textContent = dinner.actual_recipe?.name || dinner.actual_notes || 'Something different'
    footer.append(label, actual)
  } else {
    const made = document.createElement('button')
    made.className = 'day-outcome__btn'
    made.textContent = '✅ Made as planned'
    made.addEventListener('click', () => logMadeAsPlanned(day.date, 'dinner', dinner.recipe_id))

    const diff = document.createElement('button')
    diff.className = 'day-outcome__btn day-outcome__btn--alt'
    diff.textContent = '🔄 Made something different'
    diff.addEventListener('click', () => showOutcomePicker(day.date, 'dinner'))

    // Only offer "made as planned" when something was actually planned.
    if (dinner.recipe_id) footer.appendChild(made)
    footer.appendChild(diff)
  }
  return footer
}

function buildContextStrip(day) {
  const strip = document.createElement('div')
  strip.className = 'day-card__context'

  const date = document.createElement('span')
  date.className = 'day-card__date'
  date.textContent = fmtDate(day.date)
  strip.appendChild(date)

  const right = document.createElement('div')
  right.className = 'day-card__context-right'

  const badges = document.createElement('div')
  badges.className = 'day-card__badges'

  if (day.meta.isKidsHome)
    badges.appendChild(badge('🏠', 'Kids home'))
  if (day.meta.isCommute)
    badges.appendChild(badge('🚗', 'Commute'))
  if (day.meta.guestCount > 0)
    badges.appendChild(badge(`👥 ×${day.meta.guestCount}`, 'Guests'))
  if (day.meta.isGintasAway)
    badges.appendChild(badge('🍃', 'Light effort'))

  const discuss = document.createElement('button')
  discuss.className = 'day-card__discuss'
  discuss.textContent = '💬'
  discuss.title = 'Discuss this day'
  discuss.addEventListener('click', () => {
    navState.chatPrefill = `About ${fmtDate(day.date)}: `
    navigateTo('chat')
  })

  right.append(badges, discuss)
  strip.appendChild(right)
  return strip
}

function buildSlotRow(date, slot, entry, dayMeta, isPast = false) {
  const row = document.createElement('div')
  row.className = 'day-slot'

  const icon = document.createElement('span')
  icon.className = 'day-slot__icon'
  icon.setAttribute('aria-hidden', 'true')
  icon.textContent = slot.icon

  const label = document.createElement('span')
  label.className = 'day-slot__label'
  label.textContent = slot.label

  const val = document.createElement('div')
  val.className = 'day-slot__value'

  const hasRecipe = entry?.recipe_id && entry.recipes
  if (hasRecipe) {
    const name = document.createElement('span')
    name.className = 'day-slot__name'
    // Planned recipe is struck through when something different was made.
    if (entry.actually_made === false) name.classList.add('day-slot__name--struck')
    name.textContent = entry.recipes.name
    val.appendChild(name)

    if (!entry.slot_locked) {
      const ai = document.createElement('span')
      ai.className = 'day-slot__ai'
      ai.textContent = 'AI'
      val.appendChild(ai)
    }

    // Serving mismatch warning — only when there are guests that day
    const guestCount = dayMeta?.guestCount || 0
    if (guestCount > 0) {
      const serves = entry.recipes.serves_base
      const needed = householdCount + guestCount
      if (serves != null && serves < needed) {
        const warn = document.createElement('span')
        warn.className = 'day-slot__serves-warn'
        warn.title = `Recipe serves ${serves}, need ${needed} (household + ${guestCount} guests)`
        warn.textContent = `⚠ serves ${serves}`
        val.appendChild(warn)
      }
    }

    row.classList.add('day-slot--tap')
    row.addEventListener('click', () => {
      navState.recipeId = entry.recipe_id
      navigateTo('recipe-detail')
    })
  } else {
    const empty = document.createElement('span')
    empty.className = 'day-slot__empty'
    empty.textContent = '—'
    val.appendChild(empty)

    // Past days are read-only — no picker for empty slots.
    if (!isPast) {
      row.classList.add('day-slot--tap')
      row.addEventListener('click', () => showPicker(date, slot.type))
    }
  }

  row.append(icon, label, val)
  return row
}


function buildEmpty() {
  const wrap = document.createElement('div')
  wrap.className = 'placeholder-wrap'
  wrap.innerHTML = `
    <div class="placeholder-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round"
          d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5"/>
      </svg>
    </div>
    <p class="placeholder-label">No plan yet</p>
    <p class="placeholder-sub">Generate a 2-week dinner plan for your family</p>
    <button class="btn-primary" id="btn-gen-empty">Generate plan</button>`
  wrap.querySelector('#btn-gen-empty').addEventListener('click', onGenerate)
  return wrap
}

// ── Recipe picker ─────────────────────────────────────────
function showPicker(date, slotType) {
  const category = RECIPE_CATEGORY[slotType]
  const pool     = allRecipes.filter(r => r.meal_type === category)
  const label    = MEAL_SLOTS.find(s => s.type === slotType)?.label || slotType

  const overlay = document.createElement('div')
  overlay.className = 'picker-overlay'

  const sheet = document.createElement('div')
  sheet.className = 'picker-sheet'

  const head = document.createElement('div')
  head.className = 'picker-header'
  head.innerHTML = `
    <span class="picker-title">Choose ${label}</span>
    <button class="picker-close" aria-label="Close">✕</button>`
  head.querySelector('.picker-close').addEventListener('click', () => overlay.remove())
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove() })

  const search = document.createElement('input')
  search.type = 'text'
  search.className = 'picker-search'
  search.placeholder = 'Search recipes…'

  const list = document.createElement('div')
  list.className = 'picker-list'

  function renderList(q) {
    const lq = q.toLowerCase()
    const hits = lq ? pool.filter(r => r.name.toLowerCase().includes(lq)) : pool
    list.innerHTML = ''
    if (!hits.length) {
      list.innerHTML = `<p class="picker-empty">No recipes found</p>`
      return
    }
    for (const r of hits) {
      const row = document.createElement('button')
      row.className = 'picker-row'
      row.innerHTML = `
        <span class="picker-row__emoji" aria-hidden="true">${r.emoji || slotEmoji(slotType)}</span>
        <span class="picker-row__name">${r.name}</span>`
      row.addEventListener('click', async () => {
        overlay.remove()
        await savePick(date, slotType, r.id)
      })
      list.appendChild(row)
    }
  }

  search.addEventListener('input', () => renderList(search.value))
  renderList('')

  sheet.append(head, search, list)
  overlay.appendChild(sheet)
  document.body.appendChild(overlay)
  requestAnimationFrame(() => search.focus())
}

async function savePick(date, slotType, recipeId) {
  const { error } = await supabase.from('meal_plans').upsert({
    plan_date:   date,
    meal_type:   slotType,
    recipe_id:   recipeId,
    slot_locked: true,
  }, { onConflict: 'plan_date,meal_type' })

  if (error) { toast('Failed to save', { error: true }); return }

  await supabase.from('plan_edits').insert({
    plan_date:        date,
    meal_type:        slotType,
    new_recipe_id:    recipeId,
    edit_source:      'manual',
    instruction_text: 'Manual pick from recipe picker',
  })

  await loadAndRender()
}

// ── Actual-outcome logging ────────────────────────────────
async function logMadeAsPlanned(date, mealType, plannedRecipeId) {
  const { error } = await supabase.from('meal_plans')
    .update({ actually_made: true, actual_recipe_id: null, actual_notes: null })
    .eq('plan_date', date).eq('meal_type', mealType)
  if (error) { toast('Failed to save', { error: true }); return }
  // Keep recipe recency truthful for no-repeat.
  if (plannedRecipeId) await supabase.from('recipes').update({ last_made: date }).eq('id', plannedRecipeId)
  toast('Logged — made as planned')
  await loadAndRender()
}

async function logMadeDifferent(date, mealType, { recipeId = null, notes = null }) {
  const { error } = await supabase.from('meal_plans')
    .update({ actually_made: false, actual_recipe_id: recipeId, actual_notes: notes })
    .eq('plan_date', date).eq('meal_type', mealType)
  if (error) { toast('Failed to save', { error: true }); return }
  if (recipeId) await supabase.from('recipes').update({ last_made: date }).eq('id', recipeId)
  toast('Logged what you actually made')
  await loadAndRender()
}

// Picker for "made something different" — pick a tracked recipe, or log a
// free-text note for an untracked meal (takeout, leftovers, etc.).
function showOutcomePicker(date, mealType) {
  const pool = allRecipes.filter(r => r.meal_type === RECIPE_CATEGORY[mealType])

  const overlay = document.createElement('div')
  overlay.className = 'picker-overlay'
  const sheet = document.createElement('div')
  sheet.className = 'picker-sheet'

  const head = document.createElement('div')
  head.className = 'picker-header'
  head.innerHTML = `
    <span class="picker-title">What did you actually make?</span>
    <button class="picker-close" aria-label="Close">✕</button>`
  head.querySelector('.picker-close').addEventListener('click', () => overlay.remove())
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove() })

  // Free-text row for an untracked meal.
  const noteRow = document.createElement('div')
  noteRow.className = 'picker-note-row'
  const noteInput = document.createElement('input')
  noteInput.type = 'text'
  noteInput.className = 'picker-search'
  noteInput.placeholder = 'Or type it (e.g. takeout, leftovers)…'
  const noteBtn = document.createElement('button')
  noteBtn.className = 'picker-note-save'
  noteBtn.textContent = 'Save'
  noteBtn.addEventListener('click', async () => {
    const txt = noteInput.value.trim()
    if (!txt) return
    overlay.remove()
    await logMadeDifferent(date, mealType, { notes: txt })
  })
  noteRow.append(noteInput, noteBtn)

  const search = document.createElement('input')
  search.type = 'text'
  search.className = 'picker-search'
  search.placeholder = 'Search recipes…'

  const list = document.createElement('div')
  list.className = 'picker-list'

  function renderList(q) {
    const lq = q.toLowerCase()
    const hits = lq ? pool.filter(r => r.name.toLowerCase().includes(lq)) : pool
    list.innerHTML = ''
    if (!hits.length) { list.innerHTML = `<p class="picker-empty">No recipes found</p>`; return }
    for (const r of hits) {
      const row = document.createElement('button')
      row.className = 'picker-row'
      row.innerHTML = `
        <span class="picker-row__emoji" aria-hidden="true">${r.emoji || slotEmoji(mealType)}</span>
        <span class="picker-row__name">${r.name}</span>`
      row.addEventListener('click', async () => {
        overlay.remove()
        await logMadeDifferent(date, mealType, { recipeId: r.id })
      })
      list.appendChild(row)
    }
  }
  search.addEventListener('input', () => renderList(search.value))
  renderList('')

  sheet.append(head, search, list, noteRow)
  overlay.appendChild(sheet)
  document.body.appendChild(overlay)
  requestAnimationFrame(() => search.focus())
}

// ── Generate ──────────────────────────────────────────────
async function onGenerate() {
  if (generating) return
  generating = true
  const btn = document.getElementById('btn-generate')
  if (btn) { btn.disabled = true; btn.innerHTML = `<div class="spinner"></div>` }

  try {
    const res  = await fetch(`${FUNCTIONS_URL}/plan-generator`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'full_14', start_date: upcomingMonday() }),
    })
    const json = await res.json()
    if (!json.success) throw new Error(json.error || 'Generation failed')
    toast(`Plan generated — ${json.days_planned} days`)
    if (json.unresolved?.length)
      setTimeout(() => toast(`${json.unresolved.length} day(s) need input — check Chat`, { duration: 5000 }), 600)
    await loadAndRender()
  } catch (e) {
    toast(e.message || 'Generation failed', { error: true })
  } finally {
    generating = false
    const btn  = document.getElementById('btn-generate')
    if (btn) { btn.disabled = false; btn.innerHTML = sparklesSvg() }
  }
}

// Manual rolling trigger — extend the plan by 7 days on demand (recovery /
// testing). Same function, logic and lock-respect as the Sunday schedule.
async function onRollNextWeek() {
  if (generating) return
  generating = true
  const btn    = document.getElementById('btn-roll-week')
  const banner = document.getElementById('plan-gen-banner')
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner spinner--sm"></span> Generating…` }
  if (banner) { banner.disabled = true; banner.textContent = '⏳ Generating next week…' }

  try {
    const res  = await fetch(`${FUNCTIONS_URL}/plan-generator`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'rolling_7', triggered_by: 'manual' }),
    })
    const json = await res.json()
    if (!json.success) throw new Error(json.error || 'Generation failed')
    toast(`Next week generated — ${json.days_planned} day(s)`)
    if (json.unresolved?.length)
      setTimeout(() => toast(`${json.unresolved.length} day(s) need input — check Chat`, { duration: 5000 }), 600)
    generating = false
    await loadAndRender()   // rebuilds the screen (and clears the banner)
    return
  } catch (e) {
    toast(`Couldn't generate next week: ${e.message || 'unknown error'}. Try again, or ask in Chat.`, { error: true, duration: 6000 })
    if (btn) { btn.disabled = false; btn.innerHTML = '📅 Generate next week' }
    if (banner) { banner.disabled = false; banner.textContent = "⚠ Last automatic update didn't complete — tap to retry" }
  } finally {
    generating = false
  }
}

// Regenerate the whole current 14-day window from current parameters
// (full_14, respects locked slots). Logged as a manual run.
async function onRegeneratePlan() {
  if (generating) return
  if (!confirm('Regenerate the current plan from your current settings? Locked days stay as they are.')) return
  generating = true
  const btn = document.getElementById('btn-regenerate')
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner spinner--sm"></span> Regenerating…` }

  try {
    const res  = await fetch(`${FUNCTIONS_URL}/plan-generator`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'full_14', start_date: currentStartDate, triggered_by: 'manual' }),
    })
    const json = await res.json()
    if (!json.success) throw new Error(json.error || 'Generation failed')
    toast(`Plan regenerated — ${json.days_planned} day(s)`)
    if (json.unresolved?.length)
      setTimeout(() => toast(`${json.unresolved.length} day(s) need input — check Chat`, { duration: 5000 }), 600)
    generating = false
    await loadAndRender()
    return
  } catch (e) {
    toast(`Couldn't regenerate: ${e.message || 'unknown error'}. Try again, or ask in Chat.`, { error: true, duration: 6000 })
    if (btn) { btn.disabled = false; btn.innerHTML = '🔄 Regenerate plan' }
  } finally {
    generating = false
  }
}

// ── Micro helpers ─────────────────────────────────────────
function hr() {
  const el = document.createElement('div')
  el.className = 'day-card__hr'
  return el
}

function badge(text, title) {
  const el = document.createElement('span')
  el.className = 'day-badge'
  el.title = title
  el.textContent = text
  return el
}

function slotEmoji(slotType) {
  return { breakfast: '🍳', lunch: '🥗', dinner: '🍽️', snack: '🍿' }[slotType] || '🍽️'
}

function sparklesSvg() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <path stroke-linecap="round" stroke-linejoin="round"
      d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z"/>
  </svg>`
}

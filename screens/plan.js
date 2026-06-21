import { supabase, FUNCTIONS_URL, toast, navigateTo, navState, openModal, closeModal } from '../app.js'

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
let lastRenderDay   = null  // todayStr() at last render — detects day rollover
let otherRecipe     = null  // the "Other" placeholder recipe (always pinned in picker)

// ── Date helpers ──────────────────────────────────────────
function addDays(s, n) {
  const d = new Date(s + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
function daysBetween(a, b) {
  return Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000)
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
  // If the app was left open across midnight, re-anchor to the new day when it
  // comes back to the foreground — otherwise "today" (and any generation
  // triggered from this view) would still reference the stale day.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    if (!screenEl?.classList.contains('screen--active')) return
    if (lastRenderDay && lastRenderDay !== todayStr()) loadAndRender()
  })
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
  // End of window is dynamic: at least 14 days, but extended to cover however
  // far the plan actually reaches (rolling generation grows it past +13).
  let endDate = addDays(startDate, 13)
  const { data: latest } = await supabase
    .from('meal_plans')
    .select('plan_date')
    .gte('plan_date', startDate)
    .order('plan_date', { ascending: false })
    .limit(1)
  const maxDate = latest?.[0]?.plan_date
  if (maxDate && maxDate > endDate) endDate = maxDate
  return { startDate, endDate }
}

async function loadAndRender() {
  if (!screenEl) return
  screenEl.innerHTML = `<div class="loading-row"><div class="spinner"></div>Loading…</div>`

  const { startDate, endDate } = await getPlanWindow()
  currentStartDate = startDate
  const today = todayStr()
  lastRenderDay = today
  // History = everything strictly before today (incl. this week's earlier days);
  // upcoming section is today forward.
  const histBefore = today
  const histFrom   = addDays(today, -90)

  // planned + actual recipe both reference recipes — disambiguate by FK.
  const planSelect =
    'plan_date, meal_type, recipe_id, slot_locked, is_commute_day, is_holiday, is_preschool_closed, guest_count, ' +
    'notes, actually_made, actual_recipe_id, actual_notes, ' +
    'recipes!meal_plans_recipe_id_fkey(id, name, emoji, serves_base, is_placeholder), ' +
    'actual_recipe:recipes!meal_plans_actual_recipe_id_fkey(id, name, emoji, is_placeholder)'

  const [planRes, dsRes, recipeRes, householdRes, schedLogRes, histRes] = await Promise.all([
    supabase
      .from('meal_plans')
      .select(planSelect)
      .gte('plan_date', startDate).lte('plan_date', endDate)
      .order('plan_date'),
    // day_settings spans history → end so notes are available on every card.
    supabase
      .from('day_settings')
      .select('day, is_commute_day, kids_home, gintas_away, is_vacation, guest_count, note')
      .gte('day', histFrom).lte('day', endDate),
    supabase
      .from('recipes')
      .select('id, name, meal_type, emoji, is_placeholder')
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
    // History: ALL meal types (not just dinner) so every logged slot shows.
    supabase
      .from('meal_plans')
      .select(planSelect)
      .gte('plan_date', histFrom).lt('plan_date', histBefore)
      .order('plan_date', { ascending: false }),
  ])

  householdCount = householdRes.count ?? 0
  allRecipes = recipeRes.data || []
  otherRecipe = allRecipes.find(r => r.is_placeholder) || null

  const dsRows = dsRes.data || []
  const noteMap = {}
  for (const d of dsRows) if (d.note) noteMap[d.day] = d.note

  // Span the full window (>= 14 days, extended to the plan's real extent).
  const windowDays = Math.max(14, daysBetween(startDate, endDate) + 1)
  const days = buildDayData(planRes.data || [], dsRows, startDate, windowDays)

  render(days, startDate, computeGenWarning(schedLogRes.data?.[0]), histRes.data || [], noteMap)

  // Restore scroll when returning from Recipe Detail (back navigation).
  if (navState.scrollPlan != null) {
    const top = navState.scrollPlan; navState.scrollPlan = null
    requestAnimationFrame(() => { screenEl.scrollTop = top })
  }
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

function buildDayData(planRows, daySettingsRows, startDate, dayCount = 14) {
  // day_settings is the single source of truth for per-day context (live).
  const dsMap = {}
  for (const d of daySettingsRows) dsMap[d.day] = d

  // plan rows grouped by date (recipes/notes/outcome only — context is from day_settings)
  const planByDate = {}
  for (const row of planRows) {
    if (!planByDate[row.plan_date]) planByDate[row.plan_date] = { slots: {} }
    planByDate[row.plan_date].slots[row.meal_type] = row
  }

  return Array.from({ length: dayCount }, (_, i) => {
    const date  = addDays(startDate, i)
    const entry = planByDate[date] || { slots: {} }
    const ds    = dsMap[date]
    const dow   = new Date(date + 'T12:00:00Z').getUTCDay()
    // Read-time defaults where no day_settings row exists: kids_home true on weekends.
    return {
      date,
      slots: entry.slots,
      meta: {
        isKidsHome:   ds ? !!ds.kids_home    : (dow === 0 || dow === 6),
        isCommute:    ds ? !!ds.is_commute_day : false,
        isVacation:   ds ? !!ds.is_vacation  : false,
        guestCount:   ds ? (ds.guest_count || 0) : 0,
        isGintasAway: ds ? !!ds.gintas_away  : false,
        note:         ds?.note || null,
      },
    }
  })
}

// ── Render ────────────────────────────────────────────────
// Order: upcoming days (today forward) → History (past) → generation buttons.
function render(days, startDate, genWarning, history, noteMap = {}) {
  if (!screenEl) return
  screenEl.innerHTML = ''

  if (genWarning) screenEl.appendChild(buildGenBanner(genWarning))

  const today = todayStr()
  const upcoming = days.filter(d => d.date >= today)
  const hasPlan = days.some(d => Object.keys(d.slots).length > 0)

  if (!hasPlan) {
    screenEl.appendChild(buildEmpty())
    if (history && history.length) screenEl.appendChild(buildHistorySection(history, noteMap))
    screenEl.appendChild(buildActionBar())
    return
  }

  screenEl.appendChild(buildPlanSubhead(upcoming[0]?.date || startDate, addDays(startDate, 13)))

  const wrap = document.createElement('div')
  wrap.className = 'plan-cards'
  upcoming.forEach((day, i) => {
    // Week divider before each Monday and before the very first upcoming card.
    const isMon = new Date(day.date + 'T12:00:00Z').getUTCDay() === 1
    if (isMon || i === 0) wrap.appendChild(buildWeekDivider(day.date))
    wrap.appendChild(buildDayCard(day, { note: noteMap[day.date] }))
  })
  screenEl.appendChild(wrap)

  if (history && history.length) screenEl.appendChild(buildHistorySection(history, noteMap))

  // Low-frequency actions live at the very bottom.
  screenEl.appendChild(buildActionBar())
}

function weekLabel(date) {
  const w   = isoWeek(date)
  const twm = thisWeekMonday()
  if (date === twm)              return `Current Week ${w}`
  if (date === addDays(twm, 7))  return `Next Week ${w}`
  return `Week ${w}`
}

function buildWeekDivider(date) {
  const el = document.createElement('div')
  el.className = 'plan-week-divider'
  el.textContent = weekLabel(date)
  return el
}

// Date range + ISO week numbers for the displayed window.
function buildPlanSubhead(startDate, endDate) {
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
function buildHistorySection(historyRows, noteMap = {}) {
  const section = document.createElement('div')
  section.className = 'plan-history'

  const heading = document.createElement('div')
  heading.className = 'plan-history__heading'
  heading.textContent = '📜 History'
  section.appendChild(heading)

  // Group all meal rows by date so each history card shows every logged slot
  // (breakfast/lunch/dinner/snack), not just dinner. Rows arrive newest-first.
  const byDate = new Map()
  for (const row of historyRows) {
    if (!byDate.has(row.plan_date)) {
      byDate.set(row.plan_date, {
        date: row.plan_date,
        slots: {},
        meta: {
          isKidsHome: row.is_holiday || row.is_preschool_closed || false,
          isCommute: row.is_commute_day || false,
          guestCount: row.guest_count || 0,
          isGintasAway: false,
          note: noteMap[row.plan_date] || null,
        },
      })
    }
    byDate.get(row.plan_date).slots[row.meal_type] = row
  }

  const cards = document.createElement('div')
  cards.className = 'plan-cards'
  for (const day of byDate.values()) {
    cards.appendChild(buildDayCard(day, { history: true, note: noteMap[day.date] }))
  }
  section.appendChild(cards)
  return section
}

// Two low-frequency generation actions, anchored at the very bottom of the tab.
//  • Regenerate Full Plan — full_14 rebuild of the whole visible plan
//  • Plan Week [N]        — rolling_7; N = the upcoming ISO week it generates
function buildActionBar() {
  const bar = document.createElement('div')
  bar.className = 'plan-actionbar plan-actionbar--bottom'

  const regen = document.createElement('button')
  regen.className = 'plan-roll-btn'
  regen.id = 'btn-regenerate'
  regen.innerHTML = '🔄 Regenerate Full Plan'
  regen.addEventListener('click', onRegeneratePlan)

  // rolling_7 writes days 8–14 from the current week's Monday → next week.
  const nextWeekNo = isoWeek(addDays(thisWeekMonday(), 7))
  const next = document.createElement('button')
  next.className = 'plan-roll-btn plan-roll-btn--alt'
  next.id = 'btn-roll-week'
  next.innerHTML = `📅 Plan Week ${nextWeekNo}`
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
  const isToday = day.date === today
  const card  = document.createElement('div')
  card.className = 'day-card'
  if (isToday) card.classList.add('day-card--today')
  if (isPast)  card.classList.add('day-card--past')

  card.appendChild(buildContextStrip(day))
  // Day-level note (every card): shown if present, tappable to view/edit.
  if (day.meta.note) card.appendChild(buildDayNote(day.date, day.meta.note))

  // Vacation day: deliberate absence of a plan — no meal rows, a clear label.
  if (day.meta.isVacation) {
    card.classList.add('day-card--vacation')
    const v = document.createElement('div')
    v.className = 'day-vacation'
    v.textContent = '🏖 Vacation — no plan needed'
    card.appendChild(v)
    return card
  }

  card.appendChild(hr())

  // All four meal slots on every card — upcoming AND history. (History was once
  // dinner-only, which hid real logged breakfast/lunch/snack outcomes.)
  MEAL_SLOTS.forEach(slot => {
    const entry = day.slots[slot.type]
    card.appendChild(buildSlotRow(day.date, slot, entry, day.meta, isPast))
    if (entry?.notes && !(entry.recipes && entry.recipes.is_placeholder)) card.appendChild(buildSlotNote(entry.notes))
  })

  return card
}

// Resolve what to show for a slot: the actual outcome if logged different,
// otherwise the planned recipe. "Other" placeholder renders its free text.
// Returns null when there's nothing to show. recipeIdForNav is null for Other.
function slotDisplay(entry) {
  if (!entry) return null
  if (entry.actually_made === false) {
    const ar = entry.actual_recipe
    if (entry.actual_recipe_id && ar) {
      if (ar.is_placeholder) return { name: entry.actual_notes || 'Other', nav: null, actual: true }
      return { name: ar.name, nav: entry.actual_recipe_id, actual: true }
    }
    if (entry.actual_notes) return { name: entry.actual_notes, nav: null, actual: true }
  }
  const r = entry.recipes
  if (entry.recipe_id && r) {
    if (r.is_placeholder) return { name: entry.notes || 'Other', nav: null, actual: false }
    return { name: r.name, nav: entry.recipe_id, actual: false }
  }
  return null
}

// Day-level free-form note display (tap to edit).
function buildDayNote(date, text) {
  const el = document.createElement('button')
  el.className = 'day-note'
  el.innerHTML = `<span class="day-note__icon">📝</span><span class="day-note__text"></span>`
  el.querySelector('.day-note__text').textContent = text
  el.addEventListener('click', () => openNoteEditor(date, text))
  return el
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

  if (day.meta.isVacation) {
    badges.appendChild(badge('🏖', 'Vacation'))
  } else {
    if (day.meta.isKidsHome)
      badges.appendChild(badge('🏠', 'Kids home'))
    if (day.meta.isCommute)
      badges.appendChild(badge('🚗', 'Commute'))
    if (day.meta.guestCount > 0)
      badges.appendChild(badge(`👥 ×${day.meta.guestCount}`, 'Guests'))
    if (day.meta.isGintasAway)
      badges.appendChild(badge('🍃', 'Light effort'))
  }

  const noteBtn = document.createElement('button')
  noteBtn.className = 'day-card__notebtn' + (day.meta.note ? ' day-card__notebtn--on' : '')
  noteBtn.textContent = '📝'   // note icon only — no "+" affordance
  noteBtn.title = day.meta.note ? 'Edit note' : 'Add a note'
  noteBtn.addEventListener('click', () => openNoteEditor(day.date, day.meta.note || ''))

  const discuss = document.createElement('button')
  discuss.className = 'day-card__discuss'
  discuss.textContent = '💬'
  discuss.title = 'Discuss this day'
  discuss.addEventListener('click', () => {
    navState.chatPrefill = `About ${fmtDate(day.date)}: `
    navigateTo('chat')
  })

  right.append(badges, noteBtn, discuss)
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

  const disp = slotDisplay(entry)
  if (disp) {
    const name = document.createElement('span')
    name.className = 'day-slot__name'
    name.textContent = disp.name
    val.appendChild(name)

    if (entry.recipe_id && !entry.slot_locked && !disp.actual) {
      const ai = document.createElement('span')
      ai.className = 'day-slot__ai'
      ai.textContent = 'AI'
      val.appendChild(ai)
    }

    // Serving mismatch warning — only when there are guests that day
    const guestCount = dayMeta?.guestCount || 0
    if (guestCount > 0 && entry.recipes && !entry.recipes.is_placeholder) {
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

    // Name tap → Recipe Detail (only for a real, navigable recipe).
    if (disp.nav) {
      row.classList.add('day-slot--tap')
      row.addEventListener('click', () => {
        navState.recipeId = disp.nav
        navState.recipeFrom = 'plan'
        navState.scrollPlan = screenEl.scrollTop
        navigateTo('recipe-detail')
      })
    }

    // The single 🔄 action — present on every filled slot. Date decides intent:
    // future = change the plan; today/past = log what actually happened.
    // 🔄 (blue on Apple) deliberately, not 🔁 (orange) — matches the app palette.
    const swap = document.createElement('button')
    swap.className = 'day-slot__swap'
    swap.textContent = '🔄'
    swap.title = 'Change / log this meal'
    swap.addEventListener('click', (e) => { e.stopPropagation(); showPicker(date, slot.type) })
    val.appendChild(swap)
  } else {
    const empty = document.createElement('span')
    empty.className = 'day-slot__empty'
    empty.textContent = ''
    val.appendChild(empty)

    // Empty slots are tappable today/future (plan or log); past empties stay read-only.
    if (date >= todayStr()) {
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

// ── Recipe picker (date-aware) ────────────────────────────
// Future date → change the PLAN (recipe_id + slot_locked). Today/past → LOG
// what actually happened (actual_recipe_id + actually_made = false). "Other"
// is always pinned and leads to a free-text entry.
function showPicker(date, slotType) {
  const isActual = date <= todayStr()   // today or past = logging reality
  const category = RECIPE_CATEGORY[slotType]
  const pool     = allRecipes.filter(r => r.meal_type === category && !r.is_placeholder)
  const label    = MEAL_SLOTS.find(s => s.type === slotType)?.label || slotType

  const overlay = document.createElement('div'); overlay.className = 'picker-overlay'
  const sheet = document.createElement('div'); sheet.className = 'picker-sheet'
  const head = document.createElement('div'); head.className = 'picker-header'
  head.innerHTML = `
    <span class="picker-title">${isActual ? 'What did you have' : 'Choose'} — ${label}</span>
    <button class="picker-close" aria-label="Close">✕</button>`
  head.querySelector('.picker-close').addEventListener('click', () => closeModal(overlay))
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(overlay) })

  const search = document.createElement('input')
  search.type = 'text'; search.className = 'picker-search'; search.placeholder = 'Search recipes…'

  const list = document.createElement('div'); list.className = 'picker-list'

  function pickRow(emoji, name, onClick, cls) {
    const row = document.createElement('button')
    row.className = 'picker-row' + (cls ? ' ' + cls : '')
    row.innerHTML = `<span class="picker-row__emoji" aria-hidden="true">${emoji}</span><span class="picker-row__name">${name}</span>`
    row.addEventListener('click', onClick)
    return row
  }

  function renderList(q) {
    const lq = q.toLowerCase()
    const hits = lq ? pool.filter(r => r.name.toLowerCase().includes(lq)) : pool
    list.innerHTML = ''
    for (const r of hits) {
      list.appendChild(pickRow(r.emoji || slotEmoji(slotType), r.name, async () => {
        closeModal(overlay); await applyPick(date, slotType, r.id, isActual, null)
      }))
    }
    // "Other" is always present, regardless of search term or meal_type.
    if (otherRecipe) {
      list.appendChild(pickRow(otherRecipe.emoji || '❓', 'Other — something not in my recipes',
        () => showOtherInput(), 'picker-row--other'))
    }
  }

  // Free-text entry for "Other", in-modal (replaces the list).
  function showOtherInput() {
    list.innerHTML = ''
    search.style.display = 'none'
    const wrap = document.createElement('div'); wrap.className = 'picker-other'
    const lbl = document.createElement('div'); lbl.className = 'su-label'
    lbl.textContent = isActual ? 'What did you actually have?' : 'What are you planning?'
    const lblEl = document.createElement('div'); lblEl.className = 'picker-other__label'; lblEl.textContent = lbl.textContent
    const ta = document.createElement('input'); ta.type = 'text'; ta.className = 'picker-search'
    ta.placeholder = 'e.g. Picnic lunch in the park'
    const save = document.createElement('button'); save.className = 'su-btn-primary picker-other__save'; save.textContent = 'Save'
    save.addEventListener('click', async () => {
      closeModal(overlay); await applyPick(date, slotType, otherRecipe.id, isActual, ta.value.trim() || null)
    })
    wrap.append(lblEl, ta, save)
    list.appendChild(wrap)
    requestAnimationFrame(() => ta.focus())
  }

  search.addEventListener('input', () => renderList(search.value))
  renderList('')

  // Distinct action: clear the slot entirely (delete the row → empty slot).
  const clearBtn = document.createElement('button')
  clearBtn.className = 'picker-clear'
  clearBtn.textContent = '✕ Clear this slot (no meal planned)'
  clearBtn.addEventListener('click', async () => { closeModal(overlay); await clearSlot(date, slotType) })

  sheet.append(head, search, list, clearBtn)
  overlay.appendChild(sheet)
  document.body.appendChild(overlay)
  openModal(overlay, () => overlay.remove())
  // Deliberately NOT auto-focusing the search — keep the keyboard closed until
  // the user taps into the field, so it doesn't immediately obscure the list.
}

// Delete the meal_plans row for this date+meal_type → slot returns to empty,
// available for manual re-pick or the generator to fill on a future replan.
async function clearSlot(date, slotType) {
  const { error } = await supabase.from('meal_plans')
    .delete().eq('plan_date', date).eq('meal_type', slotType)
  if (error) { toast('Failed to clear', { error: true }); return }
  toast('Slot cleared')
  await loadAndRender()
}

// Single save path for both plan changes and actual-outcome logging.
async function applyPick(date, slotType, recipeId, isActual, otherText) {
  let error
  if (isActual) {
    // Logging reality: actual_recipe_id (+ optional free text for "Other").
    ;({ error } = await supabase.from('meal_plans').upsert({
      plan_date: date, meal_type: slotType,
      actually_made: false, actual_recipe_id: recipeId, actual_notes: otherText,
    }, { onConflict: 'plan_date,meal_type' }))
  } else {
    // Changing the plan itself (future day): recipe_id + lock; reset any actuals.
    ;({ error } = await supabase.from('meal_plans').upsert({
      plan_date: date, meal_type: slotType,
      recipe_id: recipeId, slot_locked: true, notes: otherText,
      actually_made: null, actual_recipe_id: null, actual_notes: null,
    }, { onConflict: 'plan_date,meal_type' }))
    await supabase.from('plan_edits').insert({
      plan_date: date, meal_type: slotType, new_recipe_id: recipeId,
      edit_source: 'manual', instruction_text: 'Manual pick from recipe picker',
    })
  }
  if (error) { toast('Failed to save', { error: true }); return }
  // Keep recipe recency truthful for no-repeat — but never for the placeholder.
  if (recipeId && recipeId !== otherRecipe?.id) await supabase.from('recipes').update({ last_made: date }).eq('id', recipeId)
  toast(isActual ? 'Logged' : 'Plan updated')
  await loadAndRender()
}

// Day-level free-form note editor. Writes day_settings.note only — no replan,
// no effect on no-repeat. Preserves the weekend kids_home default when the row
// doesn't exist yet (so adding a note never silently flips a weekend off).
function openNoteEditor(date, existing) {
  const overlay = document.createElement('div'); overlay.className = 'picker-overlay'
  const sheet = document.createElement('div'); sheet.className = 'picker-sheet note-sheet'
  const head = document.createElement('div'); head.className = 'picker-header'
  head.innerHTML = `<span class="picker-title">Note — ${fmtDate(date)}</span><button class="picker-close">✕</button>`
  head.querySelector('.picker-close').addEventListener('click', () => closeModal(overlay))
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(overlay) })

  const ta = document.createElement('textarea')
  ta.className = 'note-sheet__input'
  ta.placeholder = 'e.g. kids were sick, hectic week, simplified everything…'
  ta.value = existing || ''

  const save = document.createElement('button')
  save.className = 'su-btn-primary note-sheet__save'
  save.textContent = 'Save note'
  save.addEventListener('click', async () => {
    const note = ta.value.trim() || null
    save.disabled = true
    const { data: row } = await supabase.from('day_settings').select('id').eq('day', date).maybeSingle()
    let error
    if (row) {
      ;({ error } = await supabase.from('day_settings').update({ note, updated_at: new Date().toISOString() }).eq('day', date))
    } else {
      const wd = new Date(date + 'T12:00:00Z').getUTCDay()
      ;({ error } = await supabase.from('day_settings').insert({
        day: date, note, kids_home: wd === 0 || wd === 6,
        is_commute_day: false, gintas_away: false, guest_count: 0,
      }))
    }
    if (error) { toast('Save failed', { error: true }); save.disabled = false; return }
    toast(note ? 'Note saved' : 'Note cleared')
    closeModal(overlay)
    await loadAndRender()
  })

  sheet.append(head, ta, save)
  overlay.appendChild(sheet)
  document.body.appendChild(overlay)
  openModal(overlay, () => overlay.remove())
  requestAnimationFrame(() => ta.focus())
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
    // Recompute the window now (not from cached state) so a session left open
    // across a day/week boundary still generates from the correct Monday.
    const { startDate } = await getPlanWindow()
    const res  = await fetch(`${FUNCTIONS_URL}/plan-generator`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'full_14', start_date: startDate, triggered_by: 'manual' }),
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

function buildSlotNote(text) {
  const el = document.createElement('div')
  el.className = 'day-slot-note'
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

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
let screenEl    = null
let allRecipes  = []   // for the recipe picker
let generating  = false

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

// ── Lifecycle ─────────────────────────────────────────────
export function init(el) {
  screenEl = el
  document.addEventListener('plan-updated', () => loadAndRender())
}

export async function activate({ headerLeft, headerRight }) {
  headerRight.innerHTML = `
    <button class="header-btn" id="btn-generate" aria-label="Generate plan">
      ${sparklesSvg()}
    </button>`
  document.getElementById('btn-generate').addEventListener('click', onGenerate)
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

  const [planRes, specialRes, recipeRes] = await Promise.all([
    supabase
      .from('meal_plans')
      .select('plan_date, meal_type, recipe_id, slot_locked, is_commute_day, is_holiday, is_preschool_closed, guest_count, recipes(id, name, emoji)')
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
  ])

  allRecipes = recipeRes.data || []

  const days = buildDayData(
    planRes.data  || [],
    specialRes.data || [],
    startDate
  )

  render(days, startDate)
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
    return {
      date,
      slots: entry.slots,
      meta: {
        isHoliday:        entry.meta.isHoliday        || false,
        isPreschoolClosed: entry.meta.isPreschoolClosed || false,
        isCommute:        entry.meta.isCommute         || false,
        guestCount:       entry.meta.guestCount        || 0,
        isGintasAway:     (specialMap[date] || new Set()).has('gintas_away'),
      },
    }
  })
}

// ── Render ────────────────────────────────────────────────
function render(days, startDate) {
  if (!screenEl) return
  screenEl.innerHTML = ''

  if (!days.some(d => Object.keys(d.slots).length > 0)) {
    screenEl.appendChild(buildEmpty())
    return
  }

  const wrap = document.createElement('div')
  wrap.className = 'plan-cards'
  days.forEach(day => wrap.appendChild(buildDayCard(day)))
  screenEl.appendChild(wrap)
}

// ── Day card ──────────────────────────────────────────────
function buildDayCard(day) {
  const today = todayStr()
  const card  = document.createElement('div')
  card.className = 'day-card'
  if (day.date === today) card.classList.add('day-card--today')
  if (day.date < today)   card.classList.add('day-card--past')

  card.appendChild(buildContextStrip(day))
  card.appendChild(hr())
  MEAL_SLOTS.forEach(slot => card.appendChild(buildSlotRow(day.date, slot, day.slots[slot.type])))
  card.appendChild(hr())
  card.appendChild(buildFooter(day.date))

  return card
}

function buildContextStrip(day) {
  const strip = document.createElement('div')
  strip.className = 'day-card__context'

  const date = document.createElement('span')
  date.className = 'day-card__date'
  date.textContent = fmtDate(day.date)
  strip.appendChild(date)

  const badges = document.createElement('div')
  badges.className = 'day-card__badges'

  if (day.meta.isHoliday || day.meta.isPreschoolClosed)
    badges.appendChild(badge('🏠', 'Kids home'))
  if (day.meta.isCommute)
    badges.appendChild(badge('🚗', 'Commute'))
  if (day.meta.guestCount > 0)
    badges.appendChild(badge(`👥 ×${day.meta.guestCount}`, 'Guests'))
  if (day.meta.isGintasAway)
    badges.appendChild(badge('🍃', 'Light effort'))

  strip.appendChild(badges)
  return strip
}

function buildSlotRow(date, slot, entry) {
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
    name.textContent = entry.recipes.name
    val.appendChild(name)

    if (!entry.slot_locked) {
      const ai = document.createElement('span')
      ai.className = 'day-slot__ai'
      ai.textContent = 'AI'
      val.appendChild(ai)
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

    row.classList.add('day-slot--tap')
    row.addEventListener('click', () => showPicker(date, slot.type))
  }

  row.append(icon, label, val)
  return row
}

function buildFooter(date) {
  const footer = document.createElement('div')
  footer.className = 'day-card__footer'

  const btn = document.createElement('button')
  btn.className = 'day-card__discuss'
  btn.textContent = '💬 Discuss this day'
  btn.addEventListener('click', () => {
    navState.chatPrefill = `About ${fmtDate(date)}: `
    navigateTo('chat')
  })

  footer.appendChild(btn)
  return footer
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

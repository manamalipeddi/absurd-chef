import { supabase, FUNCTIONS_URL, toast } from '../app.js'

// ── Helpers ──────────────────────────────────────────────
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function thisWeekMonday() {
  const d = new Date()
  d.setHours(12, 0, 0, 0)
  const dow = d.getDay() // 0=Sun
  d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1))
  return d.toISOString().slice(0, 10)
}

function upcomingMonday() {
  const d = new Date()
  d.setHours(12, 0, 0, 0)
  const dow = d.getDay()
  if (dow === 1) return d.toISOString().slice(0, 10)
  d.setDate(d.getDate() + (dow === 0 ? 1 : 8 - dow))
  return d.toISOString().slice(0, 10)
}

function formatDayDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z')
  return {
    dow:  ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()],
    date: d.getUTCDate(),
    month: d.toLocaleString('en', { month: 'short', timeZone: 'UTC' }),
  }
}

function weekRangeLabel(startStr, endStr) {
  const s = new Date(startStr + 'T12:00:00Z')
  const e = new Date(endStr   + 'T12:00:00Z')
  const sm = s.toLocaleString('en', { month: 'short', timeZone: 'UTC' })
  const em = e.toLocaleString('en', { month: 'short', timeZone: 'UTC' })
  const sd = s.getUTCDate(), ed = e.getUTCDate()
  return sm === em ? `${sm} ${sd}–${ed}` : `${sm} ${sd} – ${em} ${ed}`
}

function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

// ── State ─────────────────────────────────────────────────
let generating = false

// ── Init ──────────────────────────────────────────────────
export async function init({ headerLeft, headerRight }) {
  headerRight.innerHTML = `
    <button class="header-btn" id="btn-generate" aria-label="Generate plan" title="Generate 2-week plan">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round"
          d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z"/>
      </svg>
    </button>`
  document.getElementById('btn-generate').addEventListener('click', onGenerate)
  await renderPlan()
}

// ── Data loading ──────────────────────────────────────────
async function getPlanWindow() {
  // If this week already has plan entries, show this week + next.
  // Otherwise show next 2 weeks from upcoming Monday.
  const monday = thisWeekMonday()
  const { count } = await supabase
    .from('meal_plans')
    .select('*', { count: 'exact', head: true })
    .gte('plan_date', monday)
    .lt('plan_date', addDays(monday, 7))
    .eq('meal_type', 'dinner')

  const startDate = (count > 0) ? monday : upcomingMonday()
  return { startDate, endDate: addDays(startDate, 13) }
}

async function fetchPlan(startDate, endDate) {
  return supabase
    .from('meal_plans')
    .select('plan_date, cook_source, is_commute_day, remap_log, notes, recipes(name, protein, cooking_method)')
    .gte('plan_date', startDate)
    .lte('plan_date', endDate)
    .eq('meal_type', 'dinner')
    .order('plan_date')
}

// ── Render ────────────────────────────────────────────────
async function renderPlan() {
  const screen = document.getElementById('screen-plan')
  screen.innerHTML = `<div class="loading-row"><div class="spinner"></div>Loading plan…</div>`

  const { startDate, endDate } = await getPlanWindow()
  const { data, error } = await fetchPlan(startDate, endDate)

  if (error) {
    screen.innerHTML = ''
    screen.appendChild(buildError())
    return
  }

  const byDate = Object.fromEntries(data.map(r => [r.plan_date, r]))
  const allDays = Array.from({ length: 14 }, (_, i) => ({
    date: addDays(startDate, i),
    ...(byDate[addDays(startDate, i)] || null),
  }))

  screen.innerHTML = ''

  if (data.length === 0) {
    screen.appendChild(buildEmpty())
    return
  }

  for (let w = 0; w < 2; w++) {
    const week = allDays.slice(w * 7, w * 7 + 7)
    screen.appendChild(buildWeek(week))
  }
}

// ── DOM builders ──────────────────────────────────────────
function buildWeek(week) {
  const wrap = document.createElement('div')
  wrap.className = 'plan-week'

  const label = document.createElement('div')
  label.className = 'section-label'
  label.textContent = weekRangeLabel(week[0].date, week[6].date)
  wrap.appendChild(label)

  const card = document.createElement('div')
  card.className = 'card plan-card'

  week.forEach((day, i) => {
    const row = buildDayRow(day)
    if (i < 6) row.classList.add('plan-day--ruled')
    card.appendChild(row)
  })

  wrap.appendChild(card)
  return wrap
}

function buildDayRow(day) {
  const today = todayStr()
  const { dow, date, month } = formatDayDate(day.date)
  const hasRecipe = !!day.cook_source
  const recipeName = day.recipes?.name
    || (day.cook_source === 'freezer_stash' ? 'From Freezer' : null)

  const row = document.createElement('div')
  row.className = 'plan-day'
  if (day.date === today)       row.classList.add('plan-day--today')
  if (day.date < today)         row.classList.add('plan-day--past')
  if (day.is_commute_day)       row.classList.add('plan-day--commute')
  if (!hasRecipe)               row.classList.add('plan-day--empty')

  // Left: day + date
  const left = document.createElement('div')
  left.className = 'plan-day__left'
  left.innerHTML = `<span class="plan-day__dow">${dow}</span><span class="plan-day__date">${date}</span>`

  // Centre: name + sub
  const centre = document.createElement('div')
  centre.className = 'plan-day__centre'
  if (hasRecipe) {
    centre.innerHTML = `<span class="plan-day__name">${recipeName || '—'}</span>`
    const sub = buildSubline(day)
    if (sub) centre.appendChild(sub)
  } else {
    centre.innerHTML = `<span class="plan-day__name plan-day__name--empty">No plan</span>`
  }

  // Right: badge
  const right = document.createElement('div')
  right.className = 'plan-day__right'
  if (hasRecipe) {
    const badge = buildSourceBadge(day.cook_source)
    if (badge) right.appendChild(badge)
  }

  row.append(left, centre, right)

  // Tap → TODO: open override flow via Chat
  if (hasRecipe) {
    row.style.cursor = 'pointer'
    row.addEventListener('click', () => onDayTap(day))
  }

  return row
}

function buildSubline(day) {
  const parts = []
  const protein = day.recipes?.protein
  if (protein && protein !== 'vegetarian') parts.push(cap(protein))
  else if (protein === 'vegetarian') parts.push('Veggie')
  const method = day.recipes?.cooking_method
  if (method === 'slow_cook') parts.push('Slow cook')
  if (day.remap_log) parts.push('Remapped')
  if (!parts.length) return null

  const el = document.createElement('span')
  el.className = 'plan-day__sub'
  el.textContent = parts.join(' · ')
  return el
}

function buildSourceBadge(source) {
  if (source === 'home') return null
  const configs = {
    freezer_stash: { label: '❄', cls: 'badge--ice',  title: 'From freezer' },
    slow_cook:     { label: '⏱', cls: 'badge--slow', title: 'Slow cook' },
    store_bought:  { label: '🛒', cls: 'badge--buy',  title: 'Store-bought' },
  }
  const cfg = configs[source]
  if (!cfg) return null
  const el = document.createElement('span')
  el.className = `plan-badge ${cfg.cls}`
  el.textContent = cfg.label
  el.title = cfg.title
  return el
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
    <button class="btn-primary" id="btn-generate-empty">Generate plan</button>`
  wrap.querySelector('#btn-generate-empty').addEventListener('click', onGenerate)
  return wrap
}

function buildError() {
  const wrap = document.createElement('div')
  wrap.className = 'placeholder-wrap'
  wrap.innerHTML = `<p class="placeholder-label">Couldn't load plan</p>
    <button class="btn-primary" id="btn-retry">Retry</button>`
  wrap.querySelector('#btn-retry').addEventListener('click', renderPlan)
  return wrap
}

// ── Actions ───────────────────────────────────────────────
async function onGenerate() {
  if (generating) return
  generating = true

  const btn = document.getElementById('btn-generate')
  if (btn) {
    btn.disabled = true
    btn.innerHTML = `<div class="spinner"></div>`
  }

  try {
    const start = upcomingMonday()
    const res = await fetch(`${FUNCTIONS_URL}/plan-generator`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'full_14', start_date: start }),
    })
    const json = await res.json()

    if (!json.success) throw new Error(json.error || 'Generation failed')

    toast(`Plan generated — ${json.days_planned} days`)

    if (json.unresolved?.length) {
      setTimeout(() => {
        toast(`${json.unresolved.length} day${json.unresolved.length > 1 ? 's' : ''} need your input — check Chat`, { duration: 5000 })
      }, 600)
    }

    await renderPlan()
  } catch (e) {
    toast(e.message || 'Generation failed', { error: true })
  } finally {
    generating = false
    const btn = document.getElementById('btn-generate')
    if (btn) {
      btn.disabled = false
      btn.innerHTML = sparklesIcon()
    }
  }
}

function onDayTap(day) {
  // TODO: open Chat with this day pre-selected for override
  // For now, just a hint
  toast(`Tap Chat to change ${day.recipes?.name || 'this day'}`)
}

// ── SVG icon ──────────────────────────────────────────────
function sparklesIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <path stroke-linecap="round" stroke-linejoin="round"
      d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z"/>
  </svg>`
}

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : '' }

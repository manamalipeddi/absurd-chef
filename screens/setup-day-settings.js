import { supabase, FUNCTIONS_URL, navigateTo, toast } from '../app.js'

let screenEl = null
let rows = []            // 14 day objects { date, dow, ds }
let guestMembers = []    // family_members role=guest active
// per-column paint state for copy-forward ("most recently set")
let paint = { is_commute_day: null, kids_home: null, gintas_away: null, guests: null }
// pending scoped-replan dates (debounced)
const replanQueue = new Set()
let replanTimer = null

const COLS = [
  { key: 'is_commute_day', label: 'Commute',     icon: '🚗' },
  { key: 'kids_home',      label: 'Kids Home',   icon: '🏠' },
  { key: 'gintas_away',    label: 'Gintas Away', icon: '🍃' },
  { key: 'guests',         label: 'Guests',      icon: '👥' },
]

function addDays(s, n) { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
function todayStr() { return new Date().toISOString().slice(0, 10) }
function dow(date) { return new Date(date + 'T12:00:00Z').getUTCDay() }
function fmtDate(s) {
  const d = new Date(s + 'T12:00:00Z')
  return `${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()]} ${d.getUTCDate()}`
}
function defaultDs(date) {
  const wd = dow(date)
  return { day: date, is_commute_day: false, kids_home: wd === 0 || wd === 6, gintas_away: false,
           guest_count: 0, guest_family_member_ids: [], guest_allergies: [] }
}

export function init(el) { screenEl = el }

export async function activate({ headerLeft, headerRight }) {
  headerLeft.innerHTML = backBtn('ds-back')
  headerRight.innerHTML = ''
  document.getElementById('ds-back').addEventListener('click', () => navigateTo('setup'))
  paint = { is_commute_day: null, kids_home: null, gintas_away: null, guests: null }
  await load()
  render()
}

async function load() {
  const start = todayStr(), end = addDays(start, 13)
  const [{ data: ds }, { data: gm }] = await Promise.all([
    supabase.from('day_settings').select('*').gte('day', start).lte('day', end),
    supabase.from('family_members').select('id, name, allergies').eq('role', 'guest').eq('active', true).order('name'),
  ])
  guestMembers = gm || []
  const byDay = {}
  for (const r of ds || []) byDay[r.day] = r
  rows = Array.from({ length: 14 }, (_, i) => {
    const date = addDays(start, i)
    const existing = byDay[date]
    return { date, dow: dow(date), ds: existing ? { ...defaultDs(date), ...existing } : defaultDs(date) }
  })
}

// ── Persistence ───────────────────────────────────────────
async function saveRow(row) {
  const d = row.ds
  const { error } = await supabase.from('day_settings').upsert({
    day: row.date,
    is_commute_day: d.is_commute_day,
    kids_home: d.kids_home,
    gintas_away: d.gintas_away,
    guest_count: d.guest_count,
    guest_family_member_ids: d.guest_family_member_ids,
    guest_allergies: d.guest_allergies,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'day' })
  if (error) toast('Save failed', { error: true })
}

// planning-affecting change → queue a scoped (targeted) replan, debounced
function queueReplan(date) {
  replanQueue.add(date)
  if (replanTimer) clearTimeout(replanTimer)
  replanTimer = setTimeout(fireReplan, 1500)
}
async function fireReplan() {
  const dates = [...replanQueue]
  replanQueue.clear()
  if (!dates.length) return
  toast(`Replanning ${dates.length} day${dates.length !== 1 ? 's' : ''}…`)
  try {
    const res = await fetch(`${FUNCTIONS_URL}/plan-generator`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'targeted', target_dates: dates, triggered_by: 'manual' }),
    })
    const json = await res.json()
    if (json.success) {
      toast('Plan updated')
      document.dispatchEvent(new Event('plan-updated'))
    } else throw new Error(json.error)
  } catch {
    toast('Replan failed — open Plan and use Regenerate', { error: true, duration: 6000 })
  }
}

// ── Render ────────────────────────────────────────────────
function render() {
  screenEl.innerHTML = ''
  const intro = document.createElement('p')
  intro.className = 'ds-intro'
  intro.textContent = 'Tap a cell to toggle. Once set, tapping another cell in the same column copies that value forward.'
  screenEl.appendChild(intro)

  const grid = document.createElement('div')
  grid.className = 'ds-grid'

  // header row: blank corner + 4 column headers (with apply-to buttons)
  grid.appendChild(cell('ds-corner', ''))
  for (const col of COLS) {
    const h = document.createElement('div')
    h.className = 'ds-colhead'
    h.innerHTML = `<span class="ds-colhead__icon">${col.icon}</span><span class="ds-colhead__label">${col.label}</span>`
    const apply = document.createElement('div')
    apply.className = 'ds-apply'
    ;[['cur', 'This'], ['next', 'Next'], ['all', 'All']].forEach(([scope, lbl]) => {
      const b = document.createElement('button')
      b.className = 'ds-apply__btn'
      b.textContent = lbl
      b.title = `Apply ${col.label} to ${lbl.toLowerCase()}`
      b.addEventListener('click', () => applyTo(col.key, scope))
      apply.appendChild(b)
    })
    h.appendChild(apply)
    grid.appendChild(h)
  }

  // 14 data rows
  rows.forEach((row, idx) => {
    const today = todayStr()
    const lbl = document.createElement('div')
    lbl.className = 'ds-rowlabel' + (row.date === today ? ' ds-rowlabel--today' : '')
    lbl.textContent = fmtDate(row.date)
    grid.appendChild(lbl)
    for (const col of COLS) grid.appendChild(buildCell(row, idx, col))
  })

  screenEl.appendChild(grid)
}

function cell(cls, txt) { const d = document.createElement('div'); d.className = cls; d.textContent = txt; return d }

function buildCell(row, idx, col) {
  const el = document.createElement('div')
  el.className = 'ds-cell'
  if (col.key === 'guests') {
    const n = row.ds.guest_count || 0
    el.classList.toggle('ds-cell--on', n > 0)
    el.innerHTML = n > 0
      ? `<span class="ds-cell__guests">${n}</span><button class="ds-cell__clear" title="Clear guests">×</button>`
      : `<span class="ds-cell__dash"></span>`
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('ds-cell__clear')) { e.stopPropagation(); clearGuests(row, idx); return }
      onGuestTap(row, idx)
    })
  } else {
    const on = !!row.ds[col.key]
    el.classList.toggle('ds-cell--on', on)
    el.textContent = on ? '✓' : ''
    el.addEventListener('click', () => onBoolTap(row, idx, col.key))
  }
  return el
}

// ── Boolean tap: toggle / copy-forward (paint model) ──────
async function onBoolTap(row, idx, key) {
  const cur = !!row.ds[key]
  const p = paint[key]
  // toggle when nothing painted yet or this cell already matches the paint;
  // otherwise copy the painted value forward into this cell.
  const newVal = (p === null || cur === p) ? !cur : p
  row.ds[key] = newVal
  paint[key] = newVal
  await saveRow(row)
  queueReplan(row.date)
  render()
}

// ── Guests ────────────────────────────────────────────────
function onGuestTap(row, idx) {
  const has = (row.ds.guest_count || 0) > 0
  if (!has && paint.guests) {
    // copy-forward: silently copy the last-set guest context (no fork)
    const g = paint.guests
    row.ds.guest_count = g.guest_count
    row.ds.guest_family_member_ids = [...g.guest_family_member_ids]
    row.ds.guest_allergies = JSON.parse(JSON.stringify(g.guest_allergies))
    saveRow(row); queueReplan(row.date); render()
    return
  }
  // genuinely new from empty, or editing an already-set cell → open the fork
  openGuestFork(row)
}

async function clearGuests(row, idx) {
  row.ds.guest_count = 0
  row.ds.guest_family_member_ids = []
  row.ds.guest_allergies = []
  await saveRow(row)
  queueReplan(row.date)
  render()
}

function openGuestFork(row) {
  const overlay = document.createElement('div'); overlay.className = 'picker-overlay'
  const sheet = document.createElement('div'); sheet.className = 'picker-sheet ds-fork'
  const head = document.createElement('div'); head.className = 'picker-header'
  head.innerHTML = `<span class="picker-title">Guests — ${fmtDate(row.date)}</span><button class="picker-close">✕</button>`
  head.querySelector('.picker-close').addEventListener('click', () => overlay.remove())
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove() })

  const body = document.createElement('div'); body.className = 'ds-fork__body'

  // A) Known guests
  const selIds = new Set(row.ds.guest_family_member_ids || [])
  const knownLbl = document.createElement('div'); knownLbl.className = 'su-label'; knownLbl.textContent = 'Known guests'
  const knownList = document.createElement('div'); knownList.className = 'ds-known'
  function renderKnown() {
    knownList.innerHTML = ''
    guestMembers.forEach(m => {
      const r = document.createElement('label'); r.className = 'ds-known__row'
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = selIds.has(m.id)
      cb.addEventListener('change', () => { cb.checked ? selIds.add(m.id) : selIds.delete(m.id) })
      const nm = document.createElement('span'); nm.textContent = m.name
      const al = (m.allergies || []).map(a => a.substance).filter(Boolean)
      if (al.length) { const b = document.createElement('span'); b.className = 'ds-known__allergy'; b.textContent = '⚠ ' + al.join(', '); r.append(cb, nm, b) }
      else r.append(cb, nm)
      knownList.appendChild(r)
    })
    const addNew = document.createElement('button'); addNew.className = 'ds-addguest'; addNew.textContent = '+ Add a new guest'
    addNew.addEventListener('click', async () => {
      const name = prompt('New guest name:')?.trim()
      if (!name) return
      const { data, error } = await supabase.from('family_members')
        .insert({ name, role: 'guest', is_default_household: false, active: true }).select().single()
      if (error || !data) { toast('Failed to add', { error: true }); return }
      guestMembers.push(data); selIds.add(data.id); renderKnown()
    })
    knownList.appendChild(addNew)
  }
  renderKnown()

  // B) One-off: extra headcount + allergy rows
  const oneoffLbl = document.createElement('div'); oneoffLbl.className = 'su-label'; oneoffLbl.textContent = 'Someone new, just this once'
  const knownCount = (row.ds.guest_family_member_ids || []).length
  let extra = Math.max(0, (row.ds.guest_count || 0) - knownCount)
  const stepWrap = document.createElement('div'); stepWrap.className = 'ds-step'
  const stepVal = document.createElement('span'); stepVal.className = 'ds-step__val'
  const renderStep = () => { stepVal.textContent = `${extra} extra guest${extra !== 1 ? 's' : ''}` }
  const minus = document.createElement('button'); minus.className = 'ds-step__btn'; minus.textContent = '−'
  const plus  = document.createElement('button'); plus.className = 'ds-step__btn'; plus.textContent = '+'
  minus.addEventListener('click', () => { extra = Math.max(0, extra - 1); renderStep() })
  plus.addEventListener('click', () => { extra += 1; renderStep() })
  renderStep()
  stepWrap.append(minus, stepVal, plus)

  const allergyWrap = document.createElement('div'); allergyWrap.className = 'su-rpt'
  ;(row.ds.guest_allergies || []).forEach(a => allergyWrap.appendChild(allergyRow(a)))
  const addAllergy = document.createElement('button'); addAllergy.className = 'su-rpt-add'; addAllergy.textContent = '+ Add one-off allergy'
  addAllergy.addEventListener('click', () => allergyWrap.appendChild(allergyRow({ substance: '', severity: 'allergy', notes: '' })))

  body.append(knownLbl, knownList, oneoffLbl, stepWrap, allergyWrap, addAllergy)

  const saveBtn = document.createElement('button'); saveBtn.className = 'su-btn-primary ds-fork__save'; saveBtn.textContent = 'Save guests'
  saveBtn.addEventListener('click', async () => {
    const ids = [...selIds]
    const allergies = Array.from(allergyWrap.querySelectorAll('.su-rpt-row')).map(r => ({
      substance: r.querySelector('[data-f="substance"]').value.trim(),
      severity:  r.querySelector('[data-f="severity"]').value,
      notes:     r.querySelector('[data-f="notes"]').value.trim(),
    })).filter(a => a.substance)
    const count = ids.length + extra
    row.ds.guest_count = count
    row.ds.guest_family_member_ids = ids
    row.ds.guest_allergies = allergies
    paint.guests = { guest_count: count, guest_family_member_ids: [...ids], guest_allergies: JSON.parse(JSON.stringify(allergies)) }
    await saveRow(row)
    queueReplan(row.date)
    overlay.remove()
    render()
  })

  sheet.append(head, body, saveBtn)
  overlay.appendChild(sheet)
  document.body.appendChild(overlay)
}

function allergyRow(data) {
  const row = document.createElement('div'); row.className = 'su-rpt-row'
  const sub = inp('text', data.substance || '', 'Substance'); sub.dataset.f = 'substance'
  const sev = sel([['intolerance', 'Intolerance'], ['allergy', 'Allergy']], data.severity || 'allergy'); sev.dataset.f = 'severity'
  const notes = inp('text', data.notes || '', 'Notes'); notes.dataset.f = 'notes'
  const rm = document.createElement('button'); rm.type = 'button'; rm.className = 'su-rpt-rm'; rm.textContent = '×'
  rm.addEventListener('click', () => row.remove())
  row.append(sub, sev, notes, rm); return row
}

// ── Apply-to: This / Next / All ───────────────────────────
async function applyTo(key, scope) {
  // source = the most-recently-set value for this column (paint)
  const val = paint[key]
  if (val === null) { toast('Set a value first, then apply it', { error: true }); return }

  let targets = []
  if (scope === 'cur') return                          // no-op (source row already set)
  if (scope === 'all') targets = rows
  if (scope === 'next') {
    // next day after the last row that currently holds the paint value
    let srcIdx = -1
    for (let i = rows.length - 1; i >= 0; i--) {
      if (key === 'guests' ? rows[i].ds.guest_count > 0 : rows[i].ds[key] === val) { srcIdx = i; break }
    }
    if (srcIdx >= 0 && srcIdx + 1 < rows.length) targets = [rows[srcIdx + 1]]
  }
  if (!targets.length) return

  const changed = []
  for (const row of targets) {
    if (key === 'guests') {
      row.ds.guest_count = val.guest_count
      row.ds.guest_family_member_ids = [...val.guest_family_member_ids]
      row.ds.guest_allergies = JSON.parse(JSON.stringify(val.guest_allergies))
    } else {
      row.ds[key] = val
    }
    await saveRow(row)
    changed.push(row.date)
  }
  // one scoped replan covering all affected dates
  changed.forEach(d => replanQueue.add(d))
  if (replanTimer) clearTimeout(replanTimer)
  replanTimer = setTimeout(fireReplan, 800)
  render()
}

// ── Tiny helpers ──────────────────────────────────────────
function inp(type, value, ph) { const el = document.createElement('input'); el.type = type; el.className = 'su-input su-sel-sm'; el.value = value; if (ph) el.placeholder = ph; return el }
function sel(opts, val) { const el = document.createElement('select'); el.className = 'su-select su-sel-sm'; opts.forEach(([v, l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; if (v === val) o.selected = true; el.appendChild(o) }); return el }
function backBtn(id) {
  return `<button class="header-btn" id="${id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5"/></svg></button>`
}

import { supabase, FUNCTIONS_URL, navigateTo, toast } from '../app.js'

let screenEl = null
let rows = []            // 14 day objects { date, dow, ds }
let guestMembers = []    // family_members role=guest active
// per-column paint state for copy-forward ("most recently set")
let paint = { is_commute_day: null, kids_home: null, gintas_away: null, guests: null }
let dirty = new Set()    // dates touched this editing session (unsaved)
let saving = false

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
  dirty = new Set()
  await load()
  render()
}

// Navigation guard — called by app.js before leaving this screen.
export function canLeave() {
  if (saving) return false
  if (dirty.size === 0) return true
  const ok = confirm('You have unsaved changes.\n\nDiscard them and leave? (Cancel to stay and Save.)')
  if (ok) dirty = new Set()   // discard; next visit reloads from DB
  return ok
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

// ── Render ────────────────────────────────────────────────
function render() {
  screenEl.innerHTML = ''
  const intro = document.createElement('p')
  intro.className = 'ds-intro'
  intro.textContent = 'Tap a cell to toggle. Once set, tapping another cell in the same column copies that value forward. Changes save when you tap Save.'
  screenEl.appendChild(intro)

  const grid = document.createElement('div')
  grid.className = 'ds-grid'

  // header row: blank corner + 4 column headers
  grid.appendChild(cell('ds-corner', ''))
  for (const col of COLS) {
    const h = document.createElement('div')
    h.className = 'ds-colhead'
    h.innerHTML = `<span class="ds-colhead__icon">${col.icon}</span><span class="ds-colhead__label">${col.label}</span>`
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
  renderSaveBar()
}

function renderSaveBar() {
  const old = document.getElementById('ds-savebar')
  if (old) old.remove()
  if (dirty.size === 0) return
  const bar = document.createElement('div')
  bar.className = 'ds-savebar'
  bar.id = 'ds-savebar'
  const btn = document.createElement('button')
  btn.className = 'ds-savebar__btn'
  btn.id = 'ds-save'
  btn.textContent = saving
    ? 'Saving…'
    : `Save ${dirty.size} day${dirty.size !== 1 ? 's' : ''}`
  btn.disabled = saving
  btn.addEventListener('click', saveAll)
  bar.appendChild(btn)
  screenEl.appendChild(bar)
}

function cell(cls, txt) { const d = document.createElement('div'); d.className = cls; d.textContent = txt; return d }

function buildCell(row, idx, col) {
  const el = document.createElement('div')
  el.className = 'ds-cell'
  if (dirty.has(row.date)) el.classList.add('ds-cell--dirty')
  if (col.key === 'guests') {
    const n = row.ds.guest_count || 0
    el.classList.toggle('ds-cell--on', n > 0)
    el.innerHTML = n > 0
      ? `<span class="ds-cell__guests">${n}</span><button class="ds-cell__clear" title="Clear guests">×</button>`
      : `<span class="ds-cell__dash"></span>`
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('ds-cell__clear')) { e.stopPropagation(); clearGuests(row); return }
      onGuestTap(row)
    })
  } else {
    const on = !!row.ds[col.key]
    el.classList.toggle('ds-cell--on', on)
    el.textContent = on ? '✓' : ''
    el.addEventListener('click', () => onBoolTap(row, col.key))
  }
  return el
}

// ── Edits update LOCAL state only (no save / replan until Save) ──
function onBoolTap(row, key) {
  const cur = !!row.ds[key]
  const p = paint[key]
  // toggle when nothing painted yet or this cell already matches the paint;
  // otherwise copy the painted value forward into this cell.
  const newVal = (p === null || cur === p) ? !cur : p
  row.ds[key] = newVal
  paint[key] = newVal
  dirty.add(row.date)
  render()
}

function onGuestTap(row) {
  const has = (row.ds.guest_count || 0) > 0
  if (!has && paint.guests) {
    const g = paint.guests
    row.ds.guest_count = g.guest_count
    row.ds.guest_family_member_ids = [...g.guest_family_member_ids]
    row.ds.guest_allergies = JSON.parse(JSON.stringify(g.guest_allergies))
    dirty.add(row.date)
    render()
    return
  }
  openGuestFork(row)
}

function clearGuests(row) {
  row.ds.guest_count = 0
  row.ds.guest_family_member_ids = []
  row.ds.guest_allergies = []
  dirty.add(row.date)
  render()
}

// ── Save: batch upsert all touched rows + ONE scoped replan ──
async function saveAll() {
  if (saving || dirty.size === 0) return
  saving = true
  renderSaveBar()
  const dates = [...dirty]
  const payload = rows.filter(r => dirty.has(r.date)).map(r => ({
    day: r.date,
    is_commute_day: r.ds.is_commute_day,
    kids_home: r.ds.kids_home,
    gintas_away: r.ds.gintas_away,
    guest_count: r.ds.guest_count,
    guest_family_member_ids: r.ds.guest_family_member_ids,
    guest_allergies: r.ds.guest_allergies,
    updated_at: new Date().toISOString(),
  }))

  const { error } = await supabase.from('day_settings').upsert(payload, { onConflict: 'day' })
  if (error) { toast('Save failed', { error: true }); saving = false; renderSaveBar(); return }

  // exactly one scoped replan covering every affected date
  try {
    const res = await fetch(`${FUNCTIONS_URL}/plan-generator`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'targeted', target_dates: dates, triggered_by: 'manual' }),
    })
    const json = await res.json()
    if (!json.success) throw new Error(json.error)
    dirty = new Set()
    saving = false
    document.dispatchEvent(new Event('plan-updated'))
    toast(`Saved — ${dates.length} day${dates.length !== 1 ? 's' : ''} replanned`)
    navigateTo('plan')
  } catch {
    // settings are saved; only the replan failed
    dirty = new Set()
    saving = false
    renderSaveBar()
    toast('Saved, but replan failed — open Plan and use Regenerate', { error: true, duration: 6000 })
  }
}

// ── Guest fork ────────────────────────────────────────────
function openGuestFork(row) {
  const overlay = document.createElement('div'); overlay.className = 'picker-overlay'
  const sheet = document.createElement('div'); sheet.className = 'picker-sheet ds-fork'
  const head = document.createElement('div'); head.className = 'picker-header'
  head.innerHTML = `<span class="picker-title">Guests — ${fmtDate(row.date)}</span><button class="picker-close">✕</button>`
  head.querySelector('.picker-close').addEventListener('click', () => overlay.remove())
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove() })

  const body = document.createElement('div'); body.className = 'ds-fork__body'

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

  const saveBtn = document.createElement('button'); saveBtn.className = 'su-btn-primary ds-fork__save'; saveBtn.textContent = 'Set guests'
  saveBtn.addEventListener('click', () => {
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
    dirty.add(row.date)
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

// ── Tiny helpers ──────────────────────────────────────────
function inp(type, value, ph) { const el = document.createElement('input'); el.type = type; el.className = 'su-input su-sel-sm'; el.value = value; if (ph) el.placeholder = ph; return el }
function sel(opts, val) { const el = document.createElement('select'); el.className = 'su-select su-sel-sm'; opts.forEach(([v, l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; if (v === val) o.selected = true; el.appendChild(o) }); return el }
function backBtn(id) {
  return `<button class="header-btn" id="${id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5"/></svg></button>`
}

import { supabase, navigateTo, toast } from '../app.js'

const DAYS        = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
const DAY_SHORT   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
const MEAL_TYPES  = [['breakfast','Breakfast'],['lunch','Lunch'],['dinner','Dinner'],['snack','Snack']]
const CON_TYPES   = [['protein','Protein'],['style','Style'],['free','Free text']]

let screenEl = null
let rows     = []
let editId   = null

export function init(el) { screenEl = el }

export async function activate({ headerLeft, headerRight }) {
  headerLeft.innerHTML = backBtn('swt-back')
  headerRight.innerHTML = ''
  document.getElementById('swt-back').addEventListener('click', () => history.back())
  editId = null
  await load()
  renderList()
}

async function load() {
  const { data } = await supabase
    .from('weekly_template').select('*')
    .eq('active', true).order('day_of_week').order('meal_type')
  rows = data || []
}

// ── List ──────────────────────────────────────────────────
function renderList() {
  screenEl.innerHTML = ''
  screenEl.appendChild(mkAddBtn('+ Add template rule', () => openForm(null)))

  if (!rows.length) { screenEl.appendChild(mkEmpty('No template rules yet.')); return }

  // Group by day_of_week
  const byDay = {}
  rows.forEach(r => { (byDay[r.day_of_week] = byDay[r.day_of_week] || []).push(r) })

  const card = document.createElement('div')
  card.className = 'card su-card'
  let isFirst = true
  Object.keys(byDay).sort((a, b) => a - b).forEach(day => {
    byDay[day].forEach((r, i) => {
      const row = buildRow(r, !isFirst || i > 0)
      card.appendChild(row)
      isFirst = false
    })
  })
  screenEl.appendChild(card)
}

function buildRow(r, ruled) {
  const row = document.createElement('div')
  row.className = 'su-list-row' + (ruled ? ' su-list-row--ruled' : '')
  const centre = document.createElement('div')
  centre.className = 'su-list-row__centre'
  const main = document.createElement('div')
  main.className = 'su-list-row__main'
  main.textContent = DAY_SHORT[r.day_of_week] + ' · ' + r.meal_type + (r.label ? ' — ' + r.label : '')
  const sub = document.createElement('div')
  sub.className = 'su-list-row__sub'
  sub.textContent = [r.constraint_type, r.constraint_value].filter(Boolean).join(': ')
  centre.append(main, sub)
  row.appendChild(centre)
  if (r.is_hard_constraint) {
    const badge = document.createElement('span')
    badge.className = 'su-badge su-badge-hard'
    badge.textContent = 'Hard'
    row.appendChild(badge)
  }
  row.addEventListener('click', () => openForm(r.id))
  return row
}

// ── Form ──────────────────────────────────────────────────
function openForm(id) {
  editId = id
  const r = id ? rows.find(x => x.id === id) : null
  screenEl.innerHTML = ''
  const form = document.createElement('div')
  form.className = 'su-form'

  const dayOpts = DAYS.map((d, i) => [String(i), d])
  const daySelEl  = mkSelect(dayOpts, r ? String(r.day_of_week) : '1')
  const mealSelEl = mkSelect(MEAL_TYPES, r?.meal_type || 'dinner')
  const conSelEl  = mkSelect([['','None'], ...CON_TYPES], r?.constraint_type || '')
  const conInp    = mkInput('text', r?.constraint_value || '', 'e.g. chicken|pork')
  const labelInp  = mkInput('text', r?.label || '',            'e.g. Veggie/Bean Monday')

  const hintEl = document.createElement('p')
  hintEl.className = 'su-hint'
  hintEl.textContent = 'Multiple options: separate with | e.g. chicken|pork|lamb'

  const conFieldEl = mkField('Constraint value', conInp)
  conFieldEl.appendChild(hintEl)

  form.append(
    mkField('Day', daySelEl),
    mkField('Meal type', mealSelEl),
    mkField('Constraint type', conSelEl),
    conFieldEl,
    mkField('Label (optional)', labelInp),
  )

  form.appendChild(mkCheckboxRow('Hard constraint (must follow)', r?.is_hard_constraint ?? false, 'hardCheck'))
  form.appendChild(mkCheckboxRow('Active', r?.active ?? true, 'activeCheck'))

  const { save, cancel } = mkActions()
  cancel.addEventListener('click', async () => { await load(); renderList() })
  save.addEventListener('click', async () => {
    const payload = {
      day_of_week:       parseInt(daySelEl.value),
      meal_type:         mealSelEl.value,
      constraint_type:   conSelEl.value || null,
      constraint_value:  conInp.value.trim() || null,
      label:             labelInp.value.trim() || null,
      is_hard_constraint: form.querySelector('#hardCheck').checked,
      active:            form.querySelector('#activeCheck').checked,
    }
    save.disabled = true; save.textContent = 'Saving…'
    const op = editId
      ? supabase.from('weekly_template').update(payload).eq('id', editId)
      : supabase.from('weekly_template').insert(payload)
    const { error } = await op
    if (error) { toast('Save failed', { error: true }); save.disabled = false; save.textContent = 'Save'; return }
    toast('Saved')
    await load(); renderList()
  })

  const actionsWrap = document.createElement('div')
  actionsWrap.className = 'su-actions'
  actionsWrap.append(cancel, save)
  form.appendChild(actionsWrap)
  screenEl.appendChild(form)
}

// ── Helpers (shared) ─────────────────────────────────────
function mkInput(type, value, placeholder) {
  const el = document.createElement('input')
  el.type = type; el.className = 'su-input'; el.value = value
  if (placeholder) el.placeholder = placeholder
  return el
}
function mkSelect(opts, val) {
  const el = document.createElement('select'); el.className = 'su-select'
  opts.forEach(([v, l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; if (v === val) o.selected = true; el.appendChild(o) })
  return el
}
function mkField(label, input) {
  const w = document.createElement('div'); w.className = 'su-field'
  const l = document.createElement('label'); l.className = 'su-label'; l.textContent = label
  w.append(l, input); return w
}
function mkCheckboxRow(label, checked, id) {
  const wrap = document.createElement('label'); wrap.className = 'su-checkbox-row'
  const inp = document.createElement('input'); inp.type = 'checkbox'; inp.id = id; inp.checked = checked
  const span = document.createElement('span'); span.textContent = label
  wrap.append(inp, span); return wrap
}
function mkActions() {
  const save   = document.createElement('button'); save.className = 'su-btn-primary'; save.textContent = 'Save'
  const cancel = document.createElement('button'); cancel.className = 'su-btn-ghost';  cancel.textContent = 'Cancel'
  return { save, cancel }
}
function mkAddBtn(label, fn) {
  const b = document.createElement('button'); b.className = 'su-add-btn'; b.textContent = label
  b.addEventListener('click', fn); return b
}
function mkEmpty(msg) {
  const p = document.createElement('p'); p.className = 'su-empty'; p.textContent = msg; return p
}
function backBtn(id) {
  return `<button class="header-btn" id="${id}">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5"/>
    </svg>
  </button>`
}

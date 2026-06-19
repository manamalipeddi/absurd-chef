import { supabase, navigateTo, toast } from '../app.js'

const DAYS      = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
const DAY_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']

let screenEl     = null
let commuteDays  = []
let adultMembers = []
let editId       = null

export function init(el) { screenEl = el }

export async function activate({ headerLeft, headerRight }) {
  headerLeft.innerHTML = backBtn('scd-back')
  headerRight.innerHTML = ''
  document.getElementById('scd-back').addEventListener('click', () => navigateTo('setup'))
  editId = null
  await load()
  renderList()
}

async function load() {
  const [cdRes, memRes] = await Promise.all([
    supabase.from('commute_days').select('*').order('day_of_week'),
    supabase.from('family_members').select('id, name').eq('role', 'adult').eq('active', true).order('name'),
  ])
  commuteDays  = cdRes.data || []
  adultMembers = memRes.data || []
}

// ── List ──────────────────────────────────────────────────
function renderList() {
  screenEl.innerHTML = ''
  screenEl.appendChild(mkAddBtn('+ Add commute day', () => openForm(null)))

  const active = commuteDays.filter(c => c.active)
  if (!active.length) { screenEl.appendChild(mkEmpty('No commute days yet.')); return }

  const memberMap = Object.fromEntries(adultMembers.map(m => [m.id, m.name]))
  const card = document.createElement('div')
  card.className = 'card su-card'
  active.forEach((c, i) => {
    const row = document.createElement('div')
    row.className = 'su-list-row' + (i < active.length - 1 ? ' su-list-row--ruled' : '')
    const centre = document.createElement('div')
    centre.className = 'su-list-row__centre'
    const main = document.createElement('div')
    main.className = 'su-list-row__main'
    main.textContent = DAY_SHORT[c.day_of_week] + (c.label ? ' — ' + c.label : '')
    const sub = document.createElement('div')
    sub.className = 'su-list-row__sub'
    const parts = []
    if (c.member_id && memberMap[c.member_id]) parts.push(memberMap[c.member_id])
    if (c.notes) parts.push(c.notes)
    sub.textContent = parts.join(' · ')
    centre.append(main, sub)
    row.appendChild(centre)
    row.addEventListener('click', () => openForm(c.id))
    card.appendChild(row)
  })
  screenEl.appendChild(card)
}

// ── Form ──────────────────────────────────────────────────
function openForm(id) {
  editId = id
  const c = id ? commuteDays.find(x => x.id === id) : null
  screenEl.innerHTML = ''
  const form = document.createElement('div')
  form.className = 'su-form'

  const dayOpts   = DAYS.map((d, i) => [String(i), d])
  const memberOpts = [['', '— none —'], ...adultMembers.map(m => [m.id, m.name])]

  const daySelEl    = mkSelect(dayOpts,    c ? String(c.day_of_week) : '1')
  const memberSelEl = mkSelect(memberOpts, c?.member_id || '')
  const labelInp    = mkInput('text',  c?.label || '',  'e.g. Manasa WFH')
  const notesInp    = mkInput('text',  c?.notes || '',  'Optional notes')

  form.append(
    mkField('Day', daySelEl),
    mkField('Person', memberSelEl),
    mkField('Label (optional)', labelInp),
    mkField('Notes (optional)', notesInp),
  )
  form.appendChild(mkCheckboxRow('Active', c?.active ?? true, 'activeCheck'))

  const { save, cancel } = mkActions()
  cancel.addEventListener('click', async () => { await load(); renderList() })
  save.addEventListener('click', async () => {
    const payload = {
      day_of_week: parseInt(daySelEl.value),
      member_id:   memberSelEl.value || null,
      label:       labelInp.value.trim() || null,
      notes:       notesInp.value.trim() || null,
      active:      form.querySelector('#activeCheck').checked,
    }
    save.disabled = true; save.textContent = 'Saving…'
    const op = editId
      ? supabase.from('commute_days').update(payload).eq('id', editId)
      : supabase.from('commute_days').insert(payload)
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

// ── Helpers ───────────────────────────────────────────────
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

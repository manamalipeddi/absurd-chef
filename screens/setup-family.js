import { supabase, navigateTo, toast } from '../app.js'

let screenEl = null
let members  = []
let editId   = null

export function init(el) { screenEl = el }

export async function activate({ headerLeft, headerRight }) {
  headerLeft.innerHTML = backBtn('sf-back')
  headerRight.innerHTML = ''
  document.getElementById('sf-back').addEventListener('click', () => navigateTo('setup'))
  editId = null
  await load()
  renderList()
}

async function load() {
  const { data } = await supabase
    .from('family_members').select('*')
    .order('role').order('name')
  members = data || []
}

// ── List ──────────────────────────────────────────────────
function renderList() {
  screenEl.innerHTML = ''
  const addBtn = mkAddBtn('+ Add family member', () => openForm(null))
  screenEl.appendChild(addBtn)

  if (!members.length) { screenEl.appendChild(mkEmpty('No family members yet.')); return }

  const card = document.createElement('div')
  card.className = 'card su-card'
  members.forEach((m, i) => card.appendChild(buildRow(m, i < members.length - 1)))
  screenEl.appendChild(card)
}

function buildRow(m, ruled) {
  const row = document.createElement('div')
  row.className = 'su-list-row' + (ruled ? ' su-list-row--ruled' : '')

  const centre = document.createElement('div')
  centre.className = 'su-list-row__centre'
  const main = document.createElement('div')
  main.className = 'su-list-row__main'
  main.textContent = m.name
  const parts = [fmtRole(m.role)]
  if (m.birth_year) parts.push(String(m.birth_year))
  if (!m.active) parts.push('inactive')
  const sub = document.createElement('div')
  sub.className = 'su-list-row__sub'
  sub.textContent = parts.filter(Boolean).join(' · ')
  centre.append(main, sub)
  row.appendChild(centre)

  const allergies = m.allergies || []
  if (allergies.length) {
    const badge = document.createElement('span')
    badge.className = 'su-allergy-badge'
    badge.title = allergies.map(a => `${a.substance} (${a.severity})`).join(', ')
    badge.textContent = '⚠ ' + allergies.map(a => a.substance).join(', ')
    row.appendChild(badge)
  }

  row.addEventListener('click', () => openForm(m.id))
  return row
}

// ── Form ──────────────────────────────────────────────────
function openForm(id) {
  editId = id
  const m = id ? members.find(x => x.id === id) : null
  screenEl.innerHTML = ''
  const form = document.createElement('div')
  form.className = 'su-form'

  const nameInp  = mkInput('text',   m?.name || '',       'e.g. Manasa')
  const roleSelEl = mkSelect([['adult','Adult'],['child','Child'],['guest_regular','Regular guest']], m?.role || 'adult')
  const byInp    = mkInput('number', m?.birth_year || '', 'e.g. 2019')
  byInp.min = 1940; byInp.max = new Date().getFullYear()

  form.append(
    mkField('Name *', nameInp),
    mkField('Role', roleSelEl),
    mkField('Birth year (optional)', byInp),
  )

  // Allergies
  const allergyContainer = mkRepeatableContainer()
  ;(m?.allergies || []).forEach(a => allergyContainer.appendChild(mkAllergyRow(a)))
  form.append(
    mkRepeatableField('Allergies', allergyContainer,
      () => allergyContainer.appendChild(mkAllergyRow({ substance: '', severity: 'allergy', notes: '' })))
  )

  // Preferences
  const prefContainer = mkRepeatableContainer()
  ;(m?.preferences || []).forEach(p => prefContainer.appendChild(mkPrefRow(p)))
  form.append(
    mkRepeatableField('Preferences / notes', prefContainer,
      () => prefContainer.appendChild(mkPrefRow({ type: 'preference', text: '' })))
  )

  form.appendChild(mkCheckboxRow('Core household member', m?.is_default_household ?? true, 'hhCheck'))
  form.appendChild(mkCheckboxRow('Active', m?.active ?? true, 'activeCheck'))

  const { save, cancel } = mkActions()
  cancel.addEventListener('click', async () => { await load(); renderList() })
  save.addEventListener('click', async () => {
    const name = nameInp.value.trim()
    if (!name) { toast('Name is required', { error: true }); return }
    const payload = {
      name,
      role: roleSelEl.value,
      birth_year: parseInt(byInp.value) || null,
      allergies: collectRows(allergyContainer, r => ({
        substance: r.querySelector('[data-f="substance"]').value.trim(),
        severity:  r.querySelector('[data-f="severity"]').value,
        notes:     r.querySelector('[data-f="notes"]').value.trim(),
      })).filter(a => a.substance),
      preferences: collectRows(prefContainer, r => ({
        type: r.querySelector('[data-f="type"]').value,
        text: r.querySelector('[data-f="text"]').value.trim(),
      })).filter(p => p.text),
      is_default_household: form.querySelector('#hhCheck').checked,
      active: form.querySelector('#activeCheck').checked,
    }
    save.disabled = true; save.textContent = 'Saving…'
    const op = editId
      ? supabase.from('family_members').update(payload).eq('id', editId)
      : supabase.from('family_members').insert(payload)
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

function mkAllergyRow(data) {
  const row = document.createElement('div')
  row.className = 'su-rpt-row'
  const sub = mkInp('text', data.substance || '', 'Substance'); sub.dataset.f = 'substance'
  const sev = mkSel([['intolerance','Intolerance'],['allergy','Allergy']], data.severity || 'allergy'); sev.dataset.f = 'severity'
  const notes = mkInp('text', data.notes || '', 'Notes'); notes.dataset.f = 'notes'
  const rm = mkRm(() => row.remove())
  row.append(sub, sev, notes, rm)
  return row
}

function mkPrefRow(data) {
  const row = document.createElement('div')
  row.className = 'su-rpt-row'
  const type = mkSel([['preference','Preference'],['note','Note']], data.type || 'preference'); type.dataset.f = 'type'
  const text = mkInp('text', data.text || '', 'Details'); text.dataset.f = 'text'
  const rm = mkRm(() => row.remove())
  row.append(type, text, rm)
  return row
}

// ── Shared form helpers ───────────────────────────────────
function mkInput(type, value, placeholder) {
  const el = document.createElement('input')
  el.type = type; el.className = 'su-input'; el.value = value
  if (placeholder) el.placeholder = placeholder
  return el
}
function mkInp(type, value, placeholder) { return mkInput(type, value, placeholder) }
function mkSel(opts, val) {
  const el = document.createElement('select'); el.className = 'su-select su-sel-sm'
  opts.forEach(([v, l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; if (v === val) o.selected = true; el.appendChild(o) })
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
function mkRepeatableContainer() {
  const c = document.createElement('div'); c.className = 'su-rpt'; return c
}
function mkRepeatableField(label, container, onAdd) {
  const w = document.createElement('div'); w.className = 'su-field'
  const l = document.createElement('div'); l.className = 'su-label'; l.textContent = label
  const addBtn = document.createElement('button'); addBtn.type = 'button'; addBtn.className = 'su-rpt-add'
  addBtn.textContent = '+ Add'; addBtn.addEventListener('click', onAdd)
  w.append(l, container, addBtn); return w
}
function mkRm(fn) {
  const b = document.createElement('button'); b.type = 'button'; b.className = 'su-rpt-rm'; b.textContent = '×'
  b.addEventListener('click', fn); return b
}
function mkActions() {
  const save   = document.createElement('button'); save.className = 'su-btn-primary'; save.textContent = 'Save'
  const cancel = document.createElement('button'); cancel.className = 'su-btn-ghost';  cancel.textContent = 'Cancel'
  return { save, cancel }
}
function collectRows(container, mapper) {
  return Array.from(container.querySelectorAll('.su-rpt-row')).map(mapper)
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
function fmtRole(r) {
  return { adult: 'Adult', child: 'Child', guest_regular: 'Regular guest' }[r] || r || ''
}

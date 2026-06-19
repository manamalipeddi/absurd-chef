import { supabase, navigateTo, toast } from '../app.js'

const TYPE_OPTS = [
  ['kids_home',   'Kid(s) home'],
  ['guests',      'Guests visiting'],
  ['gintas_away', 'Gintas away'],
]
const TYPE_BADGE = {
  kids_home:        'su-sd-badge su-sd-kids',
  // legacy values — kept for any rows not yet migrated
  holiday:          'su-sd-badge su-sd-kids',
  preschool_closed: 'su-sd-badge su-sd-kids',
  guests:           'su-sd-badge su-sd-guests',
  gintas_away:      'su-sd-badge su-sd-gintas',
}
const TYPE_LABEL = {
  kids_home:        'Kid(s) home',
  holiday:          'Kid(s) home',
  preschool_closed: 'Kid(s) home',
  guests:           'Guests visiting',
  gintas_away:      'Gintas away',
}

let screenEl  = null
let days      = []
let editId    = null

export function init(el) { screenEl = el }

export async function activate({ headerLeft, headerRight }) {
  headerLeft.innerHTML = backBtn('ssd-back')
  headerRight.innerHTML = ''
  document.getElementById('ssd-back').addEventListener('click', () => navigateTo('setup'))
  editId = null
  await load()
  renderList()
}

async function load() {
  const today = new Date().toISOString().split('T')[0]
  const { data } = await supabase
    .from('special_days').select('*')
    .gte('day', today).order('day')
  days = data || []
}

// ── List ──────────────────────────────────────────────────
function renderList() {
  screenEl.innerHTML = ''
  screenEl.appendChild(mkAddBtn('+ Add special day', () => openForm(null)))

  if (!days.length) {
    screenEl.appendChild(mkEmpty('No upcoming special days.'))
    return
  }

  const card = document.createElement('div')
  card.className = 'card su-card'
  days.forEach((d, i) => card.appendChild(buildRow(d, i < days.length - 1)))
  screenEl.appendChild(card)
}

function buildRow(d, ruled) {
  const row = document.createElement('div')
  row.className = 'su-list-row' + (ruled ? ' su-list-row--ruled' : '')

  const centre = document.createElement('div')
  centre.className = 'su-list-row__centre'
  const main = document.createElement('div')
  main.className = 'su-list-row__main'
  main.textContent = fmtDate(d.day)
  const sub = document.createElement('div')
  sub.className = 'su-list-row__sub'
  const parts = []
  if (d.guest_count > 0) parts.push(`${d.guest_count} guests`)
  if (d.guest_names) parts.push(d.guest_names)
  if (d.notes) parts.push(d.notes)
  sub.textContent = parts.join(' · ')
  centre.append(main, sub)
  row.appendChild(centre)

  const badge = document.createElement('span')
  badge.className = TYPE_BADGE[d.type] || 'su-sd-badge'
  badge.textContent = TYPE_LABEL[d.type] || d.type
  row.appendChild(badge)

  // Delete button
  const del = document.createElement('button')
  del.className = 'su-del-btn'
  del.title = 'Delete'
  del.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
    <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/>
  </svg>`
  del.addEventListener('click', async e => {
    e.stopPropagation()
    if (!confirm('Delete this day?')) return
    await supabase.from('special_days').delete().eq('id', d.id)
    await load(); renderList()
  })
  row.appendChild(del)

  row.addEventListener('click', () => openForm(d.id))
  return row
}

// ── Form ──────────────────────────────────────────────────
function openForm(id) {
  editId = id
  const d = id ? days.find(x => x.id === id) : null
  screenEl.innerHTML = ''
  const form = document.createElement('div')
  form.className = 'su-form'

  // Range toggle (add only)
  let isRange = false
  const singleDateInp = mkDateInput(d?.day || today())
  const rangeWrap = document.createElement('div')
  rangeWrap.style.display = 'none'
  const startInp = mkDateInput(today()), endInp = mkDateInput(today())
  const rangeRow = document.createElement('div')
  rangeRow.className = 'su-range-row'
  rangeRow.append(startInp, document.createTextNode(' → '), endInp)
  rangeWrap.appendChild(rangeRow)

  if (!editId) {
    const toggleLabel = document.createElement('label')
    toggleLabel.className = 'su-checkbox-row'
    const toggleInp = document.createElement('input')
    toggleInp.type = 'checkbox'
    const toggleSpan = document.createElement('span')
    toggleSpan.textContent = 'Date range'
    toggleLabel.append(toggleInp, toggleSpan)
    toggleInp.addEventListener('change', () => {
      isRange = toggleInp.checked
      singleDateInp.style.display = isRange ? 'none' : ''
      rangeWrap.style.display = isRange ? '' : 'none'
    })
    form.appendChild(mkField('Date', singleDateInp))
    form.appendChild(toggleLabel)
    form.appendChild(rangeWrap)
  } else {
    form.appendChild(mkField('Date', singleDateInp))
  }

  const typeSelEl = mkSelect(TYPE_OPTS, (d?.type === 'holiday' || d?.type === 'preschool_closed') ? 'kids_home' : (d?.type || 'kids_home'))
  form.appendChild(mkField('Type', typeSelEl))

  // Guest fields — only shown when type = guests
  const guestCountInp = mkInput('number', d?.guest_count || '', '0'); guestCountInp.min = 0
  const guestNamesInp = mkInput('text',   d?.guest_names || '', 'e.g. Gintas\' parents')
  const guestCountField = mkField('Guest count', guestCountInp)
  const guestNamesField = mkField('Guest names (optional)', guestNamesInp)

  function toggleGuestFields() {
    const show = typeSelEl.value === 'guests'
    guestCountField.style.display = show ? '' : 'none'
    guestNamesField.style.display = show ? '' : 'none'
  }
  typeSelEl.addEventListener('change', toggleGuestFields)
  form.append(guestCountField, guestNamesField)
  toggleGuestFields()

  const notesInp = mkInput('text', d?.notes || '', 'Optional notes')
  form.appendChild(mkField('Notes (optional)', notesInp))

  const { save, cancel } = mkActions()
  cancel.addEventListener('click', async () => { await load(); renderList() })
  save.addEventListener('click', async () => {
    save.disabled = true; save.textContent = 'Saving…'

    const basePayload = {
      type:        typeSelEl.value,
      guest_count: typeSelEl.value === 'guests' ? (parseInt(guestCountInp.value) || 0) : 0,
      guest_names: typeSelEl.value === 'guests' ? guestNamesInp.value.trim() || null : null,
      notes:       notesInp.value.trim() || null,
    }

    let error
    if (editId) {
      ;({ error } = await supabase.from('special_days')
        .update({ ...basePayload, day: singleDateInp.value })
        .eq('id', editId))
    } else if (isRange) {
      const dates = dateRange(startInp.value, endInp.value)
      if (!dates.length) { toast('Invalid date range', { error: true }); save.disabled = false; save.textContent = 'Save'; return }
      ;({ error } = await supabase.from('special_days').insert(dates.map(day => ({ ...basePayload, day }))))
    } else {
      ;({ error } = await supabase.from('special_days').insert({ ...basePayload, day: singleDateInp.value }))
    }

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
function today() { return new Date().toISOString().split('T')[0] }

function dateRange(start, end) {
  if (!start || !end || start > end) return []
  const dates = [], cur = new Date(start + 'T00:00:00')
  const endDate = new Date(end + 'T00:00:00')
  while (cur <= endDate) { dates.push(cur.toISOString().split('T')[0]); cur.setDate(cur.getDate() + 1) }
  return dates
}

function fmtDate(iso) {
  const d = new Date(iso + 'T12:00:00')
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
}

function mkDateInput(value) {
  const el = document.createElement('input'); el.type = 'date'; el.className = 'su-input'; el.value = value; return el
}
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

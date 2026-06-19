import { supabase, FUNCTIONS_URL, navigateTo, toast } from '../app.js'

const TYPE_OPTS = [
  ['kids_home',   'Kid(s) home'],
  ['guests',      'Guests visiting'],
  ['gintas_away', 'Gintas away'],
]
const TYPE_BADGE = {
  kids_home:        'su-sd-badge su-sd-kids',
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

let screenEl      = null
let days          = []
let guestMembers  = []
let editId        = null

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
  const [sdRes, gmRes] = await Promise.all([
    supabase.from('special_days').select('*').gte('day', today).order('day'),
    supabase.from('family_members').select('id, name, allergies')
      .eq('role', 'guest').eq('active', true).order('name'),
  ])
  days         = sdRes.data || []
  guestMembers = gmRes.data || []
}

// ── List ──────────────────────────────────────────────
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

  if (d.type === 'guests') {
    const knownIds = d.guest_family_member_ids || []
    const knownNames = knownIds
      .map(id => guestMembers.find(m => m.id === id)?.name)
      .filter(Boolean)
    if (knownNames.length) parts.push(knownNames.join(', '))
    const oneOffCount = Math.max(0, (d.guest_count || 0) - knownIds.length)
    if (oneOffCount > 0) parts.push(`+${oneOffCount} extra`)
    // backward compat: if old-style guest_names present and no ids yet
    if (!knownIds.length && d.guest_names) parts.push(d.guest_names)
  } else {
    if (d.guest_count > 0) parts.push(`${d.guest_count} guests`)
    if (d.guest_names) parts.push(d.guest_names)
  }
  if (d.notes) parts.push(d.notes)
  sub.textContent = parts.join(' · ')
  centre.append(main, sub)
  row.appendChild(centre)

  const badge = document.createElement('span')
  badge.className = TYPE_BADGE[d.type] || 'su-sd-badge'
  badge.textContent = TYPE_LABEL[d.type] || d.type
  row.appendChild(badge)

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

// ── Form ──────────────────────────────────────────────
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

  const typeSelEl = mkSelect(TYPE_OPTS,
    (d?.type === 'holiday' || d?.type === 'preschool_closed') ? 'kids_home' : (d?.type || 'kids_home'))
  form.appendChild(mkField('Type', typeSelEl))

  // Guest section (only shown when type = guests)
  const guestWrap = buildGuestSection(d)
  function toggleGuestSection() {
    guestWrap.style.display = typeSelEl.value === 'guests' ? '' : 'none'
  }
  typeSelEl.addEventListener('change', toggleGuestSection)
  form.appendChild(guestWrap)
  toggleGuestSection()

  const notesInp = mkInput('text', d?.notes || '', 'Optional notes')
  form.appendChild(mkField('Notes (optional)', notesInp))

  const { save, cancel } = mkActions()
  cancel.addEventListener('click', async () => { await load(); renderList() })
  save.addEventListener('click', async () => {
    save.disabled = true; save.textContent = 'Saving…'

    const guestData = collectGuestData(guestWrap, typeSelEl.value)
    const basePayload = {
      type:                    typeSelEl.value,
      guest_count:             typeSelEl.value === 'guests' ? guestData.total_count : 0,
      guest_names:             null,
      guest_family_member_ids: typeSelEl.value === 'guests' ? guestData.member_ids : [],
      guest_allergies:         typeSelEl.value === 'guests' ? guestData.allergies  : [],
      notes:                   notesInp.value.trim() || null,
    }

    let error, savedDates = []
    if (editId) {
      ;({ error } = await supabase.from('special_days')
        .update({ ...basePayload, day: singleDateInp.value })
        .eq('id', editId))
      savedDates = [singleDateInp.value]
    } else if (isRange) {
      const dates = dateRange(startInp.value, endInp.value)
      if (!dates.length) { toast('Invalid date range', { error: true }); save.disabled = false; save.textContent = 'Save'; return }
      ;({ error } = await supabase.from('special_days').insert(dates.map(day => ({ ...basePayload, day }))))
      savedDates = dates
    } else {
      ;({ error } = await supabase.from('special_days').insert({ ...basePayload, day: singleDateInp.value }))
      savedDates = [singleDateInp.value]
    }

    if (error) { toast('Save failed', { error: true }); save.disabled = false; save.textContent = 'Save'; return }

    const hasGuestData = guestData.member_ids.length > 0 || guestData.allergies.length > 0
    if (typeSelEl.value === 'guests' && hasGuestData && savedDates.length === 1) {
      save.textContent = 'Updating plan…'
      try {
        const res = await fetch(`${FUNCTIONS_URL}/plan-generator`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ mode: 'targeted', start_date: savedDates[0], days: 1 }),
        })
        const json = await res.json()
        if (json.success) {
          toast(`Saved — plan updated for ${fmtDateShort(savedDates[0])}`)
        } else {
          toast('Saved — tap ✨ in Plan to regenerate')
        }
      } catch {
        toast('Saved — tap ✨ in Plan to regenerate')
      }
    } else if (typeSelEl.value === 'guests' && hasGuestData && savedDates.length > 1) {
      toast('Saved — tap ✨ in Plan to update affected days')
    } else {
      toast('Saved')
    }

    await load(); renderList()
  })

  const actionsWrap = document.createElement('div')
  actionsWrap.className = 'su-actions'
  actionsWrap.append(cancel, save)
  form.appendChild(actionsWrap)
  screenEl.appendChild(form)
}

// ── Guest section builder ─────────────────────────────
function buildGuestSection(d) {
  const wrap = document.createElement('div')
  wrap.className = 'su-guest-wrap'

  // ── Part A: Known guests ──
  const knownPart = document.createElement('div')
  knownPart.className = 'su-guest-part'

  const knownHeading = document.createElement('div')
  knownHeading.className = 'su-guest-heading'
  knownHeading.textContent = 'Known guests'
  knownPart.appendChild(knownHeading)

  const checklist = document.createElement('div')
  checklist.className = 'su-guest-checklist'
  const selectedIds = new Set(d?.guest_family_member_ids || [])
  if (guestMembers.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'su-guest-empty'
    empty.textContent = 'No recurring guests yet — add them via Family setup.'
    checklist.appendChild(empty)
  } else {
    guestMembers.forEach(m => checklist.appendChild(buildGuestCheckItem(m, selectedIds.has(m.id))))
  }
  knownPart.appendChild(checklist)

  // + Add a new guest link
  const addLink = document.createElement('button')
  addLink.type = 'button'
  addLink.className = 'su-guest-addlink'
  addLink.textContent = '+ Add a new guest'

  const quickAdd = buildQuickAddForm(checklist, addLink)
  knownPart.append(addLink, quickAdd)
  wrap.appendChild(knownPart)

  // ── Part B: One-off guests ──
  const oneOffPart = document.createElement('div')
  oneOffPart.className = 'su-guest-part'

  const oneOffHeading = document.createElement('div')
  oneOffHeading.className = 'su-guest-heading'
  oneOffHeading.textContent = 'Extra guests (first time / one-off)'
  oneOffPart.appendChild(oneOffHeading)

  const knownCount = d?.guest_family_member_ids?.length || 0
  const oneOffCount = Math.max(0, (d?.guest_count || 0) - knownCount)
  const countInp = mkInput('number', oneOffCount || '', '0')
  countInp.id = 'sd-one-off-count'
  countInp.min = 0
  oneOffPart.appendChild(mkField('How many extra?', countInp))

  const allergyContainer = document.createElement('div')
  allergyContainer.className = 'su-rpt su-one-off-allergies'
  ;(d?.guest_allergies || []).forEach(a => allergyContainer.appendChild(mkAllergyRow(a)))
  oneOffPart.appendChild(mkRepeatableField('Allergens (optional)', allergyContainer,
    () => allergyContainer.appendChild(mkAllergyRow({ substance: '', severity: 'allergy', notes: '' }))))

  wrap.appendChild(oneOffPart)
  return wrap
}

function buildGuestCheckItem(m, checked) {
  const label = document.createElement('label')
  label.className = 'su-guest-checklist-item'
  const cb = document.createElement('input')
  cb.type = 'checkbox'
  cb.className = 'su-guest-cb'
  cb.value = m.id
  cb.checked = checked
  const nameSpan = document.createElement('span')
  nameSpan.className = 'su-guest-checklist-name'
  nameSpan.textContent = m.name
  if (m.allergies?.length) {
    const tag = document.createElement('span')
    tag.className = 'su-guest-checklist-allergies'
    tag.textContent = m.allergies.map(a => a.substance).filter(Boolean).join(', ')
    nameSpan.append(' ', tag)
  }
  label.append(cb, nameSpan)
  return label
}

function buildQuickAddForm(checklist, toggleBtn) {
  const wrap = document.createElement('div')
  wrap.className = 'su-quick-add'
  wrap.style.display = 'none'

  const nameInp = mkInput('text', '', 'Name')
  wrap.appendChild(mkField('Name *', nameInp))

  const allergyContainer = document.createElement('div')
  allergyContainer.className = 'su-rpt'
  wrap.appendChild(mkRepeatableField('Allergies', allergyContainer,
    () => allergyContainer.appendChild(mkAllergyRow({ substance: '', severity: 'allergy', notes: '' }))))

  const prefContainer = document.createElement('div')
  prefContainer.className = 'su-rpt'
  wrap.appendChild(mkRepeatableField('Preferences / notes', prefContainer,
    () => prefContainer.appendChild(mkPrefRow({ type: 'preference', text: '' }))))

  const btnRow = document.createElement('div')
  btnRow.className = 'su-actions'
  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'su-btn-ghost'
  cancelBtn.textContent = 'Cancel'
  const addBtn = document.createElement('button')
  addBtn.type = 'button'
  addBtn.className = 'su-btn-primary'
  addBtn.textContent = 'Add guest'
  btnRow.append(cancelBtn, addBtn)
  wrap.appendChild(btnRow)

  toggleBtn.addEventListener('click', () => {
    const isOpen = wrap.style.display !== 'none'
    wrap.style.display = isOpen ? 'none' : ''
    toggleBtn.textContent = isOpen ? '+ Add a new guest' : 'Cancel adding'
    if (!isOpen) nameInp.focus()
  })
  cancelBtn.addEventListener('click', () => {
    wrap.style.display = 'none'
    toggleBtn.textContent = '+ Add a new guest'
  })

  addBtn.addEventListener('click', async () => {
    const name = nameInp.value.trim()
    if (!name) { toast('Name is required', { error: true }); return }
    addBtn.disabled = true; addBtn.textContent = 'Adding…'

    const allergies = collectRows(allergyContainer, r => ({
      substance: r.querySelector('[data-f="substance"]').value.trim(),
      severity:  r.querySelector('[data-f="severity"]').value,
      notes:     r.querySelector('[data-f="notes"]').value.trim(),
    })).filter(a => a.substance)

    const preferences = collectRows(prefContainer, r => ({
      type: r.querySelector('[data-f="type"]').value,
      text: r.querySelector('[data-f="text"]').value.trim(),
    })).filter(p => p.text)

    const { data, error } = await supabase.from('family_members').insert({
      name, allergies, preferences,
      role: 'guest', is_default_household: false, active: true,
    }).select('id, name, allergies').single()

    if (error) {
      toast('Failed to add guest', { error: true })
      addBtn.disabled = false; addBtn.textContent = 'Add guest'
      return
    }

    guestMembers.push(data)
    checklist.querySelector('.su-guest-empty')?.remove()
    checklist.appendChild(buildGuestCheckItem(data, true))
    toast(`${data.name} added`)
    wrap.style.display = 'none'
    toggleBtn.textContent = '+ Add a new guest'
    // reset form
    nameInp.value = ''
    allergyContainer.innerHTML = ''
    prefContainer.innerHTML = ''
    addBtn.disabled = false; addBtn.textContent = 'Add guest'
  })

  return wrap
}

function collectGuestData(guestWrap, type) {
  if (type !== 'guests') return { member_ids: [], allergies: [], total_count: 0 }
  const member_ids = [...guestWrap.querySelectorAll('.su-guest-cb:checked')].map(cb => cb.value)
  const oneOffCount = parseInt(guestWrap.querySelector('#sd-one-off-count')?.value) || 0
  const allergyContainer = guestWrap.querySelector('.su-one-off-allergies')
  const allergies = allergyContainer
    ? collectRows(allergyContainer, r => ({
        substance: r.querySelector('[data-f="substance"]').value.trim(),
        severity:  r.querySelector('[data-f="severity"]').value,
        notes:     r.querySelector('[data-f="notes"]').value.trim(),
      })).filter(a => a.substance)
    : []
  return { member_ids, allergies, total_count: member_ids.length + oneOffCount }
}

// ── Helpers ───────────────────────────────────────────
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

function fmtDateShort(iso) {
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
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

function mkRepeatableField(label, container, onAdd) {
  const w = document.createElement('div'); w.className = 'su-field'
  const l = document.createElement('div'); l.className = 'su-label'; l.textContent = label
  const addBtn = document.createElement('button'); addBtn.type = 'button'; addBtn.className = 'su-rpt-add'
  addBtn.textContent = '+ Add'; addBtn.addEventListener('click', onAdd)
  w.append(l, container, addBtn); return w
}

function mkInp(type, value, placeholder) {
  const el = document.createElement('input')
  el.type = type; el.className = 'su-input'; el.value = value
  if (placeholder) el.placeholder = placeholder
  return el
}

function mkSel(opts, val) {
  const el = document.createElement('select'); el.className = 'su-select su-sel-sm'
  opts.forEach(([v, l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; if (v === val) o.selected = true; el.appendChild(o) })
  return el
}

function collectRows(container, mapper) {
  return Array.from(container.querySelectorAll('.su-rpt-row')).map(mapper)
}

function mkRm(fn) {
  const b = document.createElement('button'); b.type = 'button'; b.className = 'su-rpt-rm'; b.textContent = '×'
  b.addEventListener('click', fn); return b
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

import { supabase, FUNCTIONS_URL, navigateTo, toast } from '../app.js'

const DAY_LABELS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri']
const PROTEINS   = ['chicken','beef','pork','fish','vegetarian','egg']
const WEIGHTS    = [['light','Light'],['medium','Medium'],['heavy','Heavy']]

let screenEl   = null
let viewMode   = 'display'  // 'display' | 'paste'
let parsedRows = null       // rows returned by AI before save

export function init(el) { screenEl = el }

export async function activate({ headerLeft, headerRight }) {
  headerLeft.innerHTML = backBtn('spm-back')
  headerRight.innerHTML = ''
  document.getElementById('spm-back').addEventListener('click', () => navigateTo('setup'))
  viewMode = 'display'
  parsedRows = null
  await renderDisplay()
}

// ── Display ───────────────────────────────────────────────
async function renderDisplay() {
  screenEl.innerHTML = `<div class="loading-row"><div class="spinner"></div>Loading…</div>`

  const currentWeek = getISOWeek()
  const { data: currentRows } = await supabase
    .from('preschool_meals').select('*')
    .eq('iso_week', currentWeek).order('day_of_week')

  if (currentRows?.length) {
    showTable(currentRows, currentWeek, false)
    return
  }

  // Find most recent past week
  const { data: pastRows } = await supabase
    .from('preschool_meals').select('*')
    .lt('iso_week', currentWeek).order('iso_week', { ascending: false }).limit(5)

  screenEl.innerHTML = ''

  if (pastRows?.length) {
    const staleWeek = pastRows[0].iso_week
    const staleData = pastRows.filter(r => r.iso_week === staleWeek)
    const banner = document.createElement('div')
    banner.className = 'pm-stale-banner'
    banner.textContent = `⚠ Showing last week's menu (${staleWeek}) — paste this week's if you have it.`
    screenEl.appendChild(banner)
    showTable(staleData, staleWeek, true)
  } else {
    const empty = document.createElement('div')
    empty.className = 'pm-empty-state'
    empty.innerHTML = `<p class="su-empty">No preschool menu added yet for this week (${currentWeek}).</p>`
    screenEl.appendChild(empty)
    showPasteBox()
  }
}

function showTable(rows, isoWeek, stale) {
  const header = document.createElement('div')
  header.className = 'pm-week-header'
  header.textContent = isoWeek

  const table = document.createElement('div')
  table.className = 'pm-table'

  rows.forEach(r => {
    const row = document.createElement('div')
    row.className = 'pm-row'

    const day = document.createElement('span')
    day.className = 'pm-day'
    day.textContent = DAY_LABELS[r.day_of_week] || String(r.day_of_week)

    const centre = document.createElement('div')
    centre.className = 'pm-centre'

    const desc = document.createElement('div')
    desc.className = 'pm-desc' + (stale ? ' pm-desc--stale' : '')
    desc.textContent = r.meal_description || '—'

    const meta = document.createElement('div')
    meta.className = 'pm-meta'
    const pb = mkBadge(r.protein, 'pm-badge pm-badge-protein')
    const wb = mkBadge(r.lunch_weight, `pm-badge pm-badge-weight-${r.lunch_weight || 'medium'}`)
    meta.append(pb, wb)

    centre.append(desc, meta)
    row.append(day, centre)
    table.appendChild(row)
  })

  if (!stale) {
    // Add Edit button per row
    rows.forEach((r, idx) => {
      const row = table.children[idx]
      const editBtn = document.createElement('button')
      editBtn.className = 'pm-edit-btn'
      editBtn.textContent = 'Edit'
      editBtn.addEventListener('click', () => openInlineEdit(row, r))
      row.appendChild(editBtn)
    })
  }

  screenEl.appendChild(header)
  screenEl.appendChild(table)

  const repaste = document.createElement('button')
  repaste.className = 'pm-repaste-btn'
  repaste.textContent = '↩ Paste this week\'s menu'
  repaste.addEventListener('click', () => { screenEl.innerHTML = ''; showPasteBox() })
  screenEl.appendChild(repaste)
}

function openInlineEdit(rowEl, r) {
  const centre = rowEl.querySelector('.pm-centre')
  const descEl = rowEl.querySelector('.pm-desc')
  const metaEl = rowEl.querySelector('.pm-meta')
  const editBtn = rowEl.querySelector('.pm-edit-btn')

  editBtn.style.display = 'none'
  descEl.style.display = 'none'
  metaEl.style.display = 'none'

  const descInp = document.createElement('input')
  descInp.className = 'pm-desc-input'
  descInp.value = r.meal_description || ''

  const proteinSel = document.createElement('select')
  proteinSel.className = 'pm-sel-small'
  PROTEINS.forEach(p => { const o = document.createElement('option'); o.value = p; o.textContent = p; if (p === r.protein) o.selected = true; proteinSel.appendChild(o) })

  const weightSel = document.createElement('select')
  weightSel.className = 'pm-sel-small'
  WEIGHTS.forEach(([v, l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; if (v === r.lunch_weight) o.selected = true; weightSel.appendChild(o) })

  const selRow = document.createElement('div')
  selRow.className = 'pm-sel-row'
  selRow.append(proteinSel, weightSel)

  const saveInline = document.createElement('button')
  saveInline.className = 'pm-inline-save'
  saveInline.textContent = 'Save'
  saveInline.addEventListener('click', async () => {
    saveInline.disabled = true; saveInline.textContent = '…'
    const { error } = await supabase.from('preschool_meals').update({
      meal_description: descInp.value.trim(),
      protein:          proteinSel.value,
      lunch_weight:     weightSel.value,
    }).eq('id', r.id)
    if (error) { toast('Save failed', { error: true }); saveInline.disabled = false; saveInline.textContent = 'Save'; return }
    toast('Saved')
    await renderDisplay()
  })

  centre.append(descInp, selRow, saveInline)
}

// ── Paste & Parse ──────────────────────────────────────────
function showPasteBox() {
  const section = document.createElement('div')
  section.className = 'pm-paste-section'

  const lbl = document.createElement('p')
  lbl.className = 'pm-paste-label'
  lbl.textContent = "Paste this week's preschool menu here (the translated English version)."

  const area = document.createElement('textarea')
  area.className = 'pm-paste-area'
  area.placeholder = 'Monday: Chicken stew with rice (chicken, onion, carrot) (Veg: lentil stew)\nTuesday: …'

  const parseBtn = document.createElement('button')
  parseBtn.className = 'pm-parse-btn'
  parseBtn.textContent = 'Parse menu'
  parseBtn.addEventListener('click', async () => {
    const text = area.value.trim()
    if (!text) { toast('Paste the menu first', { error: true }); return }
    parseBtn.disabled = true; parseBtn.textContent = 'Parsing…'
    try {
      const res = await fetch(`${FUNCTIONS_URL}/recipe-agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'parse_preschool_menu', raw_text: text, iso_week: getISOWeek() }),
      })
      const data = await res.json()
      if (!data.meals?.length) { toast('Could not parse menu — check the text and try again', { error: true }); parseBtn.disabled = false; parseBtn.textContent = 'Parse menu'; return }
      parsedRows = data.meals
      showParsedReview()
    } catch {
      toast('Parse failed', { error: true }); parseBtn.disabled = false; parseBtn.textContent = 'Parse menu'
    }
  })

  section.append(lbl, area, parseBtn)
  screenEl.appendChild(section)
}

function showParsedReview() {
  screenEl.innerHTML = ''
  const isoWeek = getISOWeek()

  const header = document.createElement('div')
  header.className = 'pm-week-header'
  header.textContent = `Parsed — ${isoWeek} · Review and save`
  screenEl.appendChild(header)

  const table = document.createElement('div')
  table.className = 'pm-table'

  const editableRows = parsedRows.map(r => ({ ...r }))

  editableRows.forEach(r => {
    const row = document.createElement('div')
    row.className = 'pm-row'

    const day = document.createElement('span')
    day.className = 'pm-day'
    day.textContent = DAY_LABELS[r.day_of_week] || String(r.day_of_week)

    const centre = document.createElement('div')
    centre.className = 'pm-centre'

    const descInp = document.createElement('input')
    descInp.className = 'pm-desc-input'
    descInp.value = r.meal_description || ''
    descInp.addEventListener('input', () => { r.meal_description = descInp.value })

    const selRow = document.createElement('div')
    selRow.className = 'pm-sel-row'

    const proteinSel = document.createElement('select')
    proteinSel.className = 'pm-sel-small'
    PROTEINS.forEach(p => { const o = document.createElement('option'); o.value = p; o.textContent = p; if (p === r.protein) o.selected = true; proteinSel.appendChild(o) })
    proteinSel.addEventListener('change', () => { r.protein = proteinSel.value })

    const weightSel = document.createElement('select')
    weightSel.className = 'pm-sel-small'
    WEIGHTS.forEach(([v, l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; if (v === r.lunch_weight) o.selected = true; weightSel.appendChild(o) })
    weightSel.addEventListener('change', () => { r.lunch_weight = weightSel.value })

    selRow.append(proteinSel, weightSel)
    centre.append(descInp, selRow)
    row.append(day, centre)
    table.appendChild(row)
  })

  screenEl.appendChild(table)

  // Save + Discard actions
  const actions = document.createElement('div')
  actions.className = 'su-actions'
  actions.style.padding = '0 16px 20px'

  const discardBtn = document.createElement('button')
  discardBtn.className = 'su-btn-ghost'
  discardBtn.textContent = 'Discard'
  discardBtn.addEventListener('click', () => { parsedRows = null; screenEl.innerHTML = ''; showPasteBox() })

  const saveBtn = document.createElement('button')
  saveBtn.className = 'su-btn-primary'
  saveBtn.textContent = 'Save this week'
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…'
    const monday = getMondayOfISOWeek(isoWeek)
    const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6)
    const validFrom  = monday.toISOString().split('T')[0]
    const validUntil = sunday.toISOString().split('T')[0]

    // Delete existing rows for this week, then insert new
    await supabase.from('preschool_meals').delete().eq('iso_week', isoWeek)
    const toInsert = editableRows.map(r => ({
      iso_week:         isoWeek,
      day_of_week:      r.day_of_week,
      meal_description: r.meal_description,
      protein:          r.protein,
      style:            r.style || null,
      lunch_weight:     r.lunch_weight || 'medium',
      raw_text:         r.raw_text || null,
      valid_from:       validFrom,
      valid_until:      validUntil,
    }))
    const { error } = await supabase.from('preschool_meals').insert(toInsert)
    if (error) { toast('Save failed', { error: true }); saveBtn.disabled = false; saveBtn.textContent = 'Save this week'; return }
    toast('Menu saved')
    parsedRows = null
    await renderDisplay()
  })

  actions.append(discardBtn, saveBtn)
  screenEl.appendChild(actions)
}

// ── ISO week helpers ──────────────────────────────────────
function getISOWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`
}

function getMondayOfISOWeek(isoWeek) {
  const [year, w] = isoWeek.split('-W').map(Number)
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const jan4Day = jan4.getUTCDay() || 7
  const monday = new Date(jan4)
  monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1 + (w - 1) * 7)
  return monday
}

// ── Shared helpers ────────────────────────────────────────
function mkBadge(text, cls) {
  if (!text) return document.createTextNode('')
  const b = document.createElement('span'); b.className = cls; b.textContent = text; return b
}

function backBtn(id) {
  return `<button class="header-btn" id="${id}">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5"/>
    </svg>
  </button>`
}

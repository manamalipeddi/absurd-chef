import { supabase, navigateTo, navState, toast } from '../app.js'

// ── Module state ──────────────────────────────────────────
let screenEl  = null
let tabBarEl  = null
let contentEl = null
let activeTab = 'inventory'

let inventoryData = []
let freezerData   = []
let preppedData   = []
let recipeList    = []   // for freezer link-to-recipe select

let showHiddenInventory = false
let showHiddenFreezer   = false

const catOpenState = { fridge: true, freezer: true, pantry: true }

const CAT_LABELS = { fridge: '🧊 Fridge', freezer: '❄️ Freezer', pantry: '🥫 Pantry' }
const CAT_LIST   = ['fridge', 'freezer', 'pantry']

// ── Lifecycle ─────────────────────────────────────────────
export function init(el) {
  screenEl = el
  screenEl.innerHTML = ''

  tabBarEl = document.createElement('div')
  tabBarEl.className = 'pn-tabbar'
  ;[['inventory','Inventory'],['freezer','Freezer'],['prepped','Prepped']].forEach(([id, label]) => {
    const btn = document.createElement('button')
    btn.className = 'pn-tab'
    btn.dataset.tab = id
    btn.textContent = label
    btn.addEventListener('click', () => switchTab(id))
    tabBarEl.appendChild(btn)
  })

  contentEl = document.createElement('div')
  contentEl.className = 'pn-content'

  screenEl.append(tabBarEl, contentEl)
}

export async function activate({ headerLeft, headerRight }) {
  headerLeft.innerHTML  = ''
  headerRight.innerHTML = ''
  showHiddenInventory = false
  showHiddenFreezer   = false
  activeTab = 'inventory'
  await loadAndShow('inventory')
}

async function switchTab(tab) {
  activeTab = tab
  updateTabBar()
  await loadAndShow(tab)
}

function updateTabBar() {
  tabBarEl.querySelectorAll('.pn-tab').forEach(b =>
    b.classList.toggle('pn-tab--active', b.dataset.tab === activeTab)
  )
}

async function loadAndShow(tab) {
  updateTabBar()
  contentEl.innerHTML = `<div class="loading-row"><div class="spinner"></div>Loading…</div>`
  if (tab === 'inventory') { await loadInventory(); renderInventory() }
  else if (tab === 'freezer') { await loadFreezer(); renderFreezer() }
  else { await loadPrepped(); renderPrepped() }
}

// ═══════════════════════════════════════════════════════════
// INVENTORY
// ═══════════════════════════════════════════════════════════

async function loadInventory() {
  const { data } = await supabase.from('inventory').select('*').order('name')
  inventoryData = data || []
}

function renderInventory() {
  contentEl.innerHTML = ''

  const addBtn = mkAddBtn('+ Add item', () => openInventoryForm(null, 'pantry'))
  contentEl.appendChild(addBtn)

  const tellBtn = document.createElement('button')
  tellBtn.className = 'pn-tell-btn'
  tellBtn.textContent = '🎤 Tell me what\'s in stock'
  tellBtn.addEventListener('click', () => navigateTo('chat'))
  contentEl.appendChild(tellBtn)

  const active = inventoryData.filter(i => i.active !== false)
  const hidden = inventoryData.filter(i => i.active === false)

  const bycat = {}
  active.forEach(item => {
    const c = item.category || 'pantry'
    ;(bycat[c] = bycat[c] || []).push(item)
  })

  const knownKeys = new Set(CAT_LIST)
  // Any unknown categories
  Object.keys(bycat).filter(k => !knownKeys.has(k)).forEach(k => {
    CAT_LIST.push(k); CAT_LABELS[k] = '📦 ' + k
  })

  let hasAny = false
  CAT_LIST.forEach(catKey => {
    const items = bycat[catKey]
    if (!items?.length) return
    hasAny = true
    contentEl.appendChild(buildInventorySection(catKey, items))
  })
  if (!hasAny) contentEl.appendChild(mkEmpty('No inventory items. Tap + to add.'))

  // Hidden items toggle
  if (hidden.length) {
    const toggle = document.createElement('button')
    toggle.className = 'pn-hidden-toggle'
    toggle.textContent = showHiddenInventory
      ? `Hide ${hidden.length} hidden item${hidden.length !== 1 ? 's' : ''}`
      : `Show ${hidden.length} hidden item${hidden.length !== 1 ? 's' : ''}`
    toggle.addEventListener('click', () => { showHiddenInventory = !showHiddenInventory; renderInventory() })
    contentEl.appendChild(toggle)

    if (showHiddenInventory) {
      const card = document.createElement('div')
      card.className = 'card pn-hidden-card'
      hidden.forEach((item, i) => {
        const row = document.createElement('div')
        row.className = 'pn-row' + (i < hidden.length - 1 ? ' pn-row--ruled' : '')
        const centre = document.createElement('div')
        centre.className = 'pn-row__centre'
        const main = document.createElement('div')
        main.className = 'pn-row__main pn-row__main--muted'
        main.textContent = item.name
        centre.appendChild(main)
        row.appendChild(centre)
        const unhide = document.createElement('button')
        unhide.className = 'pn-unhide-btn'
        unhide.textContent = 'Unhide'
        unhide.addEventListener('click', async e => {
          e.stopPropagation()
          await supabase.from('inventory').update({ active: true }).eq('id', item.id)
          await loadInventory(); renderInventory()
        })
        row.appendChild(unhide)
        card.appendChild(row)
      })
      contentEl.appendChild(card)
    }
  }
}

function buildInventorySection(catKey, items) {
  const wrap = document.createElement('div')
  wrap.className = 'pn-section'

  const header = document.createElement('div')
  header.className = 'pn-section-header'

  const toggleBtn = document.createElement('button')
  toggleBtn.className = 'pn-section-toggle'
  toggleBtn.setAttribute('aria-expanded', String(catOpenState[catKey] ?? true))

  const isOpen = catOpenState[catKey] ?? true
  toggleBtn.innerHTML = `
    <span class="pn-section-label">${CAT_LABELS[catKey] || catKey}</span>
    <span class="pn-section-count">(${items.length})</span>
    <svg class="pn-section-chev${isOpen ? ' pn-section-chev--open' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path stroke-linecap="round" stroke-linejoin="round" d="m19 9-7 7-7-7"/>
    </svg>`

  const addCatBtn = document.createElement('button')
  addCatBtn.className = 'pn-section-add'
  addCatBtn.textContent = '+'
  addCatBtn.title = `Add to ${catKey}`
  addCatBtn.addEventListener('click', e => { e.stopPropagation(); openInventoryForm(null, catKey) })

  header.append(toggleBtn, addCatBtn)

  const body = document.createElement('div')
  body.className = 'pn-section-body' + (isOpen ? '' : ' pn-section-body--hidden')

  const card = document.createElement('div')
  card.className = 'card pn-section-card'
  items.forEach((item, i) => card.appendChild(buildInventoryRow(item, i < items.length - 1)))
  body.appendChild(card)

  toggleBtn.addEventListener('click', () => {
    catOpenState[catKey] = !(catOpenState[catKey] ?? true)
    toggleBtn.setAttribute('aria-expanded', String(catOpenState[catKey]))
    body.classList.toggle('pn-section-body--hidden', !catOpenState[catKey])
    toggleBtn.querySelector('.pn-section-chev').classList.toggle('pn-section-chev--open', catOpenState[catKey])
  })

  wrap.append(header, body)
  return wrap
}

function buildInventoryRow(item, ruled) {
  const isOut = item.quantity == null || Number(item.quantity) === 0
  const row = document.createElement('div')
  row.className = 'pn-row' + (ruled ? ' pn-row--ruled' : '') + (isOut ? ' pn-row--out' : '')

  const centre = document.createElement('div')
  centre.className = 'pn-row__centre'
  const main = document.createElement('div')
  main.className = 'pn-row__main'
  main.textContent = item.name
  const meta = document.createElement('div')
  meta.className = 'pn-row__meta'
  const parts = []
  if (!isOut && item.quantity != null) parts.push(item.quantity + (item.unit ? ' ' + item.unit : ''))
  if (item.expiry_date) parts.push('exp ' + fmtShortDate(item.expiry_date))
  meta.textContent = parts.join(' · ')
  centre.append(main, meta)
  row.appendChild(centre)

  const right = document.createElement('div')
  right.className = 'pn-row__right'
  if (isOut) {
    const b = document.createElement('span'); b.className = 'pn-badge pn-badge-out'; b.textContent = 'Out'; right.appendChild(b)
  }
  if (item.source && item.source !== 'manual') {
    const b = document.createElement('span'); b.className = 'pn-badge pn-badge-source'; b.textContent = item.source; right.appendChild(b)
  }
  row.appendChild(right)

  row.addEventListener('click', () => openInventoryForm(item.id, item.category || 'pantry'))
  return row
}

// ── Inventory form ─────────────────────────────────────────
function openInventoryForm(id, defaultCat = 'pantry') {
  const item = id ? inventoryData.find(x => x.id === id) : null
  contentEl.innerHTML = ''

  const form = document.createElement('div')
  form.className = 'pn-form'

  const nameInp  = mkInput('text',   item?.name        || '', 'e.g. Greek yoghurt')
  const qtyInp   = mkInput('number', item?.quantity     ?? '', '')
  qtyInp.min = 0; qtyInp.step = 'any'
  const unitInp  = mkInput('text',   item?.unit         || '', 'e.g. litres')
  const catSel   = mkSelect([['fridge','Fridge'],['freezer','Freezer'],['pantry','Pantry']], item?.category || defaultCat)
  const expInp   = mkDateInput(item?.expiry_date || '')
  const notesInp = mkInput('text',   item?.notes        || '', 'Optional notes')

  const qtyRow = document.createElement('div')
  qtyRow.className = 'pn-form-row'
  qtyRow.append(mkField('Quantity', qtyInp, 'pn-form-col-sm'), mkField('Unit', unitInp, 'pn-form-col'))

  form.append(
    mkField('Name *', nameInp),
    qtyRow,
    mkField('Category', catSel),
    mkField('Expiry date (optional)', expInp),
    mkField('Notes (optional)', notesInp),
  )

  // Primary actions
  const actions = document.createElement('div')
  actions.className = 'su-actions'
  const cancelBtn = document.createElement('button'); cancelBtn.className = 'su-btn-ghost'; cancelBtn.textContent = 'Cancel'
  const saveBtn   = document.createElement('button'); saveBtn.className   = 'su-btn-primary'; saveBtn.textContent = 'Save'
  cancelBtn.addEventListener('click', async () => { await loadInventory(); renderInventory() })
  saveBtn.addEventListener('click', async () => {
    const name = nameInp.value.trim()
    if (!name) { toast('Name is required', { error: true }); return }
    const payload = {
      name,
      quantity:    qtyInp.value !== '' ? parseFloat(qtyInp.value) : null,
      unit:        unitInp.value.trim() || null,
      category:    catSel.value,
      expiry_date: expInp.value || null,
      notes:       notesInp.value.trim() || null,
    }
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…'
    const op = id
      ? supabase.from('inventory').update(payload).eq('id', id)
      : supabase.from('inventory').insert(payload)
    const { error } = await op
    if (error) { toast('Save failed', { error: true }); saveBtn.disabled = false; saveBtn.textContent = 'Save'; return }
    toast('Saved')
    await loadInventory(); renderInventory()
  })
  actions.append(cancelBtn, saveBtn)
  form.appendChild(actions)

  // Danger zone — only when editing
  if (id) {
    const danger = document.createElement('div')
    danger.className = 'pn-danger-zone'
    const hideBtn = document.createElement('button')
    hideBtn.className = 'pn-danger-btn'
    hideBtn.textContent = 'Hide this item'
    hideBtn.addEventListener('click', async () => {
      hideBtn.disabled = true
      await supabase.from('inventory').update({ active: false }).eq('id', id)
      toast('Item hidden')
      await loadInventory(); renderInventory()
    })
    danger.appendChild(hideBtn)
    form.appendChild(danger)
  }

  contentEl.appendChild(form)
}

// ═══════════════════════════════════════════════════════════
// FREEZER STASH
// ═══════════════════════════════════════════════════════════

async function loadFreezer() {
  const [stashRes, recipeRes] = await Promise.all([
    supabase.from('freezer_stash').select('*')
      .eq('used', false).eq('active', true)
      .order('frozen_date', { ascending: false }),
    supabase.from('recipes').select('id, name').eq('active', true).order('name'),
  ])
  freezerData = stashRes.data || []
  recipeList  = recipeRes.data || []
}

function renderFreezer() {
  contentEl.innerHTML = ''

  const addBtn = mkAddBtn('+ Add to freezer stash', () => openFreezerForm(null))
  contentEl.appendChild(addBtn)

  if (!freezerData.length) {
    contentEl.appendChild(mkEmpty('Freezer stash is empty.'))
  } else {
    const card = document.createElement('div')
    card.className = 'card su-card'
    freezerData.forEach((entry, i) => card.appendChild(buildFreezerRow(entry, i < freezerData.length - 1)))
    contentEl.appendChild(card)
  }

  // Hidden entries
  loadHiddenFreezerToggle()
}

async function loadHiddenFreezerToggle() {
  const { data: hidden } = await supabase.from('freezer_stash').select('*').eq('active', false)
  if (!hidden?.length) return

  const toggle = document.createElement('button')
  toggle.className = 'pn-hidden-toggle'
  toggle.textContent = showHiddenFreezer
    ? `Hide ${hidden.length} hidden item${hidden.length !== 1 ? 's' : ''}`
    : `Show ${hidden.length} hidden item${hidden.length !== 1 ? 's' : ''}`
  toggle.addEventListener('click', () => { showHiddenFreezer = !showHiddenFreezer; renderFreezer() })
  contentEl.appendChild(toggle)

  if (showHiddenFreezer) {
    const card = document.createElement('div')
    card.className = 'card pn-hidden-card'
    hidden.forEach((entry, i) => {
      const row = document.createElement('div')
      row.className = 'pn-row' + (i < hidden.length - 1 ? ' pn-row--ruled' : '')
      const centre = document.createElement('div')
      centre.className = 'pn-row__centre'
      const main = document.createElement('div')
      main.className = 'pn-row__main pn-row__main--muted'
      main.textContent = entry.recipe_name || '(unnamed)'
      centre.appendChild(main)
      row.appendChild(centre)
      const unhide = document.createElement('button')
      unhide.className = 'pn-unhide-btn'
      unhide.textContent = 'Unhide'
      unhide.addEventListener('click', async e => {
        e.stopPropagation()
        await supabase.from('freezer_stash').update({ active: true }).eq('id', entry.id)
        await loadFreezer(); renderFreezer()
      })
      row.appendChild(unhide)
      card.appendChild(row)
    })
    contentEl.appendChild(card)
  }
}

function buildFreezerRow(entry, ruled) {
  const isEmpty = entry.portions == null || Number(entry.portions) === 0
  const useByStatus = expiryStatus(entry.use_by_date)

  const row = document.createElement('div')
  row.className = 'pn-row' + (ruled ? ' pn-row--ruled' : '') + (isEmpty ? ' pn-row--out' : '')

  const centre = document.createElement('div')
  centre.className = 'pn-row__centre'
  const main = document.createElement('div')
  main.className = 'pn-row__main'
  main.textContent = entry.recipe_name || '(unnamed)'
  const meta = document.createElement('div')
  meta.className = 'pn-row__meta'
  const parts = []
  if (!isEmpty && entry.portions != null) parts.push(entry.portions + ' portion' + (entry.portions !== 1 ? 's' : ''))
  if (entry.frozen_date) parts.push('frozen ' + fmtShortDate(entry.frozen_date))
  if (entry.use_by_date) {
    const dateStr = 'use by ' + fmtShortDate(entry.use_by_date)
    if (useByStatus) {
      const span = document.createElement('span')
      span.className = `pn-expiry-${useByStatus}`
      span.textContent = dateStr
      meta.textContent = parts.join(' · ') + (parts.length ? ' · ' : '')
      meta.appendChild(span)
    } else {
      parts.push(dateStr)
    }
  }
  if (!entry.use_by_date || !useByStatus) meta.textContent = parts.join(' · ')
  centre.append(main, meta)
  row.appendChild(centre)

  const right = document.createElement('div')
  right.className = 'pn-row__right'
  if (isEmpty) {
    const b = document.createElement('span'); b.className = 'pn-badge pn-badge-out'; b.textContent = 'Empty'; right.appendChild(b)
  }
  if (entry.notes) {
    const b = document.createElement('span'); b.className = 'pn-badge pn-badge-note'; b.textContent = '📝'; b.title = entry.notes; right.appendChild(b)
  }
  row.appendChild(right)
  row.addEventListener('click', () => openFreezerForm(entry.id))
  return row
}

// ── Freezer form ───────────────────────────────────────────
function openFreezerForm(id) {
  const entry = id ? freezerData.find(x => x.id === id) : null
  contentEl.innerHTML = ''
  const form = document.createElement('div')
  form.className = 'pn-form'

  const nameInp     = mkInput('text',   entry?.recipe_name || '', 'Recipe name')
  const portionsInp = mkInput('number', entry?.portions    ?? '', '0'); portionsInp.min = 0
  const frozenInp   = mkDateInput(entry?.frozen_date  || '')
  const useByInp    = mkDateInput(entry?.use_by_date  || '')
  const notesInp    = mkInput('text',   entry?.notes        || '', 'Optional notes')

  // Recipe link
  const recipeOpts = [['', '— not linked —'], ...recipeList.map(r => [r.id, r.name])]
  const recipeSel = mkSelect(recipeOpts, entry?.recipe_id || '')
  recipeSel.addEventListener('change', () => {
    const chosen = recipeList.find(r => r.id === recipeSel.value)
    if (chosen && !nameInp.value.trim()) nameInp.value = chosen.name
  })

  form.append(
    mkField('Recipe name *', nameInp),
    mkField('Link to recipe (optional)', recipeSel),
    mkField('Portions', portionsInp),
    mkField('Frozen date (optional)', frozenInp),
    mkField('Use-by date (optional)', useByInp),
    mkField('Notes (optional)', notesInp),
  )

  const actions = document.createElement('div')
  actions.className = 'su-actions'
  const cancelBtn = document.createElement('button'); cancelBtn.className = 'su-btn-ghost';    cancelBtn.textContent = 'Cancel'
  const saveBtn   = document.createElement('button'); saveBtn.className   = 'su-btn-primary';  saveBtn.textContent   = 'Save'
  cancelBtn.addEventListener('click', async () => { await loadFreezer(); renderFreezer() })
  saveBtn.addEventListener('click', async () => {
    const name = nameInp.value.trim()
    if (!name) { toast('Recipe name is required', { error: true }); return }
    const payload = {
      recipe_name:  name,
      recipe_id:    recipeSel.value || null,
      portions:     portionsInp.value !== '' ? parseInt(portionsInp.value) : null,
      frozen_date:  frozenInp.value || null,
      use_by_date:  useByInp.value  || null,
      notes:        notesInp.value.trim() || null,
    }
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…'
    const op = id
      ? supabase.from('freezer_stash').update(payload).eq('id', id)
      : supabase.from('freezer_stash').insert(payload)
    const { error } = await op
    if (error) { toast('Save failed', { error: true }); saveBtn.disabled = false; saveBtn.textContent = 'Save'; return }
    toast('Saved')
    await loadFreezer(); renderFreezer()
  })
  actions.append(cancelBtn, saveBtn)
  form.appendChild(actions)

  if (id) {
    const danger = document.createElement('div')
    danger.className = 'pn-danger-zone'

    const usedBtn = document.createElement('button')
    usedBtn.className = 'pn-danger-btn'
    usedBtn.textContent = 'Mark as used'
    usedBtn.addEventListener('click', async () => {
      usedBtn.disabled = true
      const today = new Date().toISOString().split('T')[0]
      await supabase.from('freezer_stash').update({ used: true, used_date: today }).eq('id', id)
      toast('Marked as used')
      await loadFreezer(); renderFreezer()
    })

    const hideBtn = document.createElement('button')
    hideBtn.className = 'pn-danger-btn'
    hideBtn.textContent = 'Hide this item'
    hideBtn.addEventListener('click', async () => {
      hideBtn.disabled = true
      await supabase.from('freezer_stash').update({ active: false }).eq('id', id)
      toast('Item hidden')
      await loadFreezer(); renderFreezer()
    })

    danger.append(usedBtn, hideBtn)
    form.appendChild(danger)
  }

  contentEl.appendChild(form)
}

// ═══════════════════════════════════════════════════════════
// PREPPED COMPONENTS
// ═══════════════════════════════════════════════════════════

async function loadPrepped() {
  const { data } = await supabase
    .from('prepped_components')
    .select('*, recipes(id, name, emoji)')
    .eq('active', true)
    .gt('batches_remaining', 0)
    .order('made_date', { ascending: false })
  preppedData = data || []
}

function renderPrepped() {
  contentEl.innerHTML = ''

  if (!preppedData.length) {
    contentEl.appendChild(mkEmpty('No prepped components. Add them from a recipe\'s detail screen.'))
    return
  }

  const card = document.createElement('div')
  card.className = 'card su-card'
  preppedData.forEach((comp, i) => {
    const row = document.createElement('div')
    row.className = 'pn-row' + (i < preppedData.length - 1 ? ' pn-row--ruled' : '')

    const centre = document.createElement('div')
    centre.className = 'pn-row__centre'
    const main = document.createElement('div')
    main.className = 'pn-row__main'
    main.textContent = comp.name
    const meta = document.createElement('div')
    meta.className = 'pn-row__meta'
    const parts = []
    if (comp.recipes) parts.push((comp.recipes.emoji || '') + ' ' + comp.recipes.name)
    if (comp.made_date) parts.push('made ' + fmtShortDate(comp.made_date))
    meta.textContent = parts.join(' · ')
    centre.append(main, meta)
    row.appendChild(centre)

    const right = document.createElement('div')
    right.className = 'pn-row__right'
    const batches = document.createElement('span')
    batches.className = 'pn-prepped-batches'
    batches.textContent = comp.batches_remaining + '×'
    right.appendChild(batches)
    if (comp.storage_notes) {
      const note = document.createElement('span')
      note.className = 'pn-badge pn-badge-note'
      note.textContent = '📝'; note.title = comp.storage_notes
      right.appendChild(note)
    }
    row.appendChild(right)

    if (comp.recipe_id) {
      row.style.cursor = 'pointer'
      row.addEventListener('click', () => {
        navState.recipeId = comp.recipe_id
        navigateTo('recipe-detail')
      })
    }
    card.appendChild(row)
  })
  contentEl.appendChild(card)
}

// ═══════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════

function fmtShortDate(iso) {
  if (!iso) return ''
  const d = new Date(iso + 'T12:00:00')
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

function expiryStatus(dateStr) {
  if (!dateStr) return null
  const today = new Date(); today.setHours(0,0,0,0)
  const exp = new Date(dateStr + 'T00:00:00')
  const days = Math.floor((exp - today) / 86400000)
  if (days < 0)  return 'past'
  if (days <= 7) return 'soon'
  return null
}

function mkAddBtn(label, fn) {
  const b = document.createElement('button'); b.className = 'su-add-btn'; b.textContent = label
  b.addEventListener('click', fn); return b
}
function mkEmpty(msg) {
  const p = document.createElement('p'); p.className = 'su-empty'; p.textContent = msg; return p
}
function mkInput(type, value, placeholder) {
  const el = document.createElement('input')
  el.type = type; el.className = 'su-input'; el.value = value
  if (placeholder) el.placeholder = placeholder
  return el
}
function mkDateInput(value) {
  const el = document.createElement('input'); el.type = 'date'; el.className = 'su-input'; el.value = value; return el
}
function mkSelect(opts, val) {
  const el = document.createElement('select'); el.className = 'su-select'
  opts.forEach(([v, l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; if (v === val) o.selected = true; el.appendChild(o) })
  return el
}
function mkField(label, input, extraClass = '') {
  const w = document.createElement('div'); w.className = 'su-field' + (extraClass ? ' ' + extraClass : '')
  const l = document.createElement('label'); l.className = 'su-label'; l.textContent = label
  w.append(l, input); return w
}

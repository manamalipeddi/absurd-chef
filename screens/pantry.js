import { supabase, navigateTo, navState, toast, pushView, mkFab } from '../app.js'
import { openMasterSearch } from './master-search.js'

// ── Module state ──────────────────────────────────────────
let screenEl  = null
let tabBarEl  = null
let contentEl = null
let activeTab = 'inventory'

let inventoryData = []
let freezerData   = []
let preppedData   = []
let recipeList    = []   // for freezer link-to-recipe select
let masterList    = []   // active master_ingredients (for the Linked-ingredient editor)
let groceryData   = { outOfStock: [], needed: [] }

let showHiddenInventory = false
let showHiddenFreezer   = false
let inventorySearch     = ''

const catOpenState = { fridge: true, freezer: true, pantry: true }

const CAT_LABELS = { fridge: '🧊 Fridge', freezer: '❄️ Freezer', pantry: '🥫 Pantry' }
const CAT_WORD   = { fridge: 'Fridge', freezer: 'Freezer', pantry: 'Pantry' }
const CAT_LIST   = ['fridge', 'freezer', 'pantry']

const FOOD_CATS = [
  ['meat','Meat'], ['seafood','Seafood'], ['produce','Produce'],
  ['dairy','Dairy'], ['eggs','Eggs'], ['pantry','Pantry'], ['other','Other'],
]

// Loose status ↔ quantity: status is an input convenience that resolves to a
// real quantity against the item's typical_quantity baseline.
const STATUS_ORDER = ['out', 'very_low', 'low', 'enough', 'plenty', 'overstock']
const STATUS_PCT   = { out: 0, very_low: 0.10, low: 0.25, enough: 0.60, plenty: 0.85, overstock: 1.25 }
const STATUS_LABEL = { out: 'Out', very_low: 'Very low', low: 'Low', enough: 'Enough', plenty: 'Plenty', overstock: 'Overstock' }

function deriveStatus(qty, typical) {
  if (typical == null || Number(typical) <= 0) return null
  if (qty == null || Number(qty) === 0) return 'out'
  const ratio = Number(qty) / Number(typical)
  let best = 'out', bestD = Infinity
  for (const k of STATUS_ORDER) {
    const d = Math.abs(STATUS_PCT[k] - ratio)
    if (d < bestD) { bestD = d; best = k }
  }
  return best
}
function qtyFromStatus(statusKey, typical) {
  return Math.round(Number(typical) * STATUS_PCT[statusKey] * 100) / 100
}
function fmtQty(q) {
  if (q == null) return '0'
  const n = Number(q)
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100)
}

// "3d ago" / "today"; null last_updated_at → null (caller flags "never checked").
function relTime(ts) {
  if (!ts) return null
  const days = Math.floor((Date.now() - new Date(ts).getTime()) / 86400000)
  return days <= 0 ? 'today' : `${days}d ago`
}
// Expiry line segment: warning styling + special wording within 2 days / past.
function expiryInfo(dateStr) {
  if (!dateStr) return null
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const exp = new Date(dateStr + 'T00:00:00')
  const days = Math.round((exp - today) / 86400000)
  if (days < 0)  return { text: 'expired',      warn: true }
  if (days === 0) return { text: 'exp today',    warn: true }
  if (days === 1) return { text: 'exp tomorrow', warn: true }
  if (days === 2) return { text: 'exp ' + fmtShortDate(dateStr), warn: true }
  return { text: 'exp ' + fmtShortDate(dateStr), warn: false }
}

// ── Lifecycle ─────────────────────────────────────────────
export function init(el) {
  screenEl = el
  screenEl.innerHTML = ''

  tabBarEl = document.createElement('div')
  tabBarEl.className = 'pn-tabbar'
  ;[['inventory','Inventory'],['freezer','Freezer Meals'],['prepped','Prepped'],['grocery','Grocery']].forEach(([id, label]) => {
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
  inventorySearch     = ''
  activeTab = 'inventory'
  invFormView = freezerFormView = null   // drop any stale form handles on re-entry
  await loadAndShow('inventory')
}

async function switchTab(tab) {
  // The tab bar is always visible — if a form is open, balance its history entry
  // before switching so the pushed entry isn't orphaned.
  dismissOpenForms()
  activeTab = tab
  updateTabBar()
  await loadAndShow(tab)
}

function dismissOpenForms() {
  if (invFormView)     { invFormView.done();     invFormView = null }
  if (freezerFormView) { freezerFormView.done(); freezerFormView = null }
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
  else if (tab === 'grocery') { await loadGrocery(); renderGrocery() }
  else { await loadPrepped(); renderPrepped() }
}

// ═══════════════════════════════════════════════════════════
// INVENTORY
// ═══════════════════════════════════════════════════════════

async function loadInventory() {
  // Inventory + prepped components (the latter shown read-only within Inventory
  // for a single "everything available to cook with" view).
  const [{ data }, { data: prepped }, { data: masters }] = await Promise.all([
    supabase.from('inventory').select('*').order('name'),
    supabase.from('prepped_components').select('*, recipes(id, name, emoji)')
      .eq('active', true).gt('batches_remaining', 0).order('made_date', { ascending: false }),
    supabase.from('master_ingredients').select('id, canonical_name, aliases, default_category')
      .eq('active', true).order('canonical_name'),
  ])
  masterList = masters || []
  // Two stacked alphabetical sorts: actively-checked items (last_updated_at set)
  // first, then never-checked items (null) as a distinct group at the bottom.
  inventoryData = (data || []).sort((a, b) => {
    const an = a.last_updated_at == null, bn = b.last_updated_at == null
    if (an !== bn) return an ? 1 : -1
    return (a.name || '').localeCompare(b.name || '')
  })
  preppedData = prepped || []
}

function renderInventory() {
  contentEl.innerHTML = ''

  // "Tell me what's in stock" stays inline (a chat shortcut, not a create-new
  // action). Adding a new item is the standard FAB (appended below).
  const actionRow = document.createElement('div')
  actionRow.className = 'pn-inv-actions'
  const tellBtn = document.createElement('button')
  tellBtn.className = 'pn-inv-action pn-inv-action--alt'
  tellBtn.textContent = "🎤 Tell me what's in stock"
  tellBtn.addEventListener('click', () => navigateTo('chat'))
  actionRow.append(tellBtn)
  contentEl.appendChild(actionRow)

  // Search box — filters across all categories at once; only the list re-renders
  // on input (the input persists, so focus/caret are kept).
  const search = document.createElement('input')
  search.type = 'search'
  search.className = 'pn-inv-search'
  search.placeholder = 'Search inventory…'
  search.value = inventorySearch
  const listEl = document.createElement('div')
  search.addEventListener('input', () => { inventorySearch = search.value; renderBody() })
  contentEl.append(search, listEl)
  contentEl.appendChild(mkFab(() => openInventoryForm(null, 'pantry'), 'Add inventory item'))

  function renderBody() {
    listEl.innerHTML = ''
    const q = inventorySearch.trim().toLowerCase()
    const active = inventoryData.filter(i => i.active !== false)
    const hidden = inventoryData.filter(i => i.active === false)

    // Filtered: flat list across all storage categories, normal sort preserved.
    if (q) {
      const hits = active.filter(i => (i.name || '').toLowerCase().includes(q))
      if (!hits.length) { listEl.appendChild(mkEmpty('No items match your search.')); return }
      const card = document.createElement('div')
      card.className = 'card su-card'
      hits.forEach((item, i) => card.appendChild(buildInventoryRow(item, i < hits.length - 1)))
      listEl.appendChild(card)
      return
    }

    // Normal grouped view.
    const bycat = {}
    active.forEach(item => { const c = item.category || 'pantry'; (bycat[c] = bycat[c] || []).push(item) })
    const knownKeys = new Set(CAT_LIST)
    Object.keys(bycat).filter(k => !knownKeys.has(k)).forEach(k => { CAT_LIST.push(k); CAT_LABELS[k] = '📦 ' + k })

    let hasAny = false
    CAT_LIST.forEach(catKey => {
      const items = bycat[catKey]
      if (!items?.length) return
      hasAny = true
      listEl.appendChild(buildInventorySection(catKey, items))
    })

    if (preppedData.length) { hasAny = true; listEl.appendChild(buildPreppedInventoryGroup(preppedData)) }
    if (!hasAny) listEl.appendChild(mkEmpty('No inventory items. Tap + to add.'))

    if (hidden.length) {
      const toggle = document.createElement('button')
      toggle.className = 'pn-hidden-toggle'
      toggle.textContent = showHiddenInventory
        ? `Hide ${hidden.length} hidden item${hidden.length !== 1 ? 's' : ''}`
        : `Show ${hidden.length} hidden item${hidden.length !== 1 ? 's' : ''}`
      toggle.addEventListener('click', () => { showHiddenInventory = !showHiddenInventory; renderBody() })
      listEl.appendChild(toggle)

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
            await loadInventory(); renderBody()
          })
          row.appendChild(unhide)
          card.appendChild(row)
        })
        listEl.appendChild(card)
      }
    }
  }

  renderBody()
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

  // Per-section "+" removed — adding is now the single standard FAB.
  header.append(toggleBtn)

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

// Compact item: line 1 name; line 2 "[storage] · updated [rel] · exp [date]";
// right side a numeric stepper (no baseline yet) or a status pill (baseline set).
// Both quantity-control paths write the SAME quantity field. The whole item lives
// in one wrapper so the status-grid can expand directly below the row.
function buildInventoryRow(item, ruled) {
  const wrap = document.createElement('div')
  renderInvItem(wrap, item, ruled)
  return wrap
}

function renderInvItem(wrap, item, ruled) {
  wrap.innerHTML = ''
  wrap.className = 'pn-inv-item' + (ruled ? ' pn-row--ruled' : '')

  const row = document.createElement('div')
  row.className = 'pn-row pn-inv-row'

  // Tappable name + meta -> full edit form.
  const tap = document.createElement('div')
  tap.className = 'pn-inv-tap'
  const name = document.createElement('div')
  name.className = 'pn-row__main pn-inv-name'
  name.textContent = item.name

  const sub = document.createElement('div')
  sub.className = 'pn-inv-sub'
  const stor = document.createElement('span')
  stor.textContent = CAT_WORD[item.category] || item.category || '—'
  sub.appendChild(stor)
  sub.appendChild(document.createTextNode(' · '))
  const upd = document.createElement('span')
  if (!item.last_updated_at) { upd.className = 'pn-sub-warn'; upd.textContent = 'never checked' }
  else { upd.textContent = 'updated ' + relTime(item.last_updated_at) }
  sub.appendChild(upd)
  const ei = expiryInfo(item.expiry_date)
  if (ei) {
    sub.appendChild(document.createTextNode(' · '))
    const e = document.createElement('span')
    e.textContent = ei.text
    if (ei.warn) e.className = 'pn-sub-warn'
    sub.appendChild(e)
  }
  tap.append(name, sub)
  tap.addEventListener('click', () => openInventoryForm(item.id, item.category || 'pantry'))
  row.appendChild(tap)

  // Quick-adjust control.
  row.appendChild(
    item.typical_quantity != null
      ? buildStatusControl(wrap, item, ruled)
      : buildStepper(wrap, item, ruled)
  )

  wrap.appendChild(row)
}

// Persist a new quantity (+ optional status) by ANY quick path; the DB trigger
// handles last_updated_at + expiry. Re-render in place with the fresh row.
async function setInvQuantity(wrap, item, ruled, newQty, statusKey) {
  const payload = { quantity: newQty }
  if (statusKey !== undefined) payload.status = statusKey
  const { data, error } = await supabase.from('inventory').update(payload).eq('id', item.id).select('*').single()
  if (error || !data) { toast('Update failed', { error: true }); return }
  Object.assign(item, data)
  const idx = inventoryData.findIndex(x => x.id === item.id)
  if (idx >= 0) inventoryData[idx] = { ...inventoryData[idx], ...data }
  renderInvItem(wrap, item, ruled)
}

function buildStepper(wrap, item, ruled) {
  const c = document.createElement('div')
  c.className = 'pn-stepper'
  const mk = (txt, cls) => { const b = document.createElement('button'); b.className = 'pn-step-btn ' + cls; b.textContent = txt; return b }
  const minus = mk('−', 'pn-step-btn--minus')
  const plus  = mk('+', 'pn-step-btn--plus')
  const num = document.createElement('button')
  num.className = 'pn-step-num'
  num.textContent = fmtQty(item.quantity)

  minus.addEventListener('click', e => { e.stopPropagation(); setInvQuantity(wrap, item, ruled, Math.max(0, (Number(item.quantity) || 0) - 1)) })
  plus.addEventListener('click',  e => { e.stopPropagation(); setInvQuantity(wrap, item, ruled, (Number(item.quantity) || 0) + 1) })
  num.addEventListener('click', e => {
    e.stopPropagation()
    const inp = document.createElement('input')
    inp.type = 'number'; inp.className = 'pn-qty-input'; inp.min = 0; inp.step = 'any'
    inp.value = item.quantity ?? ''
    num.replaceWith(inp); inp.focus(); inp.select()
    let done = false
    const commit = () => { if (done) return; done = true; const v = inp.value === '' ? 0 : Math.max(0, parseFloat(inp.value) || 0); setInvQuantity(wrap, item, ruled, v) }
    const cancel = () => { if (done) return; done = true; renderInvItem(wrap, item, ruled) }
    inp.addEventListener('click', e2 => e2.stopPropagation())
    inp.addEventListener('blur', commit)
    inp.addEventListener('keydown', e2 => {
      if (e2.key === 'Enter') { e2.preventDefault(); inp.blur() }
      else if (e2.key === 'Escape') { e2.preventDefault(); cancel() }
    })
  })
  c.append(minus, num, plus)
  return c
}

function buildStatusControl(wrap, item, ruled) {
  const c = document.createElement('div')
  c.className = 'pn-qtyctl'
  const cur = deriveStatus(item.quantity, item.typical_quantity)
  const pill = document.createElement('button')
  pill.className = 'pn-status-pill'
  pill.textContent = STATUS_LABEL[cur] || '—'
  pill.addEventListener('click', e => { e.stopPropagation(); toggleStatusGrid(wrap, item, ruled, pill) })
  c.appendChild(pill)
  return c
}

function toggleStatusGrid(wrap, item, ruled, pill) {
  const open = wrap.querySelector('.pn-status-grid')
  if (open) { open.remove(); pill.classList.remove('pn-status-pill--open'); return }
  pill.classList.add('pn-status-pill--open')

  const cur = deriveStatus(item.quantity, item.typical_quantity)
  const grid = document.createElement('div')
  grid.className = 'pn-status-grid'
  STATUS_ORDER.forEach(k => {
    const b = document.createElement('button')
    b.className = 'pn-status-opt' + (k === cur ? ' pn-status-opt--active' : '')
    b.textContent = STATUS_LABEL[k]
    b.addEventListener('click', e => { e.stopPropagation(); setInvQuantity(wrap, item, ruled, qtyFromStatus(k, item.typical_quantity), k) })
    grid.appendChild(b)
  })
  const exact = document.createElement('button')
  exact.className = 'pn-status-exact'
  exact.textContent = 'Enter exact amount instead'
  exact.addEventListener('click', e => {
    e.stopPropagation()
    grid.innerHTML = ''
    const inp = document.createElement('input')
    inp.type = 'number'; inp.className = 'pn-qty-input pn-qty-input--wide'; inp.min = 0; inp.step = 'any'
    inp.value = item.quantity ?? ''
    const ok = document.createElement('button'); ok.className = 'pn-status-exact pn-status-exact--set'; ok.textContent = 'Set'
    let done = false
    const commit = () => { if (done) return; done = true; const v = inp.value === '' ? 0 : Math.max(0, parseFloat(inp.value) || 0); setInvQuantity(wrap, item, ruled, v) }
    ok.addEventListener('click', e2 => { e2.stopPropagation(); commit() })
    inp.addEventListener('click', e2 => e2.stopPropagation())
    inp.addEventListener('keydown', e2 => { if (e2.key === 'Enter') { e2.preventDefault(); commit() } })
    grid.append(inp, ok)
    inp.focus()
  })
  grid.appendChild(exact)
  wrap.appendChild(grid)
}
// Read-only "Prepped" grouping inside Inventory (visibility of the same data).
function buildPreppedInventoryGroup(items) {
  const wrap = document.createElement('div')
  wrap.className = 'pn-section'
  const header = document.createElement('div')
  header.className = 'pn-section-header'
  header.innerHTML = `<span class="pn-section-toggle" style="cursor:default">
    <span class="pn-section-label">🧩 Prepped</span>
    <span class="pn-section-count">(${items.length})</span></span>`
  const card = document.createElement('div')
  card.className = 'card pn-section-card'
  items.forEach((comp, i) => {
    const row = document.createElement('div')
    row.className = 'pn-row pn-row--compact' + (i < items.length - 1 ? ' pn-row--ruled' : '')
    const centre = document.createElement('div')
    centre.className = 'pn-row__centre pn-row__line'
    const main = document.createElement('span'); main.className = 'pn-row__main'; main.textContent = comp.name
    const meta = document.createElement('div'); meta.className = 'pn-row__meta-inline'
    const parts = [`${comp.batches_remaining} batch${comp.batches_remaining !== 1 ? 'es' : ''}`]
    if (comp.recipes) parts.push(comp.recipes.name)
    meta.textContent = parts.join(' · ')
    centre.append(main, meta)
    row.appendChild(centre)
    card.appendChild(row)
  })
  const body = document.createElement('div'); body.className = 'pn-section-body'; body.appendChild(card)
  wrap.append(header, body)
  return wrap
}

// ── Inventory form ─────────────────────────────────────────
let invFormView = null
async function showInventoryList() { await loadInventory(); renderInventory() }
// Dismiss the edit form from its own UI (Cancel/Save/Hide): balance the pushed
// history entry, then restore the list. Back-swipe takes the pushView onBack path.
function closeInventoryForm() {
  const h = invFormView; invFormView = null
  if (h) h.done()
  showInventoryList()
}

// ── Linked master ingredient (edit form) ──────────────────
function normName(s) { return String(s || '').toLowerCase().trim() }

// Best-guess master for an inventory name: exact canonical/alias first, then a
// substring match either direction. null when nothing is confident enough.
function suggestMaster(name) {
  const q = normName(name); if (!q) return null
  for (const m of masterList) {
    if (normName(m.canonical_name) === q) return m
    if ((m.aliases || []).some(a => normName(a) === q)) return m
  }
  for (const m of masterList) {
    const c = normName(m.canonical_name)
    if (c && (c.includes(q) || q.includes(c))) return m
    if ((m.aliases || []).some(a => { const an = normName(a); return an && (an.includes(q) || q.includes(an)) })) return m
  }
  return null
}

// The "Linked ingredient" field: current link / best-guess suggestion / not
// linked, all editable. Updates linkState.id; the form writes it on Save.
function buildLinkField(linkState, nameInp, catSel, item) {
  const wrap = document.createElement('div'); wrap.className = 'su-field'
  const lbl = document.createElement('label'); lbl.className = 'su-label'; lbl.textContent = 'Linked ingredient'
  const body = document.createElement('div'); body.className = 'pn-link'
  wrap.append(lbl, body)

  const getName = () => nameInp.value.trim() || item?.name || ''
  const chip = (text, fn, cls) => {
    const b = document.createElement('button'); b.type = 'button'
    b.className = 'pn-link-btn' + (cls ? ' ' + cls : ''); b.textContent = text
    b.addEventListener('click', fn); return b
  }
  function pick(master) {
    linkState.id = master.id
    if (!masterList.some(m => m.id === master.id)) masterList.push(master)
    render()
  }
  function render() {
    body.innerHTML = ''
    if (linkState.id) {
      const name = masterList.find(m => m.id === linkState.id)?.canonical_name || '(linked)'
      const n = document.createElement('span'); n.className = 'pn-link-name'; n.textContent = name
      body.append(n, chip('change', () => openMasterSearch(getName(), catSel.value, pick)))
    } else {
      const sug = suggestMaster(getName())
      if (sug) {
        const q = document.createElement('span'); q.className = 'pn-link-suggest'
        q.textContent = `Did you mean: ${sug.canonical_name}?`
        body.append(
          q,
          chip('Confirm', () => pick(sug), 'pn-link-btn--confirm'),
          chip('Not this', () => openMasterSearch(getName(), catSel.value, pick)),
        )
      } else {
        const none = document.createElement('span'); none.className = 'pn-link-none'; none.textContent = 'Not linked'
        body.append(none, chip('link it', () => openMasterSearch(getName(), catSel.value, pick)))
      }
    }
  }
  render()
  return wrap
}

function openInventoryForm(id, defaultCat = 'pantry') {
  const item = id ? inventoryData.find(x => x.id === id) : null
  contentEl.innerHTML = ''
  // Real history entry so Back/▷-swipe returns to the inventory list, not out of the tab.
  invFormView = pushView(() => { invFormView = null; showInventoryList() })

  const form = document.createElement('div')
  form.className = 'pn-form'

  const nameInp  = mkInput('text',   item?.name        || '', 'e.g. Greek yoghurt')
  const qtyInp   = mkInput('number', item?.quantity     ?? '', '')
  qtyInp.min = 0; qtyInp.step = 'any'
  const unitInp  = mkInput('text',   item?.unit         || '', 'e.g. litres')
  const typicalInp = mkInput('number', item?.typical_quantity ?? '', 'e.g. 2')
  typicalInp.min = 0; typicalInp.step = 'any'
  const catSel   = mkSelect([['fridge','Fridge'],['freezer','Freezer'],['pantry','Pantry']], item?.category || defaultCat)
  const foodSel  = mkSelect(FOOD_CATS, item?.food_category || 'other')
  const expInp   = mkDateInput(item?.expiry_date || '')
  const notesInp = mkInput('text',   item?.notes        || '', 'Optional notes')

  const qtyRow = document.createElement('div')
  qtyRow.className = 'pn-form-row'
  qtyRow.append(mkField('Quantity', qtyInp, 'pn-form-col-sm'), mkField('Unit', unitInp, 'pn-form-col'))

  const catRow = document.createElement('div')
  catRow.className = 'pn-form-row'
  catRow.append(mkField('Stored in', catSel, 'pn-form-col'), mkField('Food type', foodSel, 'pn-form-col'))

  // Linked master ingredient: show the current link, the best-guess suggestion,
  // or "Not linked" — all editable. The chosen id is written on Save (payload).
  const linkState = { id: item?.master_ingredient_id || null }
  const linkField = buildLinkField(linkState, nameInp, catSel, item)

  form.append(
    mkField('Name *', nameInp),
    qtyRow,
    catRow,
    linkField,
    mkField('Typical amount (baseline for status — optional)', typicalInp),
    mkField('Expiry date (optional)', expInp),
    mkField('Notes (optional)', notesInp),
  )

  // Primary actions
  const actions = document.createElement('div')
  actions.className = 'su-actions'
  const cancelBtn = document.createElement('button'); cancelBtn.className = 'su-btn-ghost'; cancelBtn.textContent = 'Cancel'
  const saveBtn   = document.createElement('button'); saveBtn.className   = 'su-btn-primary'; saveBtn.textContent = 'Save'
  cancelBtn.addEventListener('click', () => closeInventoryForm())
  saveBtn.addEventListener('click', async () => {
    const name = nameInp.value.trim()
    if (!name) { toast('Name is required', { error: true }); return }
    const payload = {
      name,
      quantity:           qtyInp.value !== '' ? parseFloat(qtyInp.value) : null,
      unit:               unitInp.value.trim() || null,
      typical_quantity:   typicalInp.value !== '' ? parseFloat(typicalInp.value) : null,
      category:           catSel.value,
      food_category:      foodSel.value,
      master_ingredient_id: linkState.id,   // the user-confirmed / corrected link
      expiry_date:        expInp.value || null,
      notes:              notesInp.value.trim() || null,
    }
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…'
    const op = id
      ? supabase.from('inventory').update(payload).eq('id', id)
      : supabase.from('inventory').insert(payload)
    const { error } = await op
    if (error) { toast('Save failed', { error: true }); saveBtn.disabled = false; saveBtn.textContent = 'Save'; return }
    toast('Saved')
    closeInventoryForm()
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
      closeInventoryForm()
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

  if (!freezerData.length) {
    contentEl.appendChild(mkEmpty('No freezer meals yet.'))
  } else {
    const card = document.createElement('div')
    card.className = 'card su-card'
    freezerData.forEach((entry, i) => card.appendChild(buildFreezerRow(entry, i < freezerData.length - 1)))
    contentEl.appendChild(card)
  }

  contentEl.appendChild(mkFab(() => openFreezerForm(null), 'Add freezer meal'))

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

// Compact freezer item — same row + stepper treatment as Inventory (portions
// are small discrete counts, so a numeric stepper alone; no status pill).
function buildFreezerRow(entry, ruled) {
  const wrap = document.createElement('div')
  renderFreezerItem(wrap, entry, ruled)
  return wrap
}

function renderFreezerItem(wrap, entry, ruled) {
  wrap.innerHTML = ''
  wrap.className = 'pn-inv-item' + (ruled ? ' pn-row--ruled' : '')

  const row = document.createElement('div')
  row.className = 'pn-row pn-inv-row'

  const tap = document.createElement('div')
  tap.className = 'pn-inv-tap'
  const name = document.createElement('div')
  name.className = 'pn-row__main pn-inv-name'
  name.textContent = entry.recipe_name || '(unnamed)'

  const sub = document.createElement('div')
  sub.className = 'pn-inv-sub'
  const stor = document.createElement('span')
  stor.textContent = entry.source === 'store_bought' ? '🛒 Store-bought' : 'Freezer'
  sub.appendChild(stor)
  if (entry.frozen_date) sub.appendChild(document.createTextNode(' · frozen ' + fmtShortDate(entry.frozen_date)))
  if (entry.use_by_date) {
    sub.appendChild(document.createTextNode(' · '))
    const status = expiryStatus(entry.use_by_date)
    const e = document.createElement('span')
    e.textContent = 'use by ' + fmtShortDate(entry.use_by_date)
    if (status) e.className = 'pn-sub-warn'
    sub.appendChild(e)
  }
  if ((entry.portions == null || Number(entry.portions) === 0) && entry.typically_restocked) {
    const r = document.createElement('span'); r.className = 'pn-sub-warn'; r.textContent = ' · restock'
    sub.appendChild(r)
  }
  tap.append(name, sub)
  tap.addEventListener('click', () => openFreezerForm(entry.id))
  row.appendChild(tap)

  row.appendChild(buildPortionsStepper(wrap, entry, ruled))
  wrap.appendChild(row)
}

async function setFreezerPortions(wrap, entry, ruled, newPortions) {
  const { data, error } = await supabase.from('freezer_stash').update({ portions: newPortions }).eq('id', entry.id).select('*').single()
  if (error || !data) { toast('Update failed', { error: true }); return }
  Object.assign(entry, data)
  const idx = freezerData.findIndex(x => x.id === entry.id)
  if (idx >= 0) freezerData[idx] = { ...freezerData[idx], ...data }
  renderFreezerItem(wrap, entry, ruled)
}

function buildPortionsStepper(wrap, entry, ruled) {
  const c = document.createElement('div')
  c.className = 'pn-stepper'
  const mk = (txt, cls) => { const b = document.createElement('button'); b.className = 'pn-step-btn ' + cls; b.textContent = txt; return b }
  const minus = mk('−', 'pn-step-btn--minus')
  const plus  = mk('+', 'pn-step-btn--plus')
  const num = document.createElement('button')
  num.className = 'pn-step-num'
  num.textContent = fmtQty(entry.portions)

  minus.addEventListener('click', e => { e.stopPropagation(); setFreezerPortions(wrap, entry, ruled, Math.max(0, (Number(entry.portions) || 0) - 1)) })
  plus.addEventListener('click',  e => { e.stopPropagation(); setFreezerPortions(wrap, entry, ruled, (Number(entry.portions) || 0) + 1) })
  num.addEventListener('click', e => {
    e.stopPropagation()
    const inp = document.createElement('input')
    inp.type = 'number'; inp.className = 'pn-qty-input'; inp.min = 0; inp.step = '1'
    inp.value = entry.portions ?? ''
    num.replaceWith(inp); inp.focus(); inp.select()
    let done = false
    const commit = () => { if (done) return; done = true; const v = inp.value === '' ? 0 : Math.max(0, parseInt(inp.value) || 0); setFreezerPortions(wrap, entry, ruled, v) }
    const cancel = () => { if (done) return; done = true; renderFreezerItem(wrap, entry, ruled) }
    inp.addEventListener('click', e2 => e2.stopPropagation())
    inp.addEventListener('blur', commit)
    inp.addEventListener('keydown', e2 => {
      if (e2.key === 'Enter') { e2.preventDefault(); inp.blur() }
      else if (e2.key === 'Escape') { e2.preventDefault(); cancel() }
    })
  })
  c.append(minus, num, plus)
  return c
}

// ── Freezer form ───────────────────────────────────────────
let freezerFormView = null
async function showFreezerList() { await loadFreezer(); renderFreezer() }
function closeFreezerForm() {
  const h = freezerFormView; freezerFormView = null
  if (h) h.done()
  showFreezerList()
}

function openFreezerForm(id) {
  const entry = id ? freezerData.find(x => x.id === id) : null
  contentEl.innerHTML = ''
  // Real history entry so Back/▷-swipe returns to the freezer list, not out of the tab.
  freezerFormView = pushView(() => { freezerFormView = null; showFreezerList() })
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

  // Source toggle (Homemade / Store-bought); restock checkbox shows for store-bought.
  const sourceSel = mkSelect([['homemade', '🏠 Homemade'], ['store_bought', '🛒 Store-bought']], entry?.source || 'homemade')
  const restockField = document.createElement('label')
  restockField.className = 'pn-check-row'
  const restockCb = document.createElement('input')
  restockCb.type = 'checkbox'; restockCb.checked = !!entry?.typically_restocked
  const restockTxt = document.createElement('span')
  restockTxt.textContent = 'I usually keep this stocked (restock on normal grocery runs)'
  restockField.append(restockCb, restockTxt)
  restockField.style.display = sourceSel.value === 'store_bought' ? '' : 'none'
  sourceSel.addEventListener('change', () => {
    restockField.style.display = sourceSel.value === 'store_bought' ? '' : 'none'
  })

  form.append(
    mkField('Recipe name *', nameInp),
    mkField('Type', sourceSel),
    restockField,
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
  cancelBtn.addEventListener('click', () => closeFreezerForm())
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
      source:               sourceSel.value,
      typically_restocked:  sourceSel.value === 'store_bought' ? restockCb.checked : false,
    }
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…'
    const op = id
      ? supabase.from('freezer_stash').update(payload).eq('id', id)
      : supabase.from('freezer_stash').insert(payload)
    const { error } = await op
    if (error) { toast('Save failed', { error: true }); saveBtn.disabled = false; saveBtn.textContent = 'Save'; return }
    toast('Saved')
    closeFreezerForm()
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
      closeFreezerForm()
    })

    const hideBtn = document.createElement('button')
    hideBtn.className = 'pn-danger-btn'
    hideBtn.textContent = 'Hide this item'
    hideBtn.addEventListener('click', async () => {
      hideBtn.disabled = true
      await supabase.from('freezer_stash').update({ active: false }).eq('id', id)
      toast('Item hidden')
      closeFreezerForm()
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
// GROCERY LIST
// ═══════════════════════════════════════════════════════════

async function loadGrocery() {
  const today = new Date().toISOString().split('T')[0]
  const end   = new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0]

  const [{ data: invData }, { data: planData }, { data: activeMasterData }, { data: stashPlanData }] = await Promise.all([
    supabase.from('inventory').select('*').eq('active', true),
    supabase.from('meal_plans')
      .select('plan_date, recipe_id, cook_source, recipes(id, name, emoji, default_variant_id)')
      .gte('plan_date', today).lte('plan_date', end)
      .not('recipe_id', 'is', null)
      .order('plan_date'),
    supabase.from('master_ingredients').select('id').eq('active', true),
    // Freezer-stash assignments in the window → surface any that need restocking
    // (portions 0 + typically_restocked, i.e. a week-2 restock assignment).
    supabase.from('meal_plans')
      .select('plan_date, stash_item_id, freezer_stash(recipe_name, portions, typically_restocked)')
      .gte('plan_date', today).lte('plan_date', end)
      .eq('cook_source', 'freezer_stash').not('stash_item_id', 'is', null)
      .order('plan_date'),
  ])

  const allInventory = invData || []
  // Only ACTIVE master ingredients count as a confident link (old links on
  // recipes stay intact, but a deactivated master falls back to fuzzy matching).
  const activeMasters = new Set((activeMasterData || []).map(m => m.id))

  // Source 1: items explicitly out of stock
  const outOfStock = allInventory.filter(i => i.quantity == null || Number(i.quantity) === 0)

  // Filter plan: skip freezer_stash and store_bought
  const planRows = (planData || []).filter(p =>
    p.cook_source !== 'freezer_stash' && p.cook_source !== 'store_bought' && p.recipe_id
  )

  // Separate recipes needing variant ingredients vs base ingredients
  const noVariantCtx = []   // { recipe_id, recipeName, emoji, date, dateLabel }
  const variantCtx   = []   // { variant_id, recipe_id, recipeName, emoji, date, dateLabel }
  for (const row of planRows) {
    const r = row.recipes
    if (!r) continue
    const ctx = { recipe_id: r.id, recipeName: r.name, emoji: r.emoji, date: row.plan_date, dateLabel: fmtPlanDate(row.plan_date) }
    if (r.default_variant_id) variantCtx.push({ ...ctx, variant_id: r.default_variant_id })
    else                       noVariantCtx.push(ctx)
  }

  const uniqueRecipeIds  = [...new Set(noVariantCtx.map(r => r.recipe_id))]
  const uniqueVariantIds = [...new Set(variantCtx.map(r => r.variant_id))]

  const [ingRes, varIngRes] = await Promise.all([
    uniqueRecipeIds.length
      ? supabase.from('recipe_ingredients').select('name, recipe_id, master_ingredient_id, quantity, unit').in('recipe_id', uniqueRecipeIds)
      : Promise.resolve({ data: [] }),
    uniqueVariantIds.length
      ? supabase.from('recipe_variant_ingredients').select('name, variant_id, master_ingredient_id, quantity, unit').in('variant_id', uniqueVariantIds)
      : Promise.resolve({ data: [] }),
  ])

  // Inventory indexed by master_ingredient_id for exact, reliable matching
  // (active masters only).
  const invByMaster = new Map()
  for (const item of allInventory)
    if (item.master_ingredient_id && activeMasters.has(item.master_ingredient_id) && !invByMaster.has(item.master_ingredient_id))
      invByMaster.set(item.master_ingredient_id, item)

  // Build map: normalised name → { displayName, usages[], masterId, contribs[] }.
  // contribs accumulates one {quantity, unit} per (recipe,date) usage, so the
  // summed requirement covers the whole 14-day window.
  const ingMap = {}
  function addIngredient(rawName, ctx, masterId, quantity, unit) {
    const key = rawName.toLowerCase().trim()
    if (!ingMap[key]) ingMap[key] = { displayName: rawName, usages: [], masterId: masterId || null, contribs: [] }
    if (masterId && !ingMap[key].masterId) ingMap[key].masterId = masterId
    if (!ingMap[key].usages.some(u => u.recipe_id === ctx.recipe_id && u.date === ctx.date)) {
      ingMap[key].usages.push(ctx)
      ingMap[key].contribs.push({ quantity, unit })
    }
  }
  for (const ing of ingRes.data || [])
    noVariantCtx.filter(c => c.recipe_id === ing.recipe_id).forEach(c => addIngredient(ing.name, c, ing.master_ingredient_id, ing.quantity, ing.unit))
  for (const ing of varIngRes.data || [])
    variantCtx.filter(c => c.variant_id === ing.variant_id).forEach(c => addIngredient(ing.name, c, ing.master_ingredient_id, ing.quantity, ing.unit))

  // Conversion data for every master referenced (ingredient + inventory sides).
  const masterIds = [...new Set([
    ...Object.values(ingMap).map(d => d.masterId).filter(Boolean),
    ...allInventory.map(i => i.master_ingredient_id).filter(Boolean),
  ])]
  const masterConv = new Map()
  if (masterIds.length) {
    const { data: mc } = await supabase.from('master_ingredients')
      .select('id, unit_type, grams_per_cup').in('id', masterIds)
    for (const m of mc || []) masterConv.set(m.id, m)
  }

  // Match each ingredient against inventory; compare summed-needed vs available.
  const annotatedOOS = outOfStock.map(i => ({ ...i, neededFor: [] }))
  const oosIdxById   = new Map(annotatedOOS.map((i, idx) => [i.id, idx]))
  const needed       = []

  for (const [key, data] of Object.entries(ingMap)) {
    // Prefer the reliable master_ingredient_id link (active only); fall back to fuzzy name match.
    const match = (data.masterId && activeMasters.has(data.masterId) && invByMaster.get(data.masterId)) || findInventoryMatch(key, allInventory)

    // Out of stock entirely → annotate the OOS row (Source 1 owns it).
    if (match && (match.quantity == null || Number(match.quantity) === 0)) {
      const idx = oosIdxById.get(match.id)
      if (idx != null) annotatedOOS[idx].neededFor.push(...data.usages)
      continue
    }

    // Precise quantity math when both sides reconcile to the same dimension.
    const need  = sumNeeded(data.contribs, data.masterId ? masterConv.get(data.masterId) : null)
    const avail = match ? toCanonical(match.quantity, match.unit, match.master_ingredient_id ? masterConv.get(match.master_ingredient_id) : null) : null

    if (match && need && avail && need.dim === avail.dim) {
      if (avail.value >= need.value) continue                  // enough on hand — skip
      const estimate = match.status != null                    // status-derived = fuzzy input
      const setQty   = avail.value > 0 ? Math.round(Number(match.quantity) * need.value / avail.value * 100) / 100 : null
      needed.push({
        name: data.displayName, usages: data.usages, matchedInventoryId: match.id,
        lastUpdated: match.last_updated_at || null, status: match.status || null,
        shortfall: { kind: 'short', neededVal: need.value, availVal: avail.value, dim: need.dim, estimate, statusLabel: estimate ? STATUS_LABEL[match.status] : null, setQty },
      })
      continue
    }

    // Fallback — units couldn't be reconciled (e.g. qty in the ingredient name,
    // or a non-numeric inventory unit). Still be quantity-aware:
    if (match) {
      // Has stock but we can't verify it's enough. If we know a specific amount
      // is needed, surface a soft "you have some — double-check" nudge; tapping
      // "got it" normalises the item to the needed amount in a comparable unit.
      if (need) {
        needed.push({
          name: data.displayName, usages: data.usages, matchedInventoryId: match.id,
          lastUpdated: match.last_updated_at || null, status: match.status || null,
          shortfall: { kind: 'have_some', neededVal: need.value, dim: need.dim, haveRaw: fmtRaw(match.quantity, match.unit), setQty: need.value, setUnit: canonUnitFor(need.dim) },
        })
      }
      // No structured need → presence of stock is enough; not listed.
      continue
    }
    // No inventory item at all → "not in stock" (you're out), with the needed
    // amount when we can compute it.
    needed.push({
      name: data.displayName, usages: data.usages, matchedInventoryId: null,
      shortfall: need ? { kind: 'need', neededVal: need.value, dim: need.dim } : { kind: 'out' },
    })
  }

  // Restockable freezer/store-bought meals assigned upcoming but currently empty.
  const restockByName = {}
  for (const row of stashPlanData || []) {
    const fs = row.freezer_stash
    if (!fs || !fs.typically_restocked || Number(fs.portions) > 0) continue
    const key = fs.recipe_name
    if (!restockByName[key]) restockByName[key] = { name: `🛒 ${fs.recipe_name}`, usages: [], matchedInventoryId: null }
    restockByName[key].usages.push({ recipe_id: row.stash_item_id, recipeName: fs.recipe_name, date: row.plan_date, dateLabel: fmtPlanDate(row.plan_date) })
  }
  needed.push(...Object.values(restockByName))

  // Sort each section the same way: low-stock first (status out/very_low/low OR a
  // shortfall), by last_updated_at DESC with never-checked items at the bottom of
  // that group; everything else alphabetically by name.
  annotatedOOS.sort(grocerySort)   // OOS rows are inventory items (out → all low-stock)
  needed.sort(grocerySort)
  groceryData = { outOfStock: annotatedOOS, needed }
}

// ── Quantity reconciliation (needed vs available) ─────────
// Convert a (quantity, unit) into a canonical { dim, value } so amounts can be
// compared/summed numerically. Mirrors convert.js's ratios. Returns null when it
// can't be confidently reconciled (caller falls back to presence/absence).
const _OZ_G = 28.3495, _LB_G = 453.592, _CUP_ML = 240, _TBSP_ML = 15, _TSP_ML = 5
const COUNT_UNITS = ['', 'pcs', 'pc', 'piece', 'pieces', 'x', 'ct', 'count', 'unit', 'units', 'ea', 'each', 'clove', 'cloves', 'can', 'cans', 'tin', 'tins', 'pack', 'packs', 'bunch', 'bunches']

function toCanonical(q, unitRaw, master) {
  if (q == null) return null
  const n = Number(q); if (!isFinite(n)) return null
  const u = String(unitRaw || '').toLowerCase().trim().replace(/\.$/, '')
  const ut = master?.unit_type

  if (COUNT_UNITS.includes(u)) return { dim: 'count', value: n }
  if (['g', 'gm', 'gms', 'gram', 'grams'].includes(u))                 return { dim: 'mass', value: n }
  if (['kg', 'kgs', 'kilo', 'kilos', 'kilogram', 'kilograms'].includes(u)) return { dim: 'mass', value: n * 1000 }
  if (u === 'mg')                                                       return { dim: 'mass', value: n * 0.001 }
  if (['oz', 'ounce', 'ounces'].includes(u))                           return { dim: 'mass', value: n * _OZ_G }
  if (['lb', 'lbs', 'pound', 'pounds'].includes(u))                    return { dim: 'mass', value: n * _LB_G }
  if (['ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres', 'cc'].includes(u)) return { dim: 'volume', value: n }
  if (['l', 'liter', 'liters', 'litre', 'litres'].includes(u))         return { dim: 'volume', value: n * 1000 }
  if (['dl', 'deciliter', 'decilitre'].includes(u))                    return { dim: 'volume', value: n * 100 }
  if (u === 'cl')                                                      return { dim: 'volume', value: n * 10 }

  // cup/tbsp/tsp depend on the ingredient: liquid → volume; solid (with a
  // grams_per_cup density) → mass; otherwise not confidently reconcilable.
  const cup = ['cup', 'cups', 'c'].includes(u)
  const tbsp = ['tbsp', 'tbs', 'tablespoon', 'tablespoons'].includes(u)
  const tsp = ['tsp', 'teaspoon', 'teaspoons'].includes(u)
  if (cup || tbsp || tsp) {
    if (ut === 'liquid_volume') return { dim: 'volume', value: n * (cup ? _CUP_ML : tbsp ? _TBSP_ML : _TSP_ML) }
    if (ut === 'solid_volume' && master?.grams_per_cup)
      return { dim: 'mass', value: n * master.grams_per_cup / (cup ? 1 : tbsp ? 16 : 48) }
    return null
  }
  return null
}

// Sum a list of {quantity, unit} contributions into one canonical total. Returns
// null if any contribution can't convert or they span different dimensions.
function sumNeeded(contribs, master) {
  let dim = null, total = 0
  for (const c of contribs) {
    const can = toCanonical(c.quantity, c.unit, master)
    if (!can) return null
    if (dim && can.dim !== dim) return null
    dim = can.dim; total += can.value
  }
  return dim ? { dim, value: total } : null
}

function fmtCanonical(dim, v) {
  if (dim === 'mass')   return v >= 1000 ? `${+(v / 1000).toFixed(2)}kg` : `${Math.round(v)}g`
  if (dim === 'volume') return v >= 1000 ? `${+(v / 1000).toFixed(2)}L`  : `${Math.round(v)}ml`
  return `${Math.round(v * 100) / 100}`   // count — bare number
}
// Raw inventory amount as-is (for the "you have some (…)" hint when units don't reconcile).
function fmtRaw(q, u) {
  if (q == null) return 'some'
  return `${fmtQty(q)}${u ? ' ' + u : ''}`
}
// Canonical unit a needed amount is expressed in (for normalising on "got it").
function canonUnitFor(dim) { return dim === 'mass' ? 'g' : dim === 'volume' ? 'ml' : '' }

// Grocery sort, shared by both sections: low-stock first (status out/very_low/low,
// a shortfall, or out of stock), by last_updated_at DESC with never-checked items
// at the bottom of that group; everything else alphabetically by name.
const LOW_STATUS = new Set(['out', 'very_low', 'low'])
function isLowStock(item) {
  return !!item.shortfall || LOW_STATUS.has(item.status) || item.quantity === 0 || item.quantity === null
}
function grocerySort(a, b) {
  const la = isLowStock(a), lb = isLowStock(b)
  if (la !== lb) return la ? -1 : 1
  if (la) {
    const ua = a.last_updated_at || a.lastUpdated || null   // OOS rows vs needed entries
    const ub = b.last_updated_at || b.lastUpdated || null
    if (ua && ub) return ub < ua ? -1 : ub > ua ? 1 : 0     // most recent first
    if (ua) return -1                                       // a checked, b never → a first
    if (ub) return 1
    return (a.name || '').localeCompare(b.name || '')       // both never-checked → alpha
  }
  return (a.name || '').localeCompare(b.name || '')
}

function findInventoryMatch(ingNorm, inventoryItems) {
  return inventoryItems.find(item => {
    const itemNorm = item.name.toLowerCase()
    if (itemNorm === ingNorm) return true
    if (itemNorm.includes(ingNorm) || ingNorm.includes(itemNorm)) return true
    const ingWords  = ingNorm.split(/\s+/).filter(w => w.length >= 4)
    const itemWords = itemNorm.split(/\s+/)
    return ingWords.some(w => itemWords.includes(w))
  })
}

function renderGrocery() {
  contentEl.innerHTML = ''

  const { outOfStock, needed } = groceryData
  if (!outOfStock.length && !needed.length) {
    contentEl.appendChild(mkEmpty('Nothing needed — you\'re all set!'))
    return
  }

  if (outOfStock.length) {
    contentEl.appendChild(buildGrocerySection('Out of stock', outOfStock.length))
    const card = document.createElement('div')
    card.className = 'card pn-section-card'
    outOfStock.forEach((item, i) => card.appendChild(buildGroceryOOSRow(item, i < outOfStock.length - 1)))
    contentEl.appendChild(card)
  }

  if (needed.length) {
    contentEl.appendChild(buildGrocerySection('Needed for upcoming meals', needed.length))
    const card = document.createElement('div')
    card.className = 'card pn-section-card'
    needed.forEach((item, i) => card.appendChild(buildGroceryNeededRow(item, i < needed.length - 1)))
    contentEl.appendChild(card)
  }
}

function buildGrocerySection(title, count) {
  const h = document.createElement('div')
  h.className = 'pn-grocery-heading'
  h.innerHTML = `<span>${title}</span><span class="pn-grocery-count">${count}</span>`
  return h
}

function buildGroceryOOSRow(item, ruled) {
  const row = document.createElement('div')
  row.className = 'pn-grocery-row' + (ruled ? ' pn-row--ruled' : '')

  const check = mkGroceryCheck(() => gotItOOS(item.id))
  const body = document.createElement('div')
  body.className = 'pn-grocery-body'

  const name = document.createElement('div')
  name.className = 'pn-row__main'
  name.textContent = item.name

  const meta = document.createElement('div')
  meta.className = 'pn-row__meta'
  meta.textContent = CAT_LABELS[item.category] || item.category || ''

  body.append(name, meta)

  if (item.neededFor?.length) {
    const also = document.createElement('div')
    also.className = 'pn-grocery-also'
    const recipes = [...new Map(item.neededFor.map(u => [u.recipe_id + u.date, u])).values()]
    also.textContent = 'Also needed: ' + recipes.map(u => `${u.recipeName} (${u.dateLabel})`).join(', ')
    body.appendChild(also)
  }

  row.append(check, body)
  return row
}

function buildGroceryNeededRow(item, ruled) {
  const row = document.createElement('div')
  row.className = 'pn-grocery-row' + (ruled ? ' pn-row--ruled' : '')

  const check = mkGroceryCheck(() => gotItNeeded(item))
  const body = document.createElement('div')
  body.className = 'pn-grocery-body'

  const name = document.createElement('div')
  name.className = 'pn-row__main'
  name.textContent = item.name
  body.appendChild(name)

  // Availability hint, shown with (not instead of) the recipe context.
  // Quantity-aware even when units don't reconcile: precise shortfall when we can
  // compute it, else a softer "you have some" / "not in stock".
  const s = item.shortfall
  if (s) {
    const sl = document.createElement('div')
    sl.className = 'pn-grocery-shortfall'
    if (s.kind === 'short') {
      const have = `${s.estimate ? '~' : ''}${fmtCanonical(s.dim, s.availVal)}`
      const est  = s.estimate ? ` (estimated from ‘${s.statusLabel}’)` : ''
      sl.textContent = `Need ${fmtCanonical(s.dim, s.neededVal)}, have ${have}${est} — buy at least ${fmtCanonical(s.dim, s.neededVal - s.availVal)} more`
    } else if (s.kind === 'have_some') {
      sl.className += ' pn-grocery-shortfall--soft'
      sl.textContent = `Need ${fmtCanonical(s.dim, s.neededVal)} · you have some (${s.haveRaw}) — double-check it's enough`
    } else if (s.kind === 'need') {
      sl.textContent = `Need ${fmtCanonical(s.dim, s.neededVal)} · not in stock`
    } else {   // 'out'
      sl.textContent = 'Not in stock'
    }
    body.appendChild(sl)
  }

  const meta = document.createElement('div')
  meta.className = 'pn-row__meta'
  const deduped = [...new Map(item.usages.map(u => [u.recipe_id + u.date, u])).values()]
  meta.textContent = deduped.map(u => `${u.emoji ? u.emoji + ' ' : ''}${u.recipeName} (${u.dateLabel})`).join(', ')
  body.appendChild(meta)

  row.append(check, body)
  return row
}

function mkGroceryCheck(onClick) {
  const btn = document.createElement('button')
  btn.className = 'pn-grocery-check'
  btn.setAttribute('aria-label', 'Got it')
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`
  btn.addEventListener('click', async e => {
    e.stopPropagation()
    btn.disabled = true
    btn.classList.add('pn-grocery-check--busy')
    await onClick()
  })
  return btn
}

async function gotItOOS(itemId) {
  await supabase.from('inventory').update({ quantity: 1 }).eq('id', itemId)
  toast('Marked as bought')
  await loadGrocery(); renderGrocery()
}

async function gotItNeeded(item) {
  const s = item.shortfall
  if (item.matchedInventoryId && s && s.setQty != null) {
    // Top up to the needed amount. For a 'have_some' item we also normalise the
    // unit to the comparable one (s.setUnit) so it reconciles next time. Clearing
    // status marks it a real count; the trigger refreshes last_updated_at/expiry.
    const upd = { quantity: s.setQty, status: null }
    if (s.setUnit) upd.unit = s.setUnit
    await supabase.from('inventory').update(upd).eq('id', item.matchedInventoryId)
  } else if (item.matchedInventoryId) {
    // Shortfall not confidently known (presence/absence) → simple default.
    await supabase.from('inventory').update({ quantity: 1, status: null }).eq('id', item.matchedInventoryId)
  } else {
    await supabase.from('inventory').insert({ name: item.name, quantity: 1, category: 'pantry', active: true })
  }
  toast('Marked as bought')
  await loadGrocery(); renderGrocery()
}

function fmtPlanDate(iso) {
  if (!iso) return ''
  const d = new Date(iso + 'T12:00:00')
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
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

import { supabase, FUNCTIONS_URL, navigateTo, navState, toast, pushView, mkFab, openModal, closeModal } from '../app.js'
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
let groceryData   = { lowStock: [], snapshot: null }
let snapshotLoading = false

let showHiddenInventory = false
let showHiddenFreezer   = false
let inventorySearch     = ''

const catOpenState = { fridge: true, freezer: true, pantry: true }
const groceryOpenState = { low: true, plan: true }

const CAT_LABELS = { fridge: '🧊 Fridge', freezer: '❄️ Freezer', pantry: '🥫 Pantry' }
const CAT_WORD   = { fridge: 'Fridge', freezer: 'Freezer', pantry: 'Pantry' }
const CAT_LIST   = ['fridge', 'freezer', 'pantry']

const FOOD_CATS = [
  ['meat','Meat'], ['seafood','Seafood'], ['produce','Produce'],
  ['dairy','Dairy'], ['eggs','Eggs'], ['pantry','Pantry'], ['other','Other'],
]

// Loose status ↔ quantity: status is an input convenience that resolves to a
// real quantity against the item's typical_quantity baseline.
const STATUS_ORDER = ['out', 'very_low', 'some', 'enough', 'plenty', 'overstock']
const STATUS_PCT   = { out: 0, very_low: 0.10, some: 0.25, enough: 0.60, plenty: 0.85, overstock: 1.25 }
const STATUS_LABEL = { out: 'Out', very_low: 'Very low', some: 'Some', enough: 'Enough', plenty: 'Plenty', overstock: 'Overstock' }

// An item with typical_quantity = 0 is "atypical" — a one-off the household
// doesn't normally stock. It has no baseline to derive a status against, so it
// carries an explicit stored status ('some' while it has stock) instead.
function isAtypical(item) { return Number(item.typical_quantity) === 0 }
// Status to DISPLAY on the pill: stored for atypical items, derived otherwise.
function displayStatus(item) {
  return isAtypical(item) ? (item.status || null) : deriveStatus(item.quantity, item.typical_quantity)
}

// Out of stock: an explicit zero quantity, or a status that resolves to 'out'.
// Used to hide the (irrelevant) expiry label and sink these to the bottom.
function isOutOfStock(item) {
  if (item.quantity != null && Number(item.quantity) === 0) return true
  return displayStatus(item) === 'out'
}

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

// ── Consumption-depletion sort (S2/S3) ────────────────────
// Floats likely-depleted items to the top WITHIN each category, so a pre-Sunday
// inventory check surfaces the right items first. Fully dynamic — no stored
// signal — derived at load from what's actually been cooked since the last
// grocery import. Three signals: cooking recency+frequency (recipe-linked items),
// turnover (perishability by food_category), and time since last restock/check.
const TURNOVER_BY_FOODCAT = { seafood: 5, meat: 4, produce: 4, dairy: 3, eggs: 2 }
const DAY_MS = 86400000

// higher = burns faster (more likely depleted for the same use); staples = 1
function turnoverScore(item) { return TURNOVER_BY_FOODCAT[item.food_category] || 1 }

// signal = { count, lastMs } — how often/recently this item was cooked with (or null)
function depletionScore(item, signal, nowMs) {
  const cook = signal ? (Math.min(signal.count, 5) + (nowMs - signal.lastMs < 3 * DAY_MS ? 2 : 0)) : 0
  const restockDays = item.last_updated_at ? (nowMs - Date.parse(item.last_updated_at)) / DAY_MS : 30
  const restock = Math.min(restockDays, 30) / 7   // weeks since restock (null = surface it)
  return 1.5 * cook + turnoverScore(item) + restock
}

// Cooking signal: meals actually made since the last grocery import, mapped
// through recipe ingredients to per-ingredient counts (keyed by
// master_ingredient_id, name fallback for unlinked). Best-effort: any failure
// degrades the sort to turnover + restock only, never breaks the screen.
async function loadCookSignal() {
  const nowMs = Date.now()
  const byMaster = new Map(), byName = new Map()
  // Reference point: the last grocery import (durable order ledger). If that
  // table isn't readable here, fall back to a 14-day window rather than losing
  // the whole cooking signal.
  let refMs = nowMs - 14 * DAY_MS
  try {
    const { data: last } = await supabase.from('processed_orders')
      .select('created_at').order('created_at', { ascending: false }).limit(1)
    if (last?.[0]?.created_at) refMs = Date.parse(last[0].created_at)
  } catch (_e) { /* keep the 14-day fallback */ }
  try {
    const refDate = new Date(refMs).toISOString().slice(0, 10)

    const { data: cooked } = await supabase.from('meal_plans')
      .select('plan_date, actual_recipe_id, recipe_id, actually_made')
      .gte('plan_date', refDate)
      .or('actual_recipe_id.not.is.null,actually_made.eq.true')
    const events = []   // { rid, dateMs } for each meal actually cooked
    for (const r of cooked || []) {
      const rid = r.actual_recipe_id || (r.actually_made ? r.recipe_id : null)
      if (rid) events.push({ rid, dateMs: Date.parse(r.plan_date) })
    }
    if (!events.length) return { byMaster, byName, nowMs }

    const rids = [...new Set(events.map(e => e.rid))]
    const { data: ings } = await supabase.from('recipe_ingredients')
      .select('recipe_id, master_ingredient_id, name').in('recipe_id', rids)
    const byRecipe = new Map()
    for (const ig of ings || []) {
      if (!byRecipe.has(ig.recipe_id)) byRecipe.set(ig.recipe_id, [])
      byRecipe.get(ig.recipe_id).push(ig)
    }
    const bump = (map, key, dateMs) => {
      const e = map.get(key) || { count: 0, lastMs: 0 }
      e.count += 1; e.lastMs = Math.max(e.lastMs, dateMs); map.set(key, e)
    }
    for (const ev of events) {
      for (const ig of byRecipe.get(ev.rid) || []) {
        if (ig.master_ingredient_id) bump(byMaster, ig.master_ingredient_id, ev.dateMs)
        else if (ig.name) bump(byName, ig.name.toLowerCase().trim(), ev.dateMs)
      }
    }
  } catch (_e) { /* best-effort — fall back to turnover + restock */ }
  return { byMaster, byName, nowMs }
}

async function loadInventory() {
  // Inventory + prepped components (the latter shown read-only within Inventory
  // for a single "everything available to cook with" view) + the cook signal.
  const [{ data }, { data: prepped }, { data: masters }, cookSignal] = await Promise.all([
    supabase.from('inventory').select('*').order('name'),
    supabase.from('prepped_components').select('*, recipes(id, name, emoji)')
      .eq('active', true).gt('batches_remaining', 0).order('made_date', { ascending: false }),
    supabase.from('master_ingredients').select('id, canonical_name, aliases, default_category')
      .eq('active', true).order('canonical_name'),
    loadCookSignal(),
  ])
  masterList = masters || []
  const { byMaster, byName, nowMs } = cookSignal
  const signalFor = (it) =>
    byMaster.get(it.master_ingredient_id) || byName.get((it.name || '').toLowerCase().trim()) || null
  // Sort: favourites pinned (alpha), then most-likely-depleted first — grouping
  // in renderInventory preserves this order, so items sort by depletion WITHIN
  // each category. (never-checked items float up now, via a high restock score.)
  inventoryData = (data || [])
    .map(it => ({ it, dep: depletionScore(it, signalFor(it), nowMs) }))
    .sort((a, b) => {
      const fa = !!a.it.is_favourite, fb = !!b.it.is_favourite
      if (fa !== fb) return fa ? -1 : 1
      if (fa) return (a.it.name || '').localeCompare(b.it.name || '')
      if (b.dep !== a.dep) return b.dep - a.dep
      return (a.it.name || '').localeCompare(b.it.name || '')
    })
    .map(s => s.it)
  preppedData = prepped || []
}

function renderInventory() {
  contentEl.innerHTML = ''

  // Adding a new item is the standard FAB (appended below).
  // Search box — filters across all categories at once; only the list re-renders
  // on input (the input persists, so focus/caret are kept).
  const searchWrap = document.createElement('div')
  searchWrap.className = 'pn-inv-searchwrap'
  const search = document.createElement('input')
  search.type = 'search'
  search.className = 'pn-inv-search'
  search.placeholder = 'Search inventory…'
  search.value = inventorySearch
  search.addEventListener('input', () => { inventorySearch = search.value; renderBody() })
  const searchIcon = document.createElement('span')
  searchIcon.className = 'pn-inv-search-icon'
  searchIcon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>'
  searchWrap.append(search, searchIcon)
  const listEl = document.createElement('div')
  contentEl.append(searchWrap, listEl)
  contentEl.appendChild(mkFab(() => openInventoryForm(null, 'pantry'), 'Add inventory item'))

  function renderBody() {
    listEl.innerHTML = ''
    const q = inventorySearch.trim().toLowerCase()
    const active = inventoryData.filter(i => i.active !== false)
    const hidden = inventoryData.filter(i => i.active === false)

    // Filtered: flat list across all storage categories, normal sort preserved.
    // Search also surfaces INACTIVE matches (dimmed, below the active ones) so an
    // existing-but-inactive item is findable instead of being re-created.
    if (q) {
      const activeHits   = active.filter(i => (i.name || '').toLowerCase().includes(q))
      const inactiveHits = hidden.filter(i => (i.name || '').toLowerCase().includes(q))
      if (!activeHits.length && !inactiveHits.length) { listEl.appendChild(mkEmpty('No items match your search.')); return }
      const card = document.createElement('div')
      card.className = 'card su-card'
      const total = activeHits.length + inactiveHits.length
      activeHits.forEach((item, i) => card.appendChild(buildInventoryRow(item, i < total - 1)))
      inactiveHits.forEach((item, i) => card.appendChild(buildInactiveInventoryRow(item, activeHits.length + i < total - 1)))
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
      let items = bycat[catKey]
      if (!items?.length) return
      // Fridge: in-stock items first, ordered by soonest expiry (alphabetical
      // tie-breaker; items with no expiry come after dated ones). Out-of-stock
      // items are irrelevant, so they sink to the bottom, alphabetically.
      if (catKey === 'fridge') {
        const alpha = (a, b) => (a.name || '').localeCompare(b.name || '')
        items = [...items].sort((a, b) => {
          const aOut = isOutOfStock(a), bOut = isOutOfStock(b)
          if (aOut !== bOut) return aOut ? 1 : -1
          if (!aOut) {
            const ea = a.expiry_date || '', eb = b.expiry_date || ''
            if (ea && eb) { if (ea !== eb) return ea < eb ? -1 : 1 }
            else if (ea) return -1
            else if (eb) return 1
          }
          return alpha(a, b)
        })
      }
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
// Inactive item shown in search results: dimmed name + "Inactive" tag, no
// status control. Tapping opens the edit form (which shows a reactivate banner).
function buildInactiveInventoryRow(item, ruled) {
  const wrap = document.createElement('div')
  wrap.className = 'pn-inv-item pn-inv-item--inactive' + (ruled ? ' pn-row--ruled' : '')
  const row = document.createElement('div')
  row.className = 'pn-row pn-inv-row'
  const tap = document.createElement('div')
  tap.className = 'pn-inv-tap'
  const line = document.createElement('div')
  line.className = 'pn-inactive-line'
  const name = document.createElement('div')
  name.className = 'pn-row__main pn-inv-name is-inactive-name'
  name.textContent = item.name
  const tag = document.createElement('span')
  tag.className = 'inactive-tag'
  tag.textContent = 'Inactive'
  line.append(name, tag)
  tap.appendChild(line)
  tap.addEventListener('click', () => openInventoryForm(item.id, item.category || 'pantry'))
  row.appendChild(tap)
  wrap.appendChild(row)
  return wrap
}

function buildInventoryRow(item, ruled) {
  const wrap = document.createElement('div')
  renderInvItem(wrap, item, ruled)
  // Long-press (mobile) / right-click (desktop) opens the deactivate sheet. The
  // gesture lives on `wrap`, which survives in-place re-renders (renderInvItem
  // only rebuilds children), so it's wired once and not duplicated on re-render.
  attachDeactivateGesture(wrap, item)
  return wrap
}

// Reveal the deactivate action via a deliberate gesture, adding nothing visible
// to the row. Touch: a sustained 450ms press that a scroll (>10px move) cancels,
// so it can't fire while flicking the list. Desktop: contextmenu (right-click).
// A long-press also swallows the trailing click so the row's edit-form tap (and
// any child control) doesn't also fire.
function attachDeactivateGesture(wrap, item) {
  const LONG_PRESS_MS = 450
  const MOVE_TOLERANCE = 10
  let timer = null
  let sx = 0, sy = 0
  let suppressClick = false
  let touchActive = false

  const cancel = () => { if (timer) { clearTimeout(timer); timer = null } }

  wrap.addEventListener('touchstart', e => {
    touchActive = true
    if (e.touches.length !== 1) { cancel(); return }
    sx = e.touches[0].clientX; sy = e.touches[0].clientY
    cancel()
    timer = setTimeout(() => {
      timer = null
      // Swallow only the synthetic click from THIS press; self-expire so it can
      // never eat a later legitimate tap (the click may land on the sheet
      // overlay rather than the row, so it won't always reach the handler below).
      suppressClick = true
      setTimeout(() => { suppressClick = false }, 700)
      if (navigator.vibrate) navigator.vibrate(10)
      openDeactivateSheet(item)
    }, LONG_PRESS_MS)
  }, { passive: true })

  wrap.addEventListener('touchmove', e => {
    const t = e.touches[0]
    if (!t) return
    if (Math.abs(t.clientX - sx) > MOVE_TOLERANCE || Math.abs(t.clientY - sy) > MOVE_TOLERANCE) cancel()
  }, { passive: true })

  // Keep touchActive true briefly after lift so the contextmenu that some mobile
  // browsers fire at the end of a long-press is still recognised as touch-driven.
  const endTouch = () => { cancel(); setTimeout(() => { touchActive = false }, 700) }
  wrap.addEventListener('touchend', endTouch, { passive: true })
  wrap.addEventListener('touchcancel', endTouch, { passive: true })

  // Capture-phase: eat the synthetic click that follows a fired long-press,
  // before it reaches the row's own tap handler.
  wrap.addEventListener('click', e => {
    if (suppressClick) { e.stopPropagation(); e.preventDefault(); suppressClick = false }
  }, true)

  // contextmenu fires for BOTH desktop right-click and (on Android) a touch
  // long-press. Always block the native menu; only open the sheet here when it
  // was NOT a touch — the touch timer already handles long-press, so opening
  // here too would fire the gesture twice.
  wrap.addEventListener('contextmenu', e => {
    e.preventDefault()
    if (touchActive) return
    openDeactivateSheet(item)
  })
}

// Only one sheet at a time — belt-and-suspenders against a long-press firing
// both the touch timer and a contextmenu before the first sheet's modal entry
// settles.
let deactivateSheetOpen = false

// Centered contextual action sheet — same destructive-action treatment (muted
// red) used elsewhere in the app. No confirmation screen: tapping Deactivate
// acts immediately. Routed through openModal so Back/▷-swipe and an overlay tap
// dismiss it cleanly.
function openDeactivateSheet(item) {
  if (deactivateSheetOpen) return
  deactivateSheetOpen = true

  const overlay = document.createElement('div')
  overlay.className = 'act-overlay'
  const sheet = document.createElement('div')
  sheet.className = 'act-sheet'

  // The long-press that opens this sheet ends in a click once the finger lifts.
  // That "ghost click" lands on whatever is now under the finger — the overlay
  // (or even a button, if the pressed row sat low on screen) — and would
  // instantly dismiss the sheet or fire an action. Guard: only honour a click
  // whose press STARTED inside the sheet. The opening press started on the row,
  // before this overlay existed, so its trailing click registered no
  // pointerdown/touchstart here and is ignored.
  // Clears the single-open guard on every dismissal path (buttons, backdrop tap,
  // and the Back-gesture onClose below).
  const close = () => { deactivateSheetOpen = false; closeModal(overlay) }

  let pressInside = false
  const markInside = () => { pressInside = true }
  overlay.addEventListener('pointerdown', markInside)
  overlay.addEventListener('touchstart', markInside, { passive: true })
  overlay.addEventListener('mousedown', markInside)

  const deact = document.createElement('button')
  deact.className = 'act-sheet__btn act-sheet__btn--danger'
  deact.textContent = `Deactivate “${item.name}”`
  deact.addEventListener('click', () => { if (!pressInside) return; close(); deactivateInventoryItem(item) })

  const cancelBtn = document.createElement('button')
  cancelBtn.className = 'act-sheet__btn act-sheet__btn--cancel'
  cancelBtn.textContent = 'Cancel'
  cancelBtn.addEventListener('click', () => { if (!pressInside) return; close() })

  sheet.append(deact, cancelBtn)
  overlay.appendChild(sheet)
  overlay.addEventListener('click', e => { if (e.target === overlay && pressInside) close() })
  document.body.appendChild(overlay)
  openModal(overlay, () => { deactivateSheetOpen = false; overlay.remove() })
}

// Deactivate = active:false (the same hidden state as "Hide this item"). Optimistic:
// flip local state and re-render so the row vanishes instantly, then offer a 5s Undo.
async function deactivateInventoryItem(item) {
  const { error } = await supabase.from('inventory').update({ active: false }).eq('id', item.id)
  if (error) { toast('Deactivate failed', { error: true }); return }
  const idx = inventoryData.findIndex(x => x.id === item.id)
  if (idx >= 0) inventoryData[idx].active = false
  renderInventory()
  toast(`${item.name} deactivated`, {
    duration: 5000,
    action: { label: 'Undo', onClick: () => reactivateInventoryItem(item) },
  })
}

async function reactivateInventoryItem(item) {
  const { error } = await supabase.from('inventory').update({ active: true }).eq('id', item.id)
  if (error) { toast('Undo failed', { error: true }); return }
  const idx = inventoryData.findIndex(x => x.id === item.id)
  if (idx >= 0) inventoryData[idx].active = true
  renderInventory()
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

  // Secondary line: "updated [X] · exp [date] · typical [Y]". Storage category is
  // omitted (the section grouping already shows it); segments with no data are
  // dropped cleanly. A '·' is inserted before each segment after the first.
  const sub = document.createElement('div')
  sub.className = 'pn-inv-sub'
  const addSeg = (el) => { if (sub.childNodes.length) sub.appendChild(document.createTextNode(' · ')); sub.appendChild(el) }

  const upd = document.createElement('span')
  if (!item.last_updated_at) { upd.className = 'pn-sub-warn'; upd.textContent = 'never checked' }
  else { upd.textContent = 'updated ' + relTime(item.last_updated_at) }
  addSeg(upd)

  // Skip the expiry label entirely when the item is out of stock — an expired/
  // expiry pill on something you don't have is just noise.
  const ei = isOutOfStock(item) ? null : expiryInfo(item.expiry_date)
  if (ei) {
    const e = document.createElement('span')
    e.textContent = ei.text
    if (ei.warn) e.className = 'pn-sub-warn'
    addSeg(e)
  }

  if (item.typical_quantity != null) {
    const t = document.createElement('span')
    t.textContent = `typical ${fmtQty(item.typical_quantity)}${item.unit ? ' ' + item.unit : ''}`
    addSeg(t)
  }

  tap.append(name, sub)
  tap.addEventListener('click', () => openInventoryForm(item.id, item.category || 'pantry'))

  // Favourite star sits at the left edge so the stars line up in a column
  // rather than drifting with each row's content width.
  row.appendChild(buildFavStar(wrap, item, ruled))
  row.appendChild(tap)

  // Quick-adjust control.
  row.appendChild(
    item.typical_quantity != null
      ? buildStatusControl(wrap, item, ruled)
      : buildStepper(wrap, item, ruled)
  )

  wrap.appendChild(row)
}

// Favourite toggle — display order only (no AI/planning influence). Instant,
// no navigation; flips in place (re-sorts on the next list render).
function buildFavStar(wrap, item, ruled) {
  const b = document.createElement('button')
  b.className = 'pn-fav' + (item.is_favourite ? ' pn-fav--on' : '')
  b.setAttribute('aria-label', item.is_favourite ? 'Unfavourite' : 'Favourite')
  b.textContent = item.is_favourite ? '★' : '☆'
  b.addEventListener('click', e => { e.stopPropagation(); setFav(wrap, item, ruled) })
  return b
}
async function setFav(wrap, item, ruled) {
  const nv = !item.is_favourite
  const { error } = await supabase.from('inventory').update({ is_favourite: nv }).eq('id', item.id)
  if (error) { toast('Update failed', { error: true }); return }
  item.is_favourite = nv
  const idx = inventoryData.findIndex(x => x.id === item.id)
  if (idx >= 0) inventoryData[idx].is_favourite = nv
  renderInvItem(wrap, item, ruled)
}

// Persist a new quantity (+ optional status) by ANY quick path; the DB trigger
// handles last_updated_at + expiry. Re-render in place with the fresh row.
async function setInvQuantity(wrap, item, ruled, newQty, statusKey) {
  const payload = { quantity: newQty }
  if (statusKey !== undefined) payload.status = statusKey
  // Atypical items (typical_quantity = 0) auto-reconcile in the same write:
  // any stock → status 'some'; emptied (qty 0 or status 'out') → auto-deactivate
  // so the one-off drops out of inventory rather than sitting at zero.
  let deactivated = false
  if (isAtypical(item)) {
    if (statusKey === 'out' || Number(newQty) <= 0) { payload.status = 'out'; payload.active = false; deactivated = true }
    else { payload.status = 'some' }
  }
  const { data, error } = await supabase.from('inventory').update(payload).eq('id', item.id).select('*').single()
  if (error || !data) { toast('Update failed', { error: true }); return }
  Object.assign(item, data)
  const idx = inventoryData.findIndex(x => x.id === item.id)
  if (idx >= 0) inventoryData[idx] = { ...inventoryData[idx], ...data }
  if (deactivated) {
    renderInventory()   // full re-render: the emptied atypical item disappears
    toast(`${item.name} used up — removed from inventory`)
  } else {
    renderInvItem(wrap, item, ruled)
  }
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
  const cur = displayStatus(item)
  // Atypical item with stock → amber outline pill. Regular low-stock statuses
  // (out / very low / some) → filled green pill so they stand out. The amber
  // treatment takes precedence (an atypical 'some' is never also green).
  const atypicalSome = isAtypical(item) && cur === 'some'
  const pill = document.createElement('button')
  pill.className = 'pn-status-pill'
    + (atypicalSome ? ' pn-status-pill--atypical' : (LOW_STATUS.has(cur) ? ' pn-status-pill--low' : ''))
  pill.textContent = STATUS_LABEL[cur] || '—'
  // The percentage grid is meaningless when typical = 0 (every option resolves
  // to qty 0), so atypical items get a direct exact-amount entry instead.
  pill.addEventListener('click', e => {
    e.stopPropagation()
    if (isAtypical(item)) toggleExactAmount(wrap, item, ruled, pill)
    else toggleStatusGrid(wrap, item, ruled, pill)
  })
  c.appendChild(pill)
  return c
}

// Inline exact-amount entry for atypical items (typical = 0). Setting a value
// >0 marks it 'some'; setting 0 empties it and setInvQuantity auto-deactivates.
function toggleExactAmount(wrap, item, ruled, pill) {
  const open = wrap.querySelector('.pn-status-grid')
  if (open) { open.remove(); pill.classList.remove('pn-status-pill--open'); return }
  pill.classList.add('pn-status-pill--open')
  const grid = document.createElement('div')
  grid.className = 'pn-status-grid pn-status-grid--exact'
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
  wrap.appendChild(grid)
  inp.focus()
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

  // Reactivation banner — shown when editing an inactive item reached via search.
  if (item && item.active === false) {
    const banner = document.createElement('div')
    banner.className = 'reactivate-banner'
    banner.textContent = 'This item is inactive. Saving changes will reactivate it.'
    form.appendChild(banner)
  }

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
    // Saving an inactive item (reached via search) reactivates it. The atypical
    // reconcile below may still re-hide it if it's a typical=0 item with no stock.
    if (item && item.active === false) payload.active = true
    // Atypical reconcile (typical_quantity = 0): stock → 'some'; emptied → drop
    // it out of inventory (active = false) in the same save.
    if (Number(payload.typical_quantity) === 0) {
      if (payload.quantity == null || Number(payload.quantity) <= 0) { payload.status = 'out'; payload.active = false }
      else { payload.status = 'some' }
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
    supabase.from('recipes').select('id, name, meal_type, emoji, is_placeholder').eq('active', true).order('name'),
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

// Meal-type prefix shown in the recipe picker, mirroring the Plan-tab picker.
const RLINK_MTYPE_LABEL = { breakfast: 'Breakfast', lunch_dinner: 'Dinner', snack: 'Snack', special: 'Dessert' }
const RLINK_MTYPE_ORDER = ['lunch_dinner', 'breakfast', 'snack', 'special']
const rlinkMealLabel = mt => RLINK_MTYPE_LABEL[mt] || 'Other'

// Searchable recipe picker — same opaque sheet + search + meal-type prefix as the
// Plan-tab meal picker. Replaces the old semi-transparent native <select> for
// "link to recipe". onPick receives the chosen recipe row, or null for "not linked".
function openRecipeLinkPicker(onPick) {
  const overlay = document.createElement('div'); overlay.className = 'picker-overlay'
  const sheet   = document.createElement('div'); sheet.className = 'picker-sheet'
  const head    = document.createElement('div'); head.className = 'picker-header'
  head.innerHTML = `<span class="picker-title">Link to recipe</span><button class="picker-close" aria-label="Close">✕</button>`
  head.querySelector('.picker-close').addEventListener('click', () => closeModal(overlay))
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(overlay) })

  const search = document.createElement('input')
  search.type = 'text'; search.className = 'picker-search'; search.placeholder = 'Search recipes…'
  const list = document.createElement('div'); list.className = 'picker-list'

  // Pool: non-placeholder recipes, grouped by meal type (dinner first), alpha within.
  const pool = recipeList.filter(r => !r.is_placeholder).slice().sort((a, b) => {
    const ao = RLINK_MTYPE_ORDER.indexOf(a.meal_type), bo = RLINK_MTYPE_ORDER.indexOf(b.meal_type)
    const av = ao === -1 ? 99 : ao, bv = bo === -1 ? 99 : bo
    if (av !== bv) return av - bv
    return (a.name || '').localeCompare(b.name || '')
  })

  const pickRow = (emoji, html, onClick, cls) => {
    const row = document.createElement('button')
    row.className = 'picker-row' + (cls ? ' ' + cls : '')
    row.innerHTML = `<span class="picker-row__emoji" aria-hidden="true">${emoji}</span><span class="picker-row__name">${html}</span>`
    row.addEventListener('click', onClick)
    return row
  }

  function renderList(q) {
    const lq = (q || '').toLowerCase()
    list.innerHTML = ''
    // "Not linked" clear option always on top.
    list.appendChild(pickRow('🚫', 'Not linked', () => { closeModal(overlay); onPick(null) }, 'picker-row--other'))
    const hits = lq ? pool.filter(r => (r.name || '').toLowerCase().includes(lq)) : pool
    for (const r of hits) {
      const display = `<span class="picker-row__cat">${rlinkMealLabel(r.meal_type)}</span>${r.name}`
      list.appendChild(pickRow(r.emoji || '🍽️', display, () => { closeModal(overlay); onPick(r) }))
    }
  }
  search.addEventListener('input', () => renderList(search.value))
  renderList('')

  sheet.append(head, search, list)
  overlay.appendChild(sheet)
  document.body.appendChild(overlay)
  openModal(overlay, () => overlay.remove())
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

  // Recipe link — opens the searchable recipe picker (same visual as the Plan
  // tab) rather than a native dropdown.
  const linkSel = { id: entry?.recipe_id || null }
  const linkBtn = document.createElement('button')
  linkBtn.type = 'button'
  linkBtn.className = 'pn-picker-btn'
  const refreshLinkBtn = () => {
    const r = recipeList.find(x => x.id === linkSel.id)
    linkBtn.textContent = r ? r.name : '— not linked —'
    linkBtn.classList.toggle('pn-picker-btn--empty', !r)
  }
  refreshLinkBtn()
  linkBtn.addEventListener('click', () => openRecipeLinkPicker((chosen) => {
    linkSel.id = chosen ? chosen.id : null
    refreshLinkBtn()
    if (chosen && !nameInp.value.trim()) nameInp.value = chosen.name
  }))

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
    mkField('Link to recipe (optional)', linkBtn),
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
      recipe_id:    linkSel.id || null,
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

  const [{ data: invData }, { data: snapRows }] = await Promise.all([
    supabase.from('inventory').select('*').eq('active', true),
    // Most-recent snapshot only — the "Absurd Plan Requirements" list.
    supabase.from('grocery_list_snapshot')
      .select('id, generated_at, triggered_by, plan_date_range_start, plan_date_range_end, items')
      .order('generated_at', { ascending: false }).limit(1),
  ])

  const allInventory = invData || []
  // Section 1 "Absurdly Low Stock": live from inventory — status out/very_low/low
  // OR an explicit zero quantity (never-checked items, null quantity, excluded).
  const lowStock = allInventory.filter(i =>
    LOW_STATUS.has(i.status) || (i.quantity != null && Number(i.quantity) === 0))
  lowStock.sort((a, b) => {
    const fa = !!a.is_favourite, fb = !!b.is_favourite
    if (fa !== fb) return fa ? -1 : 1
    return (a.name || '').localeCompare(b.name || '')
  })

  groceryData = { lowStock, snapshot: (snapRows && snapRows[0]) || null }
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

// Grocery sort, shared by both sections: favourites first (alpha), then low-stock
// (status out/very_low/low, a shortfall, or out of stock) by last_updated_at DESC
// with never-checked items at the bottom of that group, then everything else
// alphabetically. A favourite that's also low-stock stays in the favourites tier.
const LOW_STATUS = new Set(['out', 'very_low', 'some'])
function isLowStock(item) {
  return !!item.shortfall || LOW_STATUS.has(item.status) || item.quantity === 0 || item.quantity === null
}
const favOf = x => !!(x.is_favourite || x.fav)   // OOS rows carry is_favourite; needed entries carry fav
function grocerySort(a, b) {
  const fa = favOf(a), fb = favOf(b)
  if (fa !== fb) return fa ? -1 : 1
  if (fa) return (a.name || '').localeCompare(b.name || '')   // favourites tier — alpha

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
  const { lowStock, snapshot } = groceryData

  // Section 1 — Absurdly Low Stock (live inventory; tap a row to edit it)
  if (lowStock.length) {
    contentEl.appendChild(buildCollapsibleSection('low', 'Absurdly Low Stock', lowStock.length, groceryOpenState, (card) => {
      lowStock.forEach((item, i) => card.appendChild(buildLowStockRow(item, i < lowStock.length - 1)))
    }))
  }

  // Section 2 — Absurd Plan Requirements (saved AI snapshot)
  contentEl.appendChild(buildSnapshotSection(snapshot))
}

// Reusable collapsible section (label + count + chevron header over a card),
// matching the Inventory tab. `fillCard` populates the card's rows.
function buildCollapsibleSection(key, label, count, openMap, fillCard) {
  const wrap = document.createElement('div')
  wrap.className = 'pn-section'
  const header = document.createElement('div')
  header.className = 'pn-section-header'
  const isOpen = openMap[key] ?? true
  const toggleBtn = document.createElement('button')
  toggleBtn.className = 'pn-section-toggle'
  toggleBtn.setAttribute('aria-expanded', String(isOpen))
  toggleBtn.innerHTML = `
    <span class="pn-section-label">${label}</span>
    <span class="pn-section-count">(${count})</span>
    <svg class="pn-section-chev${isOpen ? ' pn-section-chev--open' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path stroke-linecap="round" stroke-linejoin="round" d="m19 9-7 7-7-7"/>
    </svg>`
  header.append(toggleBtn)
  const body = document.createElement('div')
  body.className = 'pn-section-body' + (isOpen ? '' : ' pn-section-body--hidden')
  const card = document.createElement('div')
  card.className = 'card pn-section-card'
  fillCard(card)
  body.appendChild(card)
  toggleBtn.addEventListener('click', () => {
    openMap[key] = !(openMap[key] ?? true)
    toggleBtn.setAttribute('aria-expanded', String(openMap[key]))
    body.classList.toggle('pn-section-body--hidden', !openMap[key])
    toggleBtn.querySelector('.pn-section-chev').classList.toggle('pn-section-chev--open', openMap[key])
  })
  wrap.append(header, body)
  return wrap
}

// Section 1 row — compact single row: name (left), then status pill + staleness/
// expiry (right). No category. Tap to open the item's Inventory edit.
function buildLowStockRow(item, ruled) {
  const row = document.createElement('div')
  row.className = 'pn-grocery-row pn-grocery-row--tap pn-low-row' + (ruled ? ' pn-row--ruled' : '')

  const name = document.createElement('div')
  name.className = 'pn-row__main pn-low-row__name'
  name.textContent = item.name

  const pill = document.createElement('span')
  // Atypical item with stock keeps its amber outline here too; otherwise the
  // standard low-stock pill.
  const atypicalSome = Number(item.typical_quantity) === 0 && item.status === 'some'
  pill.className = 'pn-status-pill pn-low-row__pill ' + (atypicalSome ? 'pn-status-pill--atypical' : 'pn-status-pill--low')
  pill.textContent = STATUS_LABEL[item.status] || 'Out'

  row.append(name, pill)
  row.addEventListener('click', () => openInventoryForm(item.id, item.category || 'pantry'))
  return row
}

// Section 2 — the saved snapshot. Header + "Generated … · covers …" + Regenerate,
// then items grouped by supermarket aisle. No interaction on the items.
const SNAP_CAT_ORDER  = ['produce', 'meat', 'dairy', 'pantry', 'other']
const SNAP_CAT_LABELS = { produce: '🥬 Produce', meat: '🥩 Meat', dairy: '🧀 Dairy', pantry: '🥫 Pantry', other: '📦 Other' }

function buildSnapshotSection(snap) {
  // Same collapsible header as "Absurdly Low Stock"; timestamp, Regenerate, and
  // the item list live in the section's card body.
  const count = snap && snap.items ? snap.items.length : 0
  const section = buildCollapsibleSection('plan', 'Absurd Plan Requirements', count, groceryOpenState, (card) => {
    const metaRow = document.createElement('div')
    metaRow.className = 'pn-snapshot__meta'
    const ts = document.createElement('span')
    ts.className = 'pn-snapshot__ts'
    if (snap) {
      const range = `${fmtShortDate(snap.plan_date_range_start)}–${fmtShortDate(snap.plan_date_range_end)}`
      ts.textContent = `Generated ${relTime(snap.generated_at)} · covers ${range}`
    }
    const regen = document.createElement('button')
    regen.className = 'pn-snapshot__regen'
    regen.textContent = snapshotLoading ? 'Generating…' : 'Regenerate'
    regen.disabled = snapshotLoading
    regen.addEventListener('click', regenerateSnapshot)
    metaRow.append(ts, regen)
    card.appendChild(metaRow)

    if (snapshotLoading) {
      const l = document.createElement('div')
      l.className = 'pn-snapshot__loading'
      l.innerHTML = '<div class="spinner"></div>Building your shopping list…'
      card.appendChild(l)
    } else if (!snap) {
      const e = document.createElement('div')
      e.className = 'pn-snapshot__empty'
      e.textContent = 'No shopping list yet — tap Regenerate to build one'
      card.appendChild(e)
    } else if (!count) {
      const e = document.createElement('div')
      e.className = 'pn-snapshot__empty'
      e.textContent = "You're all set — nothing extra to buy for the upcoming plan."
      card.appendChild(e)
    } else {
      const groups = {}
      for (const it of snap.items) {
        const c = SNAP_CAT_ORDER.includes(it.category) ? it.category : 'other'
        ;(groups[c] = groups[c] || []).push(it)
      }
      for (const cat of SNAP_CAT_ORDER) {
        const list = groups[cat]
        if (!list || !list.length) continue
        const ch = document.createElement('div')
        ch.className = 'pn-snapshot__cat'
        ch.textContent = SNAP_CAT_LABELS[cat]
        card.appendChild(ch)
        list.forEach(it => card.appendChild(buildSnapshotRow(it)))
      }
    }
  })
  section.classList.add('pn-snapshot')
  return section
}

function buildSnapshotRow(it) {
  const row = document.createElement('div')
  row.className = 'pn-grocery-row pn-snapshot-row'
  const body = document.createElement('div')
  body.className = 'pn-grocery-body'
  const name = document.createElement('div')
  name.className = 'pn-row__main'
  const qty = it.quantity && it.quantity !== 'as needed' ? ` — ${it.quantity}` : ''
  name.textContent = `${it.name}${qty}`
  body.appendChild(name)
  if (it.note) {
    const n = document.createElement('div')
    n.className = 'pn-row__meta'
    n.textContent = it.note
    body.appendChild(n)
  }
  row.appendChild(body)
  return row
}

async function regenerateSnapshot() {
  if (snapshotLoading) return
  snapshotLoading = true
  renderGrocery()
  try {
    const res = await fetch(`${FUNCTIONS_URL}/grocery-snapshot`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ triggered_by: 'manual' }),
    })
    const data = await res.json()
    if (!data.success) throw new Error(data.error)
    groceryData.snapshot = data.snapshot
    toast('Shopping list updated')
  } catch {
    toast('Could not generate the list — try again', { error: true })
  } finally {
    snapshotLoading = false
    renderGrocery()
  }
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

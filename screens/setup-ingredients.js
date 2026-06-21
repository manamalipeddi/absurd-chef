import { supabase, navigateTo, navState, toast, pushView } from '../app.js'

let screenEl = null
let items    = []                 // all master_ingredients
let usageByMaster = new Map()     // master id -> [{id, name}] of active recipes
let editId   = null
let formView = null               // history entry for the in-place edit form

const CAT_LABELS = { fridge: '🧊 Fridge', freezer: '❄️ Freezer', pantry: '🥫 Pantry' }

export function init(el) { screenEl = el }

export async function activate({ headerLeft, headerRight }) {
  headerLeft.innerHTML = backBtn('mi-back')
  headerRight.innerHTML = ''
  document.getElementById('mi-back').addEventListener('click', () => history.back())
  editId = null
  formView = null
  await load()
  renderList()
}

// Restore the list (back-swipe path) / close the form from its own UI.
async function backToList() { formView = null; await load(); renderList() }
function closeForm() { const h = formView; formView = null; if (h) h.done(); load().then(renderList) }

async function load() {
  // master ingredients + everything needed to compute "used in" per ingredient
  const [miRes, recRes, riRes, rvRes, rviRes] = await Promise.all([
    supabase.from('master_ingredients').select('*').order('canonical_name'),
    supabase.from('recipes').select('id, name').eq('active', true),
    supabase.from('recipe_ingredients').select('recipe_id, master_ingredient_id').not('master_ingredient_id', 'is', null),
    supabase.from('recipe_variants').select('id, recipe_id'),
    supabase.from('recipe_variant_ingredients').select('variant_id, master_ingredient_id').not('master_ingredient_id', 'is', null),
  ])

  items = miRes.data || []
  const activeRecipes = new Map((recRes.data || []).map(r => [r.id, r.name]))
  const variantToRecipe = new Map((rvRes.data || []).map(v => [v.id, v.recipe_id]))

  // master id -> Set of active recipe ids (dedup across direct + variant usage)
  const byMaster = new Map()
  const add = (mid, rid) => {
    if (!mid || !activeRecipes.has(rid)) return
    if (!byMaster.has(mid)) byMaster.set(mid, new Set())
    byMaster.get(mid).add(rid)
  }
  for (const ri of riRes.data || []) add(ri.master_ingredient_id, ri.recipe_id)
  for (const rvi of rviRes.data || []) add(rvi.master_ingredient_id, variantToRecipe.get(rvi.variant_id))

  usageByMaster = new Map()
  for (const [mid, rids] of byMaster)
    usageByMaster.set(mid, [...rids].map(id => ({ id, name: activeRecipes.get(id) })).sort((a, b) => a.name.localeCompare(b.name)))
}

function usageFor(id) { return usageByMaster.get(id) || [] }

// ── List ──────────────────────────────────────────────────
function renderList() {
  screenEl.innerHTML = ''
  screenEl.appendChild(mkAddBtn('+ Add ingredient', () => openForm(null)))

  const active = items.filter(i => i.active !== false)
  const hidden = items.filter(i => i.active === false)

  if (!active.length) {
    screenEl.appendChild(mkEmpty('No ingredients yet.'))
  } else {
    const card = document.createElement('div')
    card.className = 'card su-card'
    active.forEach((m, i) => card.appendChild(buildRow(m, i < active.length - 1)))
    screenEl.appendChild(card)
  }

  if (hidden.length) appendHiddenSection(hidden)
}

function buildRow(m, ruled) {
  const row = document.createElement('div')
  row.className = 'su-list-row su-mi-row' + (ruled ? ' su-list-row--ruled' : '')

  // Single line: name + usage count + category badge.
  const centre = document.createElement('div')
  centre.className = 'su-mi-line'
  const main = document.createElement('span')
  main.className = 'su-list-row__main'
  main.textContent = m.canonical_name
  const n = usageFor(m.id).length
  const count = document.createElement('span')
  count.className = 'su-mi-count'
  count.textContent = n ? `· ${n} recipe${n !== 1 ? 's' : ''}` : '· unused'
  centre.append(main, count)

  const badge = document.createElement('span')
  badge.className = 'su-cat-badge'
  badge.textContent = CAT_LABELS[m.default_category] || m.default_category || '—'

  row.append(centre, badge)
  row.addEventListener('click', () => openForm(m.id))
  return row
}

function appendHiddenSection(hidden) {
  const toggle = document.createElement('button')
  toggle.className = 'pn-hidden-toggle'
  let open = false
  toggle.textContent = `Show ${hidden.length} hidden ingredient${hidden.length !== 1 ? 's' : ''}`

  const card = document.createElement('div')
  card.className = 'card pn-hidden-card'
  card.style.display = 'none'
  hidden.forEach((m, i) => {
    const row = document.createElement('div')
    row.className = 'su-list-row' + (i < hidden.length - 1 ? ' su-list-row--ruled' : '')
    const centre = document.createElement('div')
    centre.className = 'su-list-row__centre'
    const main = document.createElement('div'); main.className = 'su-list-row__main'; main.textContent = m.canonical_name
    const sub = document.createElement('div'); sub.className = 'su-list-row__sub'; sub.textContent = CAT_LABELS[m.default_category] || m.default_category || ''
    centre.append(main, sub)
    const reBtn = document.createElement('button')
    reBtn.className = 'su-reactivate-btn'
    reBtn.textContent = 'Reactivate'
    reBtn.addEventListener('click', async (e) => {
      e.stopPropagation()
      await supabase.from('master_ingredients').update({ active: true }).eq('id', m.id)
      toast('Reactivated')
      await load(); renderList()
    })
    row.append(centre, reBtn)
    card.appendChild(row)
  })

  toggle.addEventListener('click', () => {
    open = !open
    card.style.display = open ? '' : 'none'
    toggle.textContent = `${open ? 'Hide' : 'Show'} ${hidden.length} hidden ingredient${hidden.length !== 1 ? 's' : ''}`
  })

  screenEl.append(toggle, card)
}

// ── Form ──────────────────────────────────────────────────
function openForm(id) {
  editId = id
  const m = id ? items.find(x => x.id === id) : null
  screenEl.innerHTML = ''
  // History entry so Back returns to the ingredient list, not out to Setup.
  formView = pushView(() => backToList())
  const form = document.createElement('div')
  form.className = 'su-form'

  const nameInp = mkInput('text', m?.canonical_name || '', 'e.g. Chickpeas')
  const catSel  = mkSelect([['fridge', '🧊 Fridge'], ['freezer', '❄️ Freezer'], ['pantry', '🥫 Pantry']], m?.default_category || 'pantry')

  form.append(
    mkField('Canonical name *', nameInp),
    mkField('Default category', catSel),
  )

  // Aliases — repeatable text rows
  const aliasContainer = document.createElement('div'); aliasContainer.className = 'su-rpt'
  ;(m?.aliases || []).forEach(a => aliasContainer.appendChild(mkAliasRow(a)))
  form.append(mkRepeatableField('Aliases (other names, for matching)', aliasContainer,
    () => aliasContainer.appendChild(mkAliasRow(''))))

  const { save, cancel } = mkActions()
  cancel.addEventListener('click', () => closeForm())
  save.addEventListener('click', async () => {
    const name = nameInp.value.trim()
    if (!name) { toast('Canonical name is required', { error: true }); return }
    const aliases = Array.from(aliasContainer.querySelectorAll('input'))
      .map(i => i.value.trim()).filter(Boolean)
    const payload = { canonical_name: name, default_category: catSel.value, aliases }
    save.disabled = true; save.textContent = 'Saving…'
    const op = editId
      ? supabase.from('master_ingredients').update(payload).eq('id', editId)
      : supabase.from('master_ingredients').insert(payload)
    const { error } = await op
    if (error) { toast('Save failed', { error: true }); save.disabled = false; save.textContent = 'Save'; return }
    toast('Saved')
    closeForm()
  })

  const actionsWrap = document.createElement('div')
  actionsWrap.className = 'su-actions'
  actionsWrap.append(cancel, save)
  form.appendChild(actionsWrap)

  // Existing-ingredient-only sections: Used in + Deactivate
  if (editId) {
    form.appendChild(buildUsedIn(editId))
    form.appendChild(buildDeactivate(editId, m))
  }

  screenEl.appendChild(form)
}

function mkAliasRow(value) {
  const row = document.createElement('div'); row.className = 'su-rpt-row'
  const inp = mkInput('text', value || '', 'e.g. garbanzo beans')
  const rm = mkRm(() => row.remove())
  row.append(inp, rm)
  return row
}

function buildUsedIn(id) {
  const sec = document.createElement('div'); sec.className = 'su-field su-usedin'
  const l = document.createElement('div'); l.className = 'su-label'; l.textContent = 'Used in'
  sec.appendChild(l)
  const recipes = usageFor(id)
  if (!recipes.length) {
    const p = document.createElement('p'); p.className = 'su-usedin-empty'
    p.textContent = 'Not currently used in any recipe'
    sec.appendChild(p)
    return sec
  }
  const card = document.createElement('div'); card.className = 'card su-card'
  recipes.forEach((r, i) => {
    const row = document.createElement('div')
    row.className = 'su-list-row' + (i < recipes.length - 1 ? ' su-list-row--ruled' : '')
    const main = document.createElement('div'); main.className = 'su-list-row__main'; main.textContent = r.name
    row.appendChild(main)
    row.addEventListener('click', () => { navState.recipeId = r.id; navigateTo('recipe-detail') })
    card.appendChild(row)
  })
  sec.appendChild(card)
  return sec
}

function buildDeactivate(id, m) {
  const wrap = document.createElement('div'); wrap.className = 'su-danger-zone'
  const btn = document.createElement('button'); btn.className = 'su-deactivate-btn'; btn.textContent = 'Deactivate'
  btn.addEventListener('click', async () => {
    const recipes = usageFor(id)
    if (recipes.length) {
      const names = recipes.map(r => r.name).join(', ')
      const ok = confirm(`This ingredient is used in ${recipes.length} recipe${recipes.length !== 1 ? 's' : ''}: ${names}.\n\nDeactivating it won't remove it from those recipes, but it may affect grocery-list matching. Continue?`)
      if (!ok) return
    }
    btn.disabled = true
    const { error } = await supabase.from('master_ingredients').update({ active: false }).eq('id', id)
    if (error) { toast('Failed', { error: true }); btn.disabled = false; return }
    toast(`${m?.canonical_name || 'Ingredient'} deactivated`)
    closeForm()
  })
  wrap.appendChild(btn)
  return wrap
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

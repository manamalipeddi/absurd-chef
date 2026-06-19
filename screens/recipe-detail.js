import { supabase, FUNCTIONS_URL, navigateTo, navState, toast } from '../app.js'

// ── State ─────────────────────────────────────────────────
let recipe           = null
let variants         = []
let activeTabId      = 'original'
let ingredients      = []
let preppedComponents = []
let subMap           = {}   // `${tabId}:${ingId}` → {loading, message}
let scaleResult      = null
let scaleLabelDraft  = ''
let hacksLoading     = false
let lastRecipeId     = null
let screenEl         = null
let ingListRef       = null

// ── Lifecycle ─────────────────────────────────────────────
export function init(el) { screenEl = el }

export async function activate({ headerLeft, headerRight }) {
  headerLeft.innerHTML = `
    <button class="header-btn" id="btn-back" aria-label="Back">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5"/>
      </svg>
    </button>`
  document.getElementById('btn-back').addEventListener('click', () => navigateTo('recipes'))

  const recipeId = navState.recipeId
  if (!recipeId) return

  screenEl.innerHTML = `<div class="loading-row"><div class="spinner"></div>Loading…</div>`

  if (recipeId !== lastRecipeId) {
    lastRecipeId    = recipeId
    activeTabId     = 'original'
    subMap          = {}
    scaleResult     = null
    scaleLabelDraft = ''
    hacksLoading    = false
    await loadAll(recipeId)
  }

  renderAll()

  // Set edit button after recipe loaded (header slots survive renderAll)
  headerRight.innerHTML = `
    <button class="header-btn" id="btn-edit-recipe" aria-label="Edit recipe">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round"
          d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931zm0 0L19.5 7.125"/>
      </svg>
    </button>`
  document.getElementById('btn-edit-recipe')?.addEventListener('click', () => {
    if (recipe) { navState.editRecipeId = recipe.id; navigateTo('add-recipe') }
  })
}

// ── Data ──────────────────────────────────────────────────
async function loadAll(recipeId) {
  const [recipeRes, variantsRes, pcRes] = await Promise.all([
    supabase.from('recipes')
      .select('id,name,emoji,meal_type,ease_descriptor,serves_base,default_variant_id,night_before,morning_of,when_cooking,hacks_and_shortcuts,original_instructions,protein,cooking_method,can_double')
      .eq('id', recipeId).single(),
    supabase.from('recipe_variants').select('*').eq('recipe_id', recipeId).order('created_at'),
    supabase.from('prepped_components').select('*').eq('recipe_id', recipeId).eq('active', true).order('made_date', { ascending: false }),
  ])

  if (recipeRes.error || !recipeRes.data) {
    screenEl.innerHTML = `<div class="placeholder-wrap"><p class="placeholder-label">Recipe not found</p></div>`
    return
  }

  recipe            = recipeRes.data
  variants          = variantsRes.data  || []
  preppedComponents = pcRes.data        || []

  const titleEl = document.getElementById('screen-title')
  if (titleEl) titleEl.textContent = recipe.name

  await loadIngredients()
}

async function loadIngredients() {
  const isVariant = activeTabId !== 'original'
  const { data } = isVariant
    ? await supabase.from('recipe_variant_ingredients')
        .select('id,name,quantity,unit,notes,order_index,user_marked_unavailable')
        .eq('variant_id', activeTabId).order('order_index')
    : await supabase.from('recipe_ingredients')
        .select('id,name,quantity,unit,notes,order_index,user_marked_unavailable')
        .eq('recipe_id', recipe.id).order('order_index')
  ingredients = data || []
}

// ── Render ────────────────────────────────────────────────
function renderAll() {
  if (!screenEl || !recipe) return
  screenEl.innerHTML = ''
  ingListRef = null

  const root = document.createElement('div')
  root.className = 'rd'
  root.appendChild(buildInfo())
  root.appendChild(buildTabs())
  const content = buildContent()
  content.id = 'rd-content'
  root.appendChild(content)
  screenEl.appendChild(root)
}

async function switchTab(tabId) {
  activeTabId     = tabId
  scaleResult     = null
  scaleLabelDraft = ''
  hacksLoading    = false
  ingListRef      = null
  await loadIngredients()
  const servesEl  = screenEl.querySelector('.rd-serves')
  const tabsEl    = screenEl.querySelector('.rd-tabs')
  const contentEl = document.getElementById('rd-content')
  if (servesEl)  servesEl.replaceWith(buildServes())
  if (tabsEl)    tabsEl.replaceWith(buildTabs())
  if (contentEl) { const nc = buildContent(); nc.id = 'rd-content'; contentEl.replaceWith(nc) }
}

// ── Info / serves ─────────────────────────────────────────
function buildInfo() {
  const wrap  = document.createElement('div')
  wrap.className = 'rd-info'
  const emoji = document.createElement('div')
  emoji.className = 'rd-info__emoji'
  emoji.textContent = recipe.emoji || defaultEmoji(recipe.meal_type)
  wrap.append(emoji, buildServes())
  return wrap
}

function buildServes() {
  const activeVariant = variants.find(v => v.id === activeTabId)
  const current = (activeTabId !== 'original' && activeVariant?.serves != null)
    ? activeVariant.serves : (recipe.serves_base ?? 4)

  const wrap  = document.createElement('div')
  wrap.className = 'rd-serves'
  const lbl = document.createElement('span')
  lbl.className = 'rd-serves__label'
  lbl.textContent = 'Serves'

  const stepper = document.createElement('div')
  stepper.className = 'rd-stepper'
  let val = current
  const valEl = document.createElement('span')
  valEl.className = 'rd-stepper__val'
  valEl.textContent = val

  let t = null
  function step(d) {
    val = Math.max(1, Math.min(30, val + d))
    valEl.textContent = val
    clearTimeout(t)
    t = setTimeout(() => saveServes(val), 700)
  }

  const minus = document.createElement('button')
  minus.className = 'rd-stepper__btn'
  minus.textContent = '−'
  minus.addEventListener('click', () => step(-1))
  const plus  = document.createElement('button')
  plus.className  = 'rd-stepper__btn'
  plus.textContent = '+'
  plus.addEventListener('click', () => step(1))

  stepper.append(minus, valEl, plus)
  wrap.append(lbl, stepper)
  return wrap
}

async function saveServes(value) {
  if (activeTabId === 'original') {
    await supabase.from('recipes').update({ serves_base: value }).eq('id', recipe.id)
    recipe.serves_base = value
  } else {
    await supabase.from('recipe_variants').update({ serves: value }).eq('id', activeTabId)
    const v = variants.find(v => v.id === activeTabId)
    if (v) v.serves = value
  }
}

// ── Tabs ──────────────────────────────────────────────────
function buildTabs() {
  const wrap = document.createElement('div')
  wrap.className = 'rd-tabs'
  const defId = recipe.default_variant_id

  function makeTab(id, label) {
    const tab = document.createElement('button')
    tab.className = `rd-tab${id === activeTabId ? ' rd-tab--active' : ''}`
    const star = (id === 'original' && defId == null) || id === defId
    tab.innerHTML = `${label}${star ? '<span class="rd-tab__star">⭐</span>' : ''}`
    tab.addEventListener('click', () => { if (id !== activeTabId) switchTab(id) })
    return tab
  }

  wrap.appendChild(makeTab('original', 'Original'))
  for (const v of variants) wrap.appendChild(makeTab(v.id, v.label))
  return wrap
}

// ── Content ───────────────────────────────────────────────
function buildContent() {
  const wrap       = document.createElement('div')
  const isOriginal = activeTabId === 'original'
  const av         = variants.find(v => v.id === activeTabId) || null
  const layers     = isOriginal ? recipe : av

  wrap.appendChild(buildEase(av))
  wrap.appendChild(buildIngredientsSection())

  // Prepped component overlay notes (above night_before)
  const activePrepped = preppedComponents.filter(p => p.batches_remaining > 0)
  for (const pc of activePrepped) wrap.appendChild(buildPreppedOverlay(pc))

  if (layers?.night_before?.length)  wrap.appendChild(buildLayerList('🌙 Night before',  layers.night_before))
  if (layers?.morning_of?.length)    wrap.appendChild(buildLayerList('☀️ Morning of',    layers.morning_of))
  if (layers?.when_cooking?.length)  wrap.appendChild(buildLayerList('🍳 When cooking',  layers.when_cooking))

  wrap.appendChild(buildHacks(layers?.hacks_and_shortcuts || []))

  if (!isOriginal && av?.notes) wrap.appendChild(buildVariantNotes(av.notes))

  wrap.appendChild(buildPreppedSection())
  wrap.appendChild(buildActions())
  wrap.appendChild(buildAIActions())
  if (scaleResult) wrap.appendChild(buildScaleResult())

  return wrap
}

// ── Ease ──────────────────────────────────────────────────
function buildEase(av) {
  const isOriginal = activeTabId === 'original'
  const current    = isOriginal ? (recipe.ease_descriptor || '') : (av?.ease_descriptor || '')
  const section    = document.createElement('div')
  section.className = 'rd-section rd-ease'
  const lbl = document.createElement('div')
  lbl.className = 'rd-section__title'
  lbl.textContent = 'How easy is this?'
  const row   = document.createElement('div')
  row.className = 'rd-ease-row'
  const input = document.createElement('input')
  input.type  = 'text'
  input.className = 'rd-ease-input'
  input.value = current
  input.placeholder = 'e.g. "weeknight easy" or "Sunday only"'
  const btn = document.createElement('button')
  btn.className = 'btn-outline btn-outline--sm'
  btn.textContent = 'Save'
  btn.disabled = true
  let saved = current
  input.addEventListener('input', () => { btn.disabled = input.value.trim() === saved })
  btn.addEventListener('click', async () => {
    const val = input.value.trim() || null
    let err
    if (isOriginal) {
      ;({ error: err } = await supabase.from('recipes').update({ ease_descriptor: val }).eq('id', recipe.id))
      if (!err) recipe.ease_descriptor = val
    } else {
      ;({ error: err } = await supabase.from('recipe_variants').update({ ease_descriptor: val }).eq('id', activeTabId))
      if (!err) { const v = variants.find(v => v.id === activeTabId); if (v) v.ease_descriptor = val }
    }
    if (err) toast('Save failed', { error: true })
    else { saved = input.value.trim(); btn.disabled = true; toast('Saved') }
  })
  row.append(input, btn)
  section.append(lbl, row)
  return section
}

// ── Ingredients ───────────────────────────────────────────
function buildIngredientsSection() {
  const section = document.createElement('div')
  section.className = 'rd-section'
  const lbl = document.createElement('div')
  lbl.className = 'rd-section__title'
  lbl.textContent = 'Ingredients'
  section.append(lbl, buildIngredientList())
  return section
}

function buildIngredientList() {
  const list = document.createElement('div')
  list.className = 'rd-ing-list'
  ingListRef = list

  if (!ingredients.length) {
    const p = document.createElement('p')
    p.className = 'rd-ing-empty'
    p.textContent = 'No ingredients listed yet.'
    list.appendChild(p)
    return list
  }

  for (const ing of ingredients) {
    const key    = `${activeTabId}:${ing.id}`
    const sub    = subMap[key] || null
    const struck = ing.user_marked_unavailable

    const row = document.createElement('div')
    row.className = `rd-ing-row${struck ? ' rd-ing-row--struck' : ''}`
    const qty = document.createElement('span')
    qty.className  = 'rd-ing-qty'
    qty.textContent = fmtQty(ing.quantity, ing.unit)
    const nm = document.createElement('span')
    nm.className   = 'rd-ing-name'
    nm.textContent = ing.name
    if (ing.notes) {
      const n = document.createElement('span')
      n.className = 'rd-ing-notes'
      n.textContent = ` (${ing.notes})`
      nm.appendChild(n)
    }
    const toggle = document.createElement('button')
    toggle.className = `rd-ing-toggle${struck ? ' rd-ing-toggle--on' : ''}`
    toggle.title = struck ? 'I have this' : "I don't have this"
    toggle.innerHTML = struck ? '✓' : '✕'
    toggle.addEventListener('click', () => toggleUnavailable(ing.id, ing.name))
    row.append(qty, nm, toggle)
    list.appendChild(row)

    if (struck && sub) {
      const noteEl = document.createElement('div')
      noteEl.className = `rd-sub-note${sub.loading ? ' rd-sub-note--loading' : ''}`
      noteEl.textContent = sub.loading ? 'Checking your pantry…' : (sub.message || '')
      list.appendChild(noteEl)
    }
  }
  return list
}

async function toggleUnavailable(ingId, ingName) {
  const ing = ingredients.find(i => i.id === ingId)
  if (!ing) return
  const nowUnavailable = !ing.user_marked_unavailable
  ing.user_marked_unavailable = nowUnavailable
  const table = activeTabId !== 'original' ? 'recipe_variant_ingredients' : 'recipe_ingredients'
  await supabase.from(table).update({ user_marked_unavailable: nowUnavailable }).eq('id', ingId)
  const key = `${activeTabId}:${ingId}`
  if (nowUnavailable) { subMap[key] = { loading: true, message: null } } else { delete subMap[key] }
  refreshIngList()
  if (nowUnavailable) await checkSubstitute(ingId, ingName)
}

async function checkSubstitute(ingId, ingName) {
  try {
    const res  = await fetch(`${FUNCTIONS_URL}/recipe-agent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'check_substitute', ingredient_name: ingName }),
    })
    const data = await res.json()
    const key  = `${activeTabId}:${ingId}`
    if (subMap[key]) subMap[key] = { loading: false, message: data.message }
  } catch {
    const key = `${activeTabId}:${ingId}`
    if (subMap[key]) subMap[key] = { loading: false, message: 'Could not reach server.' }
  }
  refreshIngList()
}

function refreshIngList() {
  if (!ingListRef) return
  const newList = buildIngredientList()
  ingListRef.replaceWith(newList)
}

// ── Layer lists ───────────────────────────────────────────
function buildLayerList(title, steps) {
  const section = document.createElement('div')
  section.className = 'rd-section'
  const lbl = document.createElement('div')
  lbl.className = 'rd-section__title'
  lbl.textContent = title
  const ul = document.createElement('ul')
  ul.className = 'rd-layer-list'
  steps.forEach(s => { const li = document.createElement('li'); li.textContent = s; ul.appendChild(li) })
  section.append(lbl, ul)
  return section
}

function buildVariantNotes(notes) {
  const el = document.createElement('div')
  el.className = 'rd-section rd-variant-notes'
  el.innerHTML = `<span class="rd-section__title">About this version</span><p>${notes}</p>`
  return el
}

// ── Hacks and shortcuts ───────────────────────────────────
function buildHacks(hacks) {
  const section = document.createElement('div')
  section.className = 'rd-section rd-hacks'
  const lbl = document.createElement('div')
  lbl.className = 'rd-section__title'
  lbl.textContent = '💡 Tips for this recipe'

  section.appendChild(lbl)

  if (hacks?.length) {
    const ul = document.createElement('ul')
    ul.className = 'rd-layer-list rd-hacks__list'
    hacks.forEach(h => { const li = document.createElement('li'); li.textContent = h; ul.appendChild(li) })
    section.appendChild(ul)
  }

  if (hacksLoading) {
    const loading = document.createElement('div')
    loading.className = 'rd-hacks__loading'
    loading.innerHTML = '<div class="spinner"></div>Checking for more tips…'
    section.appendChild(loading)
  } else {
    const btn = document.createElement('button')
    btn.className = 'rd-hacks__btn'
    btn.textContent = '💡 Check for more tips'
    btn.addEventListener('click', () => addMoreHacks())
    section.appendChild(btn)
  }
  return section
}

async function addMoreHacks() {
  hacksLoading = true
  const hacksSection = screenEl.querySelector('.rd-hacks')
  const isOriginal   = activeTabId === 'original'
  const av           = variants.find(v => v.id === activeTabId)
  const currentHacks = (isOriginal ? recipe.hacks_and_shortcuts : av?.hacks_and_shortcuts) || []

  if (hacksSection) {
    hacksSection.replaceWith(buildHacks(currentHacks))
  }

  try {
    const res  = await fetch(`${FUNCTIONS_URL}/recipe-agent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'add_more_hacks',
        recipe_name: recipe.name,
        original_instructions: recipe.original_instructions || '',
        ingredients: ingredients.map(i => ({ name: i.name, quantity: i.quantity, unit: i.unit, notes: i.notes })),
        existing_hacks: currentHacks,
      }),
    })
    const data = await res.json()
    const newHacks = data.new_hacks || []

    if (newHacks.length) {
      const merged = [...currentHacks, ...newHacks]
      const table  = isOriginal ? 'recipes' : 'recipe_variants'
      const id     = isOriginal ? recipe.id : activeTabId
      await supabase.from(table).update({ hacks_and_shortcuts: merged }).eq('id', id)
      if (isOriginal) recipe.hacks_and_shortcuts = merged
      else if (av) av.hacks_and_shortcuts = merged
      toast(`${newHacks.length} new tip${newHacks.length > 1 ? 's' : ''} added`)
    } else {
      toast('No new tips found — you've got them all!')
    }
  } catch {
    toast('Could not reach server', { error: true })
  } finally {
    hacksLoading = false
    const av2    = variants.find(v => v.id === activeTabId)
    const hacks  = (activeTabId === 'original' ? recipe.hacks_and_shortcuts : av2?.hacks_and_shortcuts) || []
    const newSec = buildHacks(hacks)
    const oldSec = screenEl.querySelector('.rd-hacks')
    if (oldSec) oldSec.replaceWith(newSec)
  }
}

// ── Prepped components ────────────────────────────────────
function buildPreppedOverlay(pc) {
  const el = document.createElement('div')
  el.className = 'rd-prepped-note'
  el.textContent = `✓ You have "${pc.name}" ready (${pc.batches_remaining} batch${pc.batches_remaining > 1 ? 'es' : ''} left) — you can skip the mixing step below.`
  return el
}

function buildPreppedSection() {
  const section = document.createElement('div')
  section.className = 'rd-section rd-prepped'
  const lbl = document.createElement('div')
  lbl.className = 'rd-section__title'
  lbl.textContent = 'Prepped components'
  section.appendChild(lbl)

  for (const pc of preppedComponents) {
    const item = document.createElement('div')
    item.className = 'rd-prepped__item'
    item.innerHTML = `
      <span class="rd-prepped__name">${pc.name}</span>
      <span class="rd-prepped__meta">${pc.batches_remaining ?? '?'} batch${(pc.batches_remaining ?? 0) !== 1 ? 'es' : ''} left${pc.storage_notes ? ' · ' + pc.storage_notes : ''}</span>`
    section.appendChild(item)
  }

  // Add form (expandable)
  const addItem = document.createElement('div')
  addItem.className = 'rd-ai-item'
  const addBtn = document.createElement('button')
  addBtn.className = 'rd-ai-btn'
  addBtn.textContent = '+ Add prepped component'
  const form = document.createElement('div')
  form.className = 'rd-ai-panel'
  form.hidden = true
  form.innerHTML = `
    <input class="rd-ai-panel__input" id="pc-name" type="text" placeholder="Component name (e.g. Spice mix)">
    <div class="rd-ai-panel__row" style="gap:8px">
      <input class="ar-field__input" id="pc-batches" type="number" min="1" value="1" placeholder="Batches made" style="width:110px;flex:none">
      <input class="ar-field__input" id="pc-date" type="date" style="flex:1">
    </div>
    <input class="rd-ai-panel__input" id="pc-storage" type="text" placeholder="Storage notes (e.g. Keep in sealed jar)">
    <div class="rd-ai-panel__row">
      <button class="rd-ai-panel__submit" id="pc-save">Save</button>
    </div>`

  addBtn.addEventListener('click', () => { form.hidden = !form.hidden })
  form.querySelector('#pc-save').addEventListener('click', () => savePreppedComponent(form))
  addItem.append(addBtn, form)
  section.appendChild(addItem)
  return section
}

async function savePreppedComponent(form) {
  const name     = form.querySelector('#pc-name').value.trim()
  const batches  = parseInt(form.querySelector('#pc-batches').value) || 1
  const date     = form.querySelector('#pc-date').value || null
  const storage  = form.querySelector('#pc-storage').value.trim() || null
  if (!name) { toast('Name is required', { error: true }); return }
  const saveBtn = form.querySelector('#pc-save')
  saveBtn.disabled = true
  saveBtn.textContent = 'Saving…'
  const { data, error } = await supabase.from('prepped_components').insert({
    recipe_id: recipe.id, name, batches_made: batches, batches_remaining: batches,
    made_date: date, storage_notes: storage, active: true,
  }).select().single()
  if (error) { toast('Save failed', { error: true }); saveBtn.disabled = false; saveBtn.textContent = 'Save'; return }
  preppedComponents = [data, ...preppedComponents]
  toast('Saved!')
  // Rebuild just the content to reflect new prepped component
  const contentEl = document.getElementById('rd-content')
  if (contentEl) { const nc = buildContent(); nc.id = 'rd-content'; contentEl.replaceWith(nc) }
}

// ── Actions ───────────────────────────────────────────────
function buildActions() {
  const wrap = document.createElement('div')
  wrap.className = 'rd-actions'
  const row = document.createElement('div')
  row.className = 'rd-actions__row'
  const btnUse   = document.createElement('button')
  btnUse.className   = 'btn-outline'
  btnUse.textContent = 'Use tonight'
  btnUse.addEventListener('click', () => toast('Coming soon — use Chat to change a day'))
  const btnSched = document.createElement('button')
  btnSched.className   = 'btn-outline'
  btnSched.textContent = 'Schedule…'
  btnSched.addEventListener('click', () => toast('Coming soon'))
  row.append(btnUse, btnSched)

  const defId       = recipe.default_variant_id
  const isDefault   = (activeTabId === 'original' && defId == null) || activeTabId === defId
  const btnDef = document.createElement('button')
  btnDef.className   = 'rd-default-btn'
  btnDef.textContent = isDefault ? '⭐ This is the default' : '☆ Make this the default'
  btnDef.disabled    = isDefault
  btnDef.addEventListener('click', makeDefault)

  wrap.append(row, btnDef)
  return wrap
}

async function makeDefault() {
  const newDefault = activeTabId === 'original' ? null : activeTabId
  const { error }  = await supabase.from('recipes').update({ default_variant_id: newDefault }).eq('id', recipe.id)
  if (error) { toast('Save failed', { error: true }); return }
  recipe.default_variant_id = newDefault
  toast(newDefault ? 'Set as default' : 'Reverted to Original')
  const tabsEl    = screenEl.querySelector('.rd-tabs')
  const contentEl = document.getElementById('rd-content')
  if (tabsEl)    tabsEl.replaceWith(buildTabs())
  if (contentEl) { const nc = buildContent(); nc.id = 'rd-content'; contentEl.replaceWith(nc) }
}

// ── AI actions ────────────────────────────────────────────
function buildAIActions() {
  const wrap = document.createElement('div')
  wrap.className = 'rd-ai-actions'
  wrap.appendChild(buildEasierAction())
  wrap.appendChild(buildScaleAction())
  return wrap
}

function buildEasierAction() {
  const container = document.createElement('div')
  container.className = 'rd-ai-item'
  const btn   = document.createElement('button')
  btn.className   = 'rd-ai-btn'
  btn.textContent = '✨ Suggest an easier version'
  const panel = document.createElement('div')
  panel.className = 'rd-ai-panel'
  panel.hidden = true
  panel.innerHTML = `
    <textarea class="rd-ai-panel__input" rows="2"
      placeholder="What's the situation? e.g. didn't prep anything last night"></textarea>
    <div class="rd-ai-panel__row">
      <button class="rd-ai-panel__submit">Generate</button>
    </div>`
  btn.addEventListener('click', () => { panel.hidden = !panel.hidden })
  panel.querySelector('.rd-ai-panel__submit').addEventListener('click', async () => {
    const constraint = panel.querySelector('textarea').value.trim()
    if (!constraint) { panel.querySelector('textarea').focus(); return }
    panel.querySelector('.rd-ai-panel__row').innerHTML =
      `<div class="rd-ai-panel__loading"><div class="spinner"></div>Thinking…</div>`
    await runSuggestEasier(constraint)
  })
  container.append(btn, panel)
  return container
}

function buildScaleAction() {
  const container = document.createElement('div')
  container.className = 'rd-ai-item'
  const btn   = document.createElement('button')
  btn.className   = 'rd-ai-btn'
  btn.textContent = '📏 Scale this recipe'
  const panel = document.createElement('div')
  panel.className = 'rd-ai-panel'
  panel.hidden = true
  panel.innerHTML = `
    <input class="rd-ai-panel__input" type="text" placeholder="e.g. 8 people or double it">
    <div class="rd-ai-panel__row">
      <button class="rd-ai-panel__submit">Calculate</button>
    </div>`
  btn.addEventListener('click', () => { panel.hidden = !panel.hidden })
  panel.querySelector('.rd-ai-panel__submit').addEventListener('click', async () => {
    const target = panel.querySelector('input').value.trim()
    if (!target) { panel.querySelector('input').focus(); return }
    panel.querySelector('.rd-ai-panel__row').innerHTML =
      `<div class="rd-ai-panel__loading"><div class="spinner"></div>Scaling…</div>`
    await runScaleRecipe(target)
  })
  container.append(btn, panel)
  return container
}

// ── Scale result ──────────────────────────────────────────
function buildScaleResult() {
  const r = scaleResult
  const wrap = document.createElement('div')
  wrap.className = 'rd-scale-result'
  const title = document.createElement('div')
  title.className = 'rd-scale-result__title'
  title.textContent = `Scaled for ${r.serves} — ${r.label}`
  const ingsTitle = document.createElement('div')
  ingsTitle.className = 'rd-section__title'
  ingsTitle.textContent = 'Scaled ingredients'
  const ings = document.createElement('ul')
  ings.className = 'rd-scale-ings'
  for (const i of r.ingredients) {
    const li = document.createElement('li')
    li.textContent = `${fmtQty(i.quantity, i.unit)} ${i.name}${i.notes ? ' (' + i.notes + ')' : ''}`
    ings.appendChild(li)
  }
  wrap.append(title, ingsTitle, ings)
  if (r.when_cooking_changes?.length) {
    const ct = document.createElement('div')
    ct.className = 'rd-section__title'
    ct.textContent = 'What changes'
    const ul = document.createElement('ul')
    ul.className = 'rd-layer-list'
    r.when_cooking_changes.forEach(s => { const li = document.createElement('li'); li.textContent = s; ul.appendChild(li) })
    wrap.append(ct, ul)
  }
  if (r.scaling_notes) {
    const note = document.createElement('p')
    note.className = 'rd-scale-result__note'
    note.textContent = r.scaling_notes
    wrap.appendChild(note)
  }
  const saveRow = document.createElement('div')
  saveRow.className = 'rd-scale-save-row'
  const labelInput = document.createElement('input')
  labelInput.type = 'text'
  labelInput.className = 'rd-scale-label-input'
  labelInput.value = scaleLabelDraft || r.label
  labelInput.addEventListener('input', () => { scaleLabelDraft = labelInput.value })
  const saveBtn = document.createElement('button')
  saveBtn.className = 'btn-outline btn-outline--sm'
  saveBtn.textContent = 'Save as variant'
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…'
    await saveScaleAsVariant(labelInput.value.trim() || r.label)
  })
  const discardBtn = document.createElement('button')
  discardBtn.className = 'rd-scale-discard'
  discardBtn.textContent = 'Discard'
  discardBtn.addEventListener('click', () => {
    scaleResult = null; scaleLabelDraft = ''
    const el = screenEl.querySelector('.rd-scale-result')
    if (el) el.remove()
  })
  saveRow.append(labelInput, saveBtn, discardBtn)
  wrap.appendChild(saveRow)
  return wrap
}

// ── AI runners ────────────────────────────────────────────
async function runSuggestEasier(constraint) {
  const isOriginal = activeTabId === 'original'
  const av         = variants.find(v => v.id === activeTabId) || null
  const layers     = isOriginal ? recipe : av
  try {
    const res  = await fetch(`${FUNCTIONS_URL}/recipe-agent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action:         'suggest_easier',
        recipe_name:    recipe.name,
        current_serves: isOriginal ? (recipe.serves_base ?? 4) : (av?.serves ?? recipe.serves_base ?? 4),
        ingredients:    ingredients.map(i => ({ name: i.name, quantity: i.quantity, unit: i.unit, notes: i.notes })),
        instructions:   { night_before: layers?.night_before, morning_of: layers?.morning_of, when_cooking: layers?.when_cooking, hacks_and_shortcuts: layers?.hacks_and_shortcuts },
        constraint,
      }),
    })
    const data = await res.json()
    if (data.error) { toast('AI error — try again', { error: true }); return }

    const { data: newVariant, error } = await supabase.from('recipe_variants')
      .insert({ recipe_id: recipe.id, label: data.label, serves: data.serves,
        night_before: data.night_before || [], morning_of: data.morning_of || [],
        when_cooking: data.when_cooking || [], hacks_and_shortcuts: data.hacks_and_shortcuts || [],
        notes: data.notes, created_by: 'ai' }).select().single()
    if (error || !newVariant) { toast('Save failed', { error: true }); return }

    const changes  = data.ingredient_changes || []
    const removeSet = new Set(changes.filter(c => c.action === 'remove').map(c => c.name?.toLowerCase()))
    const subMap2   = Object.fromEntries(changes.filter(c => c.action === 'substitute').map(c => [c.from?.toLowerCase(), c]))
    const varIngRows = []
    for (const ing of ingredients) {
      const lc = ing.name.toLowerCase()
      if (removeSet.has(lc)) continue
      const s = subMap2[lc]
      varIngRows.push({
        variant_id: newVariant.id,
        name:  s ? s.to : ing.name,
        quantity: s?.quantity ?? ing.quantity, unit: s?.unit ?? ing.unit,
        notes: s?.notes ?? ing.notes, category: ing.category, order_index: ing.order_index,
      })
    }
    if (varIngRows.length) await supabase.from('recipe_variant_ingredients').insert(varIngRows)
    toast('Variant created!')
    variants = [...variants, newVariant]
    await switchTab(newVariant.id)
  } catch (e) {
    console.error(e); toast('Something went wrong', { error: true })
  }
}

async function runScaleRecipe(target) {
  const isOriginal = activeTabId === 'original'
  const av         = variants.find(v => v.id === activeTabId) || null
  try {
    const res  = await fetch(`${FUNCTIONS_URL}/recipe-agent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action:         'scale_recipe',
        recipe_name:    recipe.name,
        current_serves: isOriginal ? (recipe.serves_base ?? 4) : (av?.serves ?? recipe.serves_base ?? 4),
        ingredients:    ingredients.map(i => ({ name: i.name, quantity: i.quantity, unit: i.unit, notes: i.notes })),
        target,
      }),
    })
    const data = await res.json()
    if (data.error) { toast('AI error — try again', { error: true }); return }
    scaleResult = data; scaleLabelDraft = data.label || ''
    const contentEl = document.getElementById('rd-content')
    if (contentEl) { const nc = buildContent(); nc.id = 'rd-content'; contentEl.replaceWith(nc) }
    requestAnimationFrame(() => {
      screenEl.querySelector('.rd-scale-result')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  } catch (e) {
    console.error(e); toast('Something went wrong', { error: true })
  }
}

async function saveScaleAsVariant(label) {
  const r          = scaleResult
  const isOriginal = activeTabId === 'original'
  const av         = variants.find(v => v.id === activeTabId) || null
  const layers     = isOriginal ? recipe : av
  const baseWC     = layers?.when_cooking || []
  const withChanges = r.when_cooking_changes?.length
    ? [...baseWC, '─── Scaling notes ───', ...r.when_cooking_changes] : baseWC
  const { data: nv, error } = await supabase.from('recipe_variants')
    .insert({ recipe_id: recipe.id, label, serves: r.serves, night_before: layers?.night_before || [],
      morning_of: layers?.morning_of || [], when_cooking: withChanges,
      notes: r.scaling_notes, created_by: 'ai' }).select().single()
  if (error || !nv) { toast('Save failed', { error: true }); return }
  const varIngRows = r.ingredients.map((i, idx) => ({
    variant_id: nv.id, name: i.name, quantity: i.quantity ?? null,
    unit: i.unit ?? null, notes: i.notes ?? null, order_index: idx,
  }))
  if (varIngRows.length) await supabase.from('recipe_variant_ingredients').insert(varIngRows)
  toast('Variant saved!')
  scaleResult = null; scaleLabelDraft = ''
  variants = [...variants, nv]
  await switchTab(nv.id)
}

// ── Helpers ───────────────────────────────────────────────
function defaultEmoji(mealType) {
  return { breakfast: '🍳', lunch_dinner: '🍽️', snack: '🍎', special: '🎉' }[mealType] || '🍽️'
}

function fmtQty(quantity, unit) {
  if (quantity == null) return ''
  const q = Number(quantity)
  const s = Number.isInteger(q) ? String(q) : q.toFixed(1).replace(/\.0$/, '')
  return unit ? `${s} ${unit}` : s
}

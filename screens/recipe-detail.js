import { supabase, FUNCTIONS_URL, navigateTo, navState, toast } from '../app.js'

// ── State ─────────────────────────────────────────────────
let recipe      = null   // base recipe row
let variants    = []     // recipe_variants[]
let activeTabId = 'original'
let ingredients = []     // current tab's ingredients (with user_marked_unavailable)
let subMap      = {}     // `${tabId}:${ingId}` → { loading, message }
let scaleResult = null   // { serves, label, ingredients, when_cooking_changes, scaling_notes }
let scaleLabelDraft = ''
let lastRecipeId = null
let screenEl    = null
let ingListRef  = null   // live ref to .rd-ing-list div for in-place updates

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
    lastRecipeId  = recipeId
    activeTabId   = 'original'
    subMap        = {}
    scaleResult   = null
    scaleLabelDraft = ''
    await loadAll(recipeId)
  }

  renderAll()
}

// ── Data ──────────────────────────────────────────────────
async function loadAll(recipeId) {
  const [recipeRes, variantsRes] = await Promise.all([
    supabase.from('recipes')
      .select('id, name, emoji, meal_type, ease_descriptor, serves_base, default_variant_id, night_before, morning_of, when_cooking, the_scary_bit, protein, cooking_method')
      .eq('id', recipeId).single(),
    supabase.from('recipe_variants')
      .select('*')
      .eq('recipe_id', recipeId)
      .order('created_at'),
  ])

  if (recipeRes.error || !recipeRes.data) {
    screenEl.innerHTML = `<div class="placeholder-wrap"><p class="placeholder-label">Recipe not found</p></div>`
    return
  }

  recipe   = recipeRes.data
  variants = variantsRes.data || []

  const titleEl = document.getElementById('screen-title')
  if (titleEl) titleEl.textContent = recipe.name

  await loadIngredients()
}

async function loadIngredients() {
  if (activeTabId === 'original') {
    const { data } = await supabase
      .from('recipe_ingredients')
      .select('id, name, quantity, unit, notes, order_index, user_marked_unavailable')
      .eq('recipe_id', recipe.id)
      .order('order_index')
    ingredients = data || []
  } else {
    const { data } = await supabase
      .from('recipe_variant_ingredients')
      .select('id, name, quantity, unit, notes, order_index, user_marked_unavailable')
      .eq('variant_id', activeTabId)
      .order('order_index')
    ingredients = data || []
  }
}

// ── Top-level render ──────────────────────────────────────
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
  ingListRef      = null

  await loadIngredients()

  const servesEl  = screenEl.querySelector('.rd-serves')
  const tabsEl    = screenEl.querySelector('.rd-tabs')
  const contentEl = document.getElementById('rd-content')

  if (servesEl)  servesEl.replaceWith(buildServes())
  if (tabsEl)    tabsEl.replaceWith(buildTabs())
  if (contentEl) {
    const nc = buildContent()
    nc.id = 'rd-content'
    contentEl.replaceWith(nc)
  }
}

// ── Info / serves ─────────────────────────────────────────
function buildInfo() {
  const wrap = document.createElement('div')
  wrap.className = 'rd-info'
  const emojiEl = document.createElement('div')
  emojiEl.className = 'rd-info__emoji'
  emojiEl.textContent = recipe.emoji || defaultEmoji(recipe.meal_type)
  wrap.append(emojiEl, buildServes())
  return wrap
}

function buildServes() {
  const activeVariant = variants.find(v => v.id === activeTabId)
  const currentServes = (activeTabId !== 'original' && activeVariant?.serves != null)
    ? activeVariant.serves
    : (recipe.serves_base ?? 4)

  const wrap = document.createElement('div')
  wrap.className = 'rd-serves'

  const label = document.createElement('span')
  label.className = 'rd-serves__label'
  label.textContent = 'Serves'

  const stepper = document.createElement('div')
  stepper.className = 'rd-stepper'

  let val = currentServes
  const valEl = document.createElement('span')
  valEl.className = 'rd-stepper__val'
  valEl.textContent = val

  let saveTimer = null
  function step(delta) {
    val = Math.max(1, Math.min(30, val + delta))
    valEl.textContent = val
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => saveServes(val), 700)
  }

  const minus = document.createElement('button')
  minus.className = 'rd-stepper__btn'
  minus.textContent = '−'
  minus.addEventListener('click', () => step(-1))

  const plus = document.createElement('button')
  plus.className = 'rd-stepper__btn'
  plus.textContent = '+'
  plus.addEventListener('click', () => step(1))

  stepper.append(minus, valEl, plus)
  wrap.append(label, stepper)
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

  const defaultId = recipe.default_variant_id

  function makeTab(id, label) {
    const tab = document.createElement('button')
    tab.className = `rd-tab${id === activeTabId ? ' rd-tab--active' : ''}`
    const isStar = (id === 'original' && defaultId == null) || (id === defaultId)
    tab.innerHTML = `${label}${isStar ? '<span class="rd-tab__star">⭐</span>' : ''}`
    tab.addEventListener('click', () => { if (id !== activeTabId) switchTab(id) })
    return tab
  }

  wrap.appendChild(makeTab('original', 'Original'))
  for (const v of variants) wrap.appendChild(makeTab(v.id, v.label))
  return wrap
}

// ── Content ───────────────────────────────────────────────
function buildContent() {
  const wrap = document.createElement('div')
  const isOriginal     = activeTabId === 'original'
  const activeVariant  = variants.find(v => v.id === activeTabId) || null
  const layers         = isOriginal ? recipe : activeVariant

  wrap.appendChild(buildEase(activeVariant))
  wrap.appendChild(buildIngredientsSection())
  if (layers?.night_before?.length)  wrap.appendChild(buildLayerList('🌙 Night before', layers.night_before))
  if (layers?.morning_of?.length)    wrap.appendChild(buildLayerList('☀️ Morning of', layers.morning_of))
  if (layers?.when_cooking?.length)  wrap.appendChild(buildLayerList('🍳 When cooking', layers.when_cooking))
  if (layers?.the_scary_bit)         wrap.appendChild(buildScary(layers.the_scary_bit))
  if (!isOriginal && activeVariant?.notes) wrap.appendChild(buildVariantNotes(activeVariant.notes))

  wrap.appendChild(buildActions())
  wrap.appendChild(buildAIActions())
  if (scaleResult)                   wrap.appendChild(buildScaleResult())

  return wrap
}

// ── Ease descriptor ───────────────────────────────────────
function buildEase(activeVariant) {
  const isOriginal = activeTabId === 'original'
  const current    = isOriginal ? (recipe.ease_descriptor || '') : (activeVariant?.ease_descriptor || '')

  const section = document.createElement('div')
  section.className = 'rd-section rd-ease'

  const lbl = document.createElement('div')
  lbl.className = 'rd-section__title'
  lbl.textContent = 'How easy is this?'

  const row = document.createElement('div')
  row.className = 'rd-ease-row'

  const input = document.createElement('input')
  input.type = 'text'
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
    if (err) { toast('Save failed', { error: true }) } else { saved = input.value.trim(); btn.disabled = true; toast('Saved') }
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

  const list = buildIngredientList()
  section.append(lbl, list)
  return section
}

function buildIngredientList() {
  const list = document.createElement('div')
  list.className = 'rd-ing-list'
  ingListRef = list

  if (!ingredients.length) {
    const empty = document.createElement('p')
    empty.className = 'rd-ing-empty'
    empty.textContent = 'No ingredients listed yet.'
    list.appendChild(empty)
    return list
  }

  for (const ing of ingredients) {
    const key   = `${activeTabId}:${ing.id}`
    const sub   = subMap[key] || null
    const struck = ing.user_marked_unavailable

    const row = document.createElement('div')
    row.className = `rd-ing-row${struck ? ' rd-ing-row--struck' : ''}`

    const qty = document.createElement('span')
    qty.className = 'rd-ing-qty'
    qty.textContent = fmtQty(ing.quantity, ing.unit)

    const name = document.createElement('span')
    name.className = 'rd-ing-name'
    name.textContent = ing.name

    if (ing.notes) {
      const notes = document.createElement('span')
      notes.className = 'rd-ing-notes'
      notes.textContent = ` (${ing.notes})`
      name.appendChild(notes)
    }

    const toggle = document.createElement('button')
    toggle.className = `rd-ing-toggle${struck ? ' rd-ing-toggle--on' : ''}`
    toggle.title = struck ? 'I have this' : "I don't have this"
    toggle.innerHTML = struck ? '✓' : '✕'
    toggle.addEventListener('click', () => toggleUnavailable(ing.id, ing.name))

    row.append(qty, name, toggle)
    list.appendChild(row)

    // Substitute note
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
  const ing  = ingredients.find(i => i.id === ingId)
  if (!ing) return

  const nowUnavailable = !ing.user_marked_unavailable
  ing.user_marked_unavailable = nowUnavailable

  const isVariant = activeTabId !== 'original'
  const table     = isVariant ? 'recipe_variant_ingredients' : 'recipe_ingredients'
  await supabase.from(table).update({ user_marked_unavailable: nowUnavailable }).eq('id', ingId)

  const key = `${activeTabId}:${ingId}`
  if (nowUnavailable) {
    subMap[key] = { loading: true, message: null }
  } else {
    delete subMap[key]
  }

  refreshIngList()

  if (nowUnavailable) {
    await checkSubstitute(ingId, ingName)
  }
}

async function checkSubstitute(ingId, ingName) {
  try {
    const res  = await fetch(`${FUNCTIONS_URL}/recipe-agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

// ── Instruction layers ────────────────────────────────────
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

function buildScary(text) {
  const el = document.createElement('div')
  el.className = 'rd-section rd-scary'
  el.innerHTML = `<span class="rd-scary__label">⚠️ The scary bit</span><p>${text}</p>`
  return el
}

function buildVariantNotes(notes) {
  const el = document.createElement('div')
  el.className = 'rd-section rd-variant-notes'
  el.innerHTML = `<span class="rd-section__title">About this version</span><p>${notes}</p>`
  return el
}

// ── Actions ───────────────────────────────────────────────
function buildActions() {
  const wrap = document.createElement('div')
  wrap.className = 'rd-actions'

  const row1 = document.createElement('div')
  row1.className = 'rd-actions__row'

  const btnUse = document.createElement('button')
  btnUse.className = 'btn-outline'
  btnUse.textContent = 'Use tonight'
  btnUse.addEventListener('click', () => toast('Coming soon — use Chat to change a day'))

  const btnSched = document.createElement('button')
  btnSched.className = 'btn-outline'
  btnSched.textContent = 'Schedule…'
  btnSched.addEventListener('click', () => toast('Coming soon'))

  row1.append(btnUse, btnSched)

  const btnDefault = document.createElement('button')
  btnDefault.className = 'rd-default-btn'
  const defaultId = recipe.default_variant_id
  const isAlreadyDefault =
    (activeTabId === 'original' && defaultId == null) ||
    (activeTabId !== 'original' && activeTabId === defaultId)
  btnDefault.textContent = isAlreadyDefault ? '⭐ This is the default' : '☆ Make this the default'
  btnDefault.disabled = isAlreadyDefault
  btnDefault.addEventListener('click', makeDefault)

  wrap.append(row1, btnDefault)
  return wrap
}

async function makeDefault() {
  const newDefault = activeTabId === 'original' ? null : activeTabId
  const { error } = await supabase
    .from('recipes').update({ default_variant_id: newDefault }).eq('id', recipe.id)
  if (error) { toast('Save failed', { error: true }); return }
  recipe.default_variant_id = newDefault
  toast(newDefault ? 'Set as default' : 'Reverted to Original')

  // Re-render tabs + actions in place
  const tabsEl   = screenEl.querySelector('.rd-tabs')
  const contentEl = document.getElementById('rd-content')
  if (tabsEl) tabsEl.replaceWith(buildTabs())
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

  const btn = document.createElement('button')
  btn.className = 'rd-ai-btn'
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

  const submitBtn = panel.querySelector('.rd-ai-panel__submit')
  const textarea  = panel.querySelector('textarea')
  submitBtn.addEventListener('click', async () => {
    const constraint = textarea.value.trim()
    if (!constraint) { textarea.focus(); return }
    submitBtn.disabled = true
    submitBtn.textContent = 'Generating…'
    panel.querySelector('.rd-ai-panel__row').innerHTML = `<div class="rd-ai-panel__loading"><div class="spinner"></div>Thinking…</div>`
    await runSuggestEasier(constraint)
  })

  container.append(btn, panel)
  return container
}

function buildScaleAction() {
  const container = document.createElement('div')
  container.className = 'rd-ai-item'

  const btn = document.createElement('button')
  btn.className = 'rd-ai-btn'
  btn.textContent = '📏 Scale this recipe'

  const panel = document.createElement('div')
  panel.className = 'rd-ai-panel'
  panel.hidden = true
  panel.innerHTML = `
    <input class="rd-ai-panel__input" type="text"
      placeholder="e.g. 8 people or double it">
    <div class="rd-ai-panel__row">
      <button class="rd-ai-panel__submit">Calculate</button>
    </div>`

  btn.addEventListener('click', () => { panel.hidden = !panel.hidden })

  panel.querySelector('.rd-ai-panel__submit').addEventListener('click', async () => {
    const target = panel.querySelector('input').value.trim()
    if (!target) { panel.querySelector('input').focus(); return }
    panel.querySelector('.rd-ai-panel__submit').disabled = true
    panel.querySelector('.rd-ai-panel__row').innerHTML = `<div class="rd-ai-panel__loading"><div class="spinner"></div>Scaling…</div>`
    await runScaleRecipe(target)
  })

  container.append(btn, panel)
  return container
}

// ── Scale result ──────────────────────────────────────────
function buildScaleResult() {
  const r   = scaleResult
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
    const changeTitle = document.createElement('div')
    changeTitle.className = 'rd-section__title'
    changeTitle.textContent = 'What changes'
    const ul = document.createElement('ul')
    ul.className = 'rd-layer-list'
    r.when_cooking_changes.forEach(s => { const li = document.createElement('li'); li.textContent = s; ul.appendChild(li) })
    wrap.append(changeTitle, ul)
  }

  if (r.scaling_notes) {
    const note = document.createElement('p')
    note.className = 'rd-scale-result__note'
    note.textContent = r.scaling_notes
    wrap.appendChild(note)
  }

  // Save as variant row
  const saveRow = document.createElement('div')
  saveRow.className = 'rd-scale-save-row'

  const labelInput = document.createElement('input')
  labelInput.type = 'text'
  labelInput.className = 'rd-scale-label-input'
  labelInput.value = scaleLabelDraft || r.label
  labelInput.placeholder = 'Variant name'
  labelInput.addEventListener('input', () => { scaleLabelDraft = labelInput.value })

  const saveBtn = document.createElement('button')
  saveBtn.className = 'btn-outline btn-outline--sm'
  saveBtn.textContent = 'Save as variant'
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true
    saveBtn.textContent = 'Saving…'
    await saveScaleAsVariant(labelInput.value.trim() || r.label)
  })

  const discardBtn = document.createElement('button')
  discardBtn.className = 'rd-scale-discard'
  discardBtn.textContent = 'Discard'
  discardBtn.addEventListener('click', () => {
    scaleResult = null
    scaleLabelDraft = ''
    const el = screenEl.querySelector('.rd-scale-result')
    if (el) el.remove()
  })

  saveRow.append(labelInput, saveBtn, discardBtn)
  wrap.appendChild(saveRow)
  return wrap
}

// ── AI action runners ─────────────────────────────────────
async function runSuggestEasier(constraint) {
  const isOriginal    = activeTabId === 'original'
  const activeVariant = variants.find(v => v.id === activeTabId) || null
  const layers        = isOriginal ? recipe : activeVariant

  try {
    const res  = await fetch(`${FUNCTIONS_URL}/recipe-agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action:         'suggest_easier',
        recipe_name:    recipe.name,
        current_serves: isOriginal ? (recipe.serves_base ?? 4) : (activeVariant?.serves ?? recipe.serves_base ?? 4),
        ingredients:    ingredients.map(i => ({ name: i.name, quantity: i.quantity, unit: i.unit, notes: i.notes })),
        instructions:   {
          night_before: layers?.night_before || [],
          morning_of:   layers?.morning_of   || [],
          when_cooking: layers?.when_cooking  || [],
          the_scary_bit: layers?.the_scary_bit || null,
        },
        constraint,
      }),
    })

    const data = await res.json()
    if (data.error) { toast('AI error — try again', { error: true }); return }

    // 1. Insert variant row
    const { data: newVariant, error: vErr } = await supabase
      .from('recipe_variants')
      .insert({
        recipe_id:     recipe.id,
        label:         data.label,
        serves:        data.serves,
        night_before:  data.night_before  || [],
        morning_of:    data.morning_of    || [],
        when_cooking:  data.when_cooking   || [],
        the_scary_bit: data.the_scary_bit  || null,
        notes:         data.notes          || null,
        created_by:    'ai',
      })
      .select().single()

    if (vErr || !newVariant) { toast('Save failed', { error: true }); return }

    // 2. Copy current ingredients then apply changes
    const changes    = data.ingredient_changes || []
    const removeSet  = new Set(changes.filter(c => c.action === 'remove').map(c => c.name?.toLowerCase()))
    const subMap2    = {}
    for (const c of changes.filter(c => c.action === 'substitute')) {
      subMap2[c.from?.toLowerCase()] = c
    }

    const variantIngs = []
    for (const ing of ingredients) {
      const nameLc = ing.name.toLowerCase()
      if (removeSet.has(nameLc)) continue
      if (subMap2[nameLc]) {
        const s = subMap2[nameLc]
        variantIngs.push({
          variant_id: newVariant.id,
          name:       s.to,
          quantity:   s.quantity ?? ing.quantity,
          unit:       s.unit     ?? ing.unit,
          notes:      s.notes    ?? ing.notes,
          category:   ing.category,
          order_index: ing.order_index,
        })
      } else {
        variantIngs.push({
          variant_id:  newVariant.id,
          name:        ing.name,
          quantity:    ing.quantity,
          unit:        ing.unit,
          notes:       ing.notes,
          category:    ing.category,
          order_index: ing.order_index,
        })
      }
    }

    if (variantIngs.length) {
      await supabase.from('recipe_variant_ingredients').insert(variantIngs)
    }

    // 3. Reload and switch to new variant
    toast('Variant created!')
    variants = [...variants, newVariant]
    await switchTab(newVariant.id)

  } catch (e) {
    console.error(e)
    toast('Something went wrong', { error: true })
  }
}

async function runScaleRecipe(target) {
  const isOriginal    = activeTabId === 'original'
  const activeVariant = variants.find(v => v.id === activeTabId) || null

  try {
    const res  = await fetch(`${FUNCTIONS_URL}/recipe-agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action:         'scale_recipe',
        recipe_name:    recipe.name,
        current_serves: isOriginal ? (recipe.serves_base ?? 4) : (activeVariant?.serves ?? recipe.serves_base ?? 4),
        ingredients:    ingredients.map(i => ({ name: i.name, quantity: i.quantity, unit: i.unit, notes: i.notes })),
        target,
      }),
    })

    const data = await res.json()
    if (data.error) { toast('AI error — try again', { error: true }); return }

    scaleResult     = data
    scaleLabelDraft = data.label || ''

    // Rebuild content to show scale result (+ close AI panels)
    const contentEl = document.getElementById('rd-content')
    if (contentEl) { const nc = buildContent(); nc.id = 'rd-content'; contentEl.replaceWith(nc) }
    // Scroll to scale result
    requestAnimationFrame(() => {
      const el = screenEl.querySelector('.rd-scale-result')
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })

  } catch (e) {
    console.error(e)
    toast('Something went wrong', { error: true })
  }
}

async function saveScaleAsVariant(label) {
  const r           = scaleResult
  const isOriginal  = activeTabId === 'original'
  const activeVariant = variants.find(v => v.id === activeTabId) || null
  const layers      = isOriginal ? recipe : activeVariant

  // Build when_cooking: original steps + scaling changes
  const baseWhenCooking = layers?.when_cooking || []
  const withChanges     = r.when_cooking_changes?.length
    ? [...baseWhenCooking, '─── Scaling notes ───', ...r.when_cooking_changes]
    : baseWhenCooking

  const { data: newVariant, error: vErr } = await supabase
    .from('recipe_variants')
    .insert({
      recipe_id:     recipe.id,
      label,
      serves:        r.serves,
      night_before:  layers?.night_before || [],
      morning_of:    layers?.morning_of   || [],
      when_cooking:  withChanges,
      the_scary_bit: layers?.the_scary_bit || null,
      notes:         r.scaling_notes || null,
      created_by:    'ai',
    })
    .select().single()

  if (vErr || !newVariant) { toast('Save failed', { error: true }); return }

  const variantIngs = r.ingredients.map((i, idx) => ({
    variant_id:  newVariant.id,
    name:        i.name,
    quantity:    i.quantity ?? null,
    unit:        i.unit     ?? null,
    notes:       i.notes    ?? null,
    order_index: idx,
  }))
  if (variantIngs.length) await supabase.from('recipe_variant_ingredients').insert(variantIngs)

  toast('Variant saved!')
  scaleResult = null
  scaleLabelDraft = ''
  variants = [...variants, newVariant]
  await switchTab(newVariant.id)
}

// ── Helpers ───────────────────────────────────────────────
function defaultEmoji(mealType) {
  return { breakfast: '🍳', lunch_dinner: '🍽️', snack: '🍎', special: '🎉' }[mealType] || '🍽️'
}

function fmtQty(quantity, unit) {
  if (quantity == null) return ''
  const q = Number(quantity)
  const qStr = Number.isInteger(q) ? q : q.toFixed(1).replace(/\.0$/, '')
  return unit ? `${qStr} ${unit}` : `${qStr}`
}

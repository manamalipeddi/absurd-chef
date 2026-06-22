import { supabase, FUNCTIONS_URL, navigateTo, navState, toast } from '../app.js'
import { convBracket, convertText } from './convert.js'

// ── State ─────────────────────────────────────────────────
let recipe           = null
let variants         = []
let activeTabId      = 'original'
let ingredients      = []
let masterConv       = {}   // master_ingredient_id → { unit_type, grams_per_cup, ... }
let preppedComponents = []
let subMap           = {}   // `${tabId}:${ingId}` → {loading, message}
let scaleResult      = null
let scaleLabelDraft  = ''
let notesLoading     = false
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
  // Context-aware back: return to wherever we came from (Plan or Recipes).
  document.getElementById('btn-back').addEventListener('click', () => history.back())

  const recipeId = navState.recipeId
  if (!recipeId) return

  screenEl.innerHTML = `<div class="loading-row"><div class="spinner"></div>Loading…</div>`

  if (recipeId !== lastRecipeId) {
    lastRecipeId    = recipeId
    activeTabId     = 'original'
    subMap          = {}
    scaleResult     = null
    scaleLabelDraft = ''
    notesLoading    = false
    await loadAll(recipeId)
  }

  // Always (re)apply the header title — loadAll only sets it on a fresh load,
  // but re-entering this screen must restore it too.
  if (recipe) {
    const titleEl = document.getElementById('screen-title')
    if (titleEl) titleEl.textContent = recipe.name
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
    if (recipe) {
      // Invalidate the cache so returning from the edit form reloads the recipe
      // (restores the header title and shows the just-saved changes).
      lastRecipeId = null
      navState.editRecipeId = recipe.id
      navigateTo('add-recipe')
    }
  })
}

// ── Data ──────────────────────────────────────────────────
async function loadAll(recipeId) {
  const [recipeRes, variantsRes, pcRes] = await Promise.all([
    supabase.from('recipes')
      .select('id,name,emoji,meal_type,ease_descriptor,serves_base,default_variant_id,night_before,morning_of,when_cooking,notes,original_instructions,protein,cooking_method,can_double')
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
        .select('id,name,quantity,unit,notes,order_index,user_marked_unavailable,master_ingredient_id')
        .eq('variant_id', activeTabId).order('order_index')
    : await supabase.from('recipe_ingredients')
        .select('id,name,quantity,unit,notes,order_index,user_marked_unavailable,master_ingredient_id')
        .eq('recipe_id', recipe.id).order('order_index')
  ingredients = data || []

  // Load conversion data for the linked master ingredients (computed centrally).
  const ids = [...new Set(ingredients.map(i => i.master_ingredient_id).filter(Boolean))]
  masterConv = {}
  if (ids.length) {
    const { data: mi } = await supabase.from('master_ingredients')
      .select('id, unit_type, grams_per_cup, conversion_is_approximate').in('id', ids)
    for (const m of mi || []) masterConv[m.id] = m
  }
}

// ── Render ────────────────────────────────────────────────
function renderAll() {
  if (!screenEl || !recipe) return
  screenEl.innerHTML = ''
  ingListRef = null

  const root = document.createElement('div')
  root.className = 'rd'
  root.appendChild(buildInfo())
  const content = buildContent()
  content.id = 'rd-content'
  root.appendChild(content)
  screenEl.appendChild(root)
}

async function switchTab(tabId) {
  activeTabId     = tabId
  scaleResult     = null
  scaleLabelDraft = ''
  notesLoading    = false
  ingListRef      = null
  await loadIngredients()
  const pillsEl   = screenEl.querySelector('.rd-pills')
  const contentEl = document.getElementById('rd-content')
  if (pillsEl)   pillsEl.replaceWith(buildPills())
  if (contentEl) { const nc = buildContent(); nc.id = 'rd-content'; contentEl.replaceWith(nc) }
}

// ── Header: emoji + version pills (merged serves + tab switcher) ──────────
function buildInfo() {
  const wrap  = document.createElement('div')
  wrap.className = 'rd-info'
  const emoji = document.createElement('div')
  emoji.className = 'rd-info__emoji'
  emoji.textContent = recipe.emoji || defaultEmoji(recipe.meal_type)
  wrap.append(emoji, buildPills())
  return wrap
}

// One pill per version. Original = "Serves [X]"; variants = their label.
// Tapping switches version; the default version carries a ⭐ badge, and the
// active non-default pill shows a ☆ that makes it the default.
function buildPills() {
  const wrap = document.createElement('div')
  wrap.className = 'rd-pills'
  const defId = recipe.default_variant_id

  function makePill(id, label) {
    const isActive  = id === activeTabId
    const isDefault = (id === 'original' && defId == null) || id === defId
    const pill = document.createElement('button')
    pill.className = 'rd-pill' + (isActive ? ' rd-pill--active' : '') + (isDefault ? ' rd-pill--default' : '')
    const lbl = document.createElement('span')
    lbl.className = 'rd-pill__label'
    lbl.textContent = label
    pill.appendChild(lbl)
    if (isDefault) {
      const star = document.createElement('span')
      star.className = 'rd-pill__star'; star.textContent = '⭐'; star.title = 'Default version'
      pill.appendChild(star)
    } else if (isActive) {
      const star = document.createElement('button')
      star.type = 'button'; star.className = 'rd-pill__setdefault'; star.textContent = '☆'
      star.title = 'Make this the default'
      star.addEventListener('click', e => { e.stopPropagation(); makeDefault() })
      pill.appendChild(star)
    }
    pill.addEventListener('click', () => { if (id !== activeTabId) switchTab(id) })
    return pill
  }

  wrap.appendChild(makePill('original', `Serves ${recipe.serves_base ?? 4}`))
  for (const v of variants) wrap.appendChild(makePill(v.id, v.label))

  // Discuss this recipe — right-aligned chat-bubble icon (same glyph as the
  // Plan day-card). Opens chat pre-filled; not a saved variant.
  const discuss = document.createElement('button')
  discuss.className = 'rd-pills__discuss'
  discuss.title = 'Discuss this recipe'
  discuss.setAttribute('aria-label', 'Discuss this recipe')
  discuss.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8.96 8.96 0 0 1-9 9c-1.6 0-3.1-.42-4.4-1.15L3 21l1.15-4.6A8.96 8.96 0 0 1 3 12a9 9 0 1 1 18 0z"/><path d="M8 10h8M8 13.5h5"/></svg>'
  discuss.addEventListener('click', () => { navState.chatPrefill = `About ${recipe.name}: `; navigateTo('chat') })
  wrap.appendChild(discuss)
  return wrap
}

// ── Content ───────────────────────────────────────────────
// Section order answers the questions a cook actually asks, top to bottom:
// ease → ingredients+when-cooking → night before → morning of → tips →
// what do I want to do (actions) → easier path (AI) → prepped → reference.
function buildContent() {
  const wrap       = document.createElement('div')
  const isOriginal = activeTabId === 'original'
  const av         = variants.find(v => v.id === activeTabId) || null
  const layers     = isOriginal ? recipe : av

  // 3. Ease descriptor (plain-text read mode; tap to edit)
  wrap.appendChild(buildEase(av))

  // 4. Ingredients, paired directly with When Cooking
  wrap.appendChild(buildIngredientsSection())
  const activePrepped = preppedComponents.filter(p => p.batches_remaining > 0)
  for (const pc of activePrepped) wrap.appendChild(buildPreppedOverlay(pc))
  if (layers?.when_cooking?.length)  wrap.appendChild(buildLayerList('🍳 When cooking',  layers.when_cooking))

  // 5 / 6. Night before, Morning of
  if (layers?.night_before?.length)  wrap.appendChild(buildLayerList('🌙 Night before',  layers.night_before))
  if (layers?.morning_of?.length)    wrap.appendChild(buildLayerList('☀️ Morning of',    layers.morning_of))

  // 7. About this version — variant tabs only (Original has no version to explain)
  if (!isOriginal && av?.notes) wrap.appendChild(buildVariantNotes(av.notes))

  // 8. Notes — global, identical on every tab (recipes.notes); user-editable
  wrap.appendChild(buildNotes())

  // 9. Scale this recipe (reworked: outline send-icon, no Calculate button)
  wrap.appendChild(buildScaleSection())
  if (scaleResult) wrap.appendChild(buildScaleResult())

  // 10. Prepped components (collapsed)
  wrap.appendChild(buildPreppedSection())

  // 11. Original instructions — collapsed, very end (Original tab only).
  if (isOriginal && recipe.original_instructions?.trim())
    wrap.appendChild(buildOriginalInstructions(recipe.original_instructions))

  return wrap
}

// ── Ease ──────────────────────────────────────────────────
// Read mode: a confident, tagline-style line under the header (no field chrome).
// Tap the text or the pencil to edit; saving / tapping away reverts to read mode.
// Each tab carries its own ease_descriptor independently.
function buildEase(av) {
  const isOriginal = activeTabId === 'original'
  const getCurrent = () => isOriginal ? (recipe.ease_descriptor || '') : (av?.ease_descriptor || '')

  const section = document.createElement('div')
  section.className = 'rd-ease'

  // Book-blurb style headline over the ease descriptor (same style as the
  // Ingredients heading).
  function easeHeading() {
    const h = document.createElement('div')
    h.className = 'rd-section__title'
    h.textContent = "Manasa's Absurd Notes"
    return h
  }

  function renderRead() {
    section.innerHTML = ''
    section.appendChild(easeHeading())
    const cur = getCurrent()
    const read = document.createElement('div')
    read.className = 'rd-ease-read'
    const text = document.createElement('span')
    text.className = 'rd-ease-text' + (cur ? '' : ' rd-ease-text--empty')
    // Friendly pep-talk placeholder when empty (styled identically to a real note).
    text.textContent = cur || "No notes yet — but you've got this 💪"
    const pencil = document.createElement('button')
    pencil.className = 'rd-ease-pencil'
    pencil.setAttribute('aria-label', 'Edit ease note')
    pencil.textContent = '✎'
    read.append(text, pencil)
    // Only the pencil enters edit mode (no tap-to-edit on the text itself).
    pencil.addEventListener('click', renderEdit)
    section.appendChild(read)
  }

  function renderEdit() {
    section.innerHTML = ''
    section.appendChild(easeHeading())
    const row = document.createElement('div')
    row.className = 'rd-ease-row'
    const input = document.createElement('input')
    input.type = 'text'; input.className = 'rd-ease-input'
    input.value = getCurrent()
    input.placeholder = 'e.g. "weeknight easy" or "Sunday only"'
    const save = document.createElement('button')
    save.className = 'btn-outline btn-outline--sm'
    save.textContent = 'Save'

    let done = false
    const commit = async () => {
      if (done) return; done = true
      const val = input.value.trim() || null
      let err
      if (isOriginal) {
        ;({ error: err } = await supabase.from('recipes').update({ ease_descriptor: val }).eq('id', recipe.id))
        if (!err) recipe.ease_descriptor = val
      } else {
        ;({ error: err } = await supabase.from('recipe_variants').update({ ease_descriptor: val }).eq('id', activeTabId))
        if (!err) { const v = variants.find(v => v.id === activeTabId); if (v) v.ease_descriptor = val }
      }
      if (err) { toast('Save failed', { error: true }); done = false; return }
      renderRead()
    }
    save.addEventListener('mousedown', e => e.preventDefault())  // keep focus → blur fires once
    save.addEventListener('click', () => input.blur())
    input.addEventListener('blur', commit)
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur() } })

    row.append(input, save)
    section.appendChild(row)
    input.focus()
  }

  renderRead()
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
    // Metric conversion (computed from the linked master ingredient), additive.
    const conv = convBracket(ing.quantity, ing.unit, masterConv[ing.master_ingredient_id])
    if (conv) {
      const cs = document.createElement('span')
      cs.className = 'rd-ing-conv'
      cs.textContent = conv
      nm.appendChild(cs)
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

// Collapsed-by-default reference: the raw source text, shown verbatim.
function buildOriginalInstructions(text) {
  const section = document.createElement('div')
  section.className = 'rd-section rd-orig'

  const toggle = document.createElement('button')
  toggle.className = 'rd-orig__toggle'
  toggle.setAttribute('aria-expanded', 'false')
  toggle.innerHTML = `<span class="rd-orig__chev">▸</span> Original instructions (as written)`

  const body = document.createElement('pre')
  body.className = 'rd-orig__body rd-orig__body--hidden'
  // Stored value is never modified; conversions are appended at display time only.
  body.textContent = convertText(text)

  toggle.addEventListener('click', () => {
    const open = body.classList.toggle('rd-orig__body--hidden') === false
    toggle.setAttribute('aria-expanded', String(open))
    toggle.querySelector('.rd-orig__chev').textContent = open ? '▾' : '▸'
  })

  section.append(toggle, body)
  return section
}

// ── Notes (global, user-editable; AI may only add) ────────
// One unified list of tips / shortcuts / freeform notes stored in recipes.notes.
// Identical on every tab. User can add / edit / delete any entry; the AI ("Check
// for more tips") may only append new, non-duplicate entries.
function buildNotes() {
  const section = document.createElement('div')
  section.className = 'rd-section rd-notes'
  const lbl = document.createElement('div')
  lbl.className = 'rd-section__title'
  lbl.textContent = '📝 Notes'
  section.appendChild(lbl)

  const notes = recipe.notes || []
  const ul = document.createElement('ul')
  ul.className = 'rd-layer-list rd-notes__list'
  notes.forEach((text, i) => ul.appendChild(buildNoteRow(text, i)))
  section.appendChild(ul)

  // One row: add-a-note input + "+ Add" + "💡 More" (AI, add-only).
  const addRow = document.createElement('div')
  addRow.className = 'rd-notes__add'
  const input = document.createElement('input')
  input.type = 'text'; input.className = 'rd-min-input rd-notes__input'; input.placeholder = 'Add a note or tip…'
  const addBtn = document.createElement('button')
  addBtn.className = 'rd-notes__addbtn'; addBtn.textContent = '+ Add'
  const submit = async () => {
    const v = input.value.trim(); if (!v) return
    await saveNotes([...(recipe.notes || []), v]); rerenderNotes()
  }
  addBtn.addEventListener('click', submit)
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit() } })

  const moreBtn = document.createElement('button')
  moreBtn.className = 'rd-notes__morebtn'
  if (notesLoading) {
    moreBtn.disabled = true
    moreBtn.innerHTML = '<span class="spinner spinner--sm"></span>'
  } else {
    moreBtn.textContent = '💡 More'
    moreBtn.title = 'Check for more tips'
    moreBtn.addEventListener('click', () => addMoreTips())
  }

  addRow.append(input, addBtn, moreBtn)
  section.appendChild(addRow)
  return section
}

function buildNoteRow(text, i) {
  const li = document.createElement('li')
  li.className = 'rd-notes__item'
  const span = document.createElement('span')
  span.className = 'rd-notes__text'
  span.textContent = text
  span.title = 'Tap to edit'
  span.addEventListener('click', () => startEditNote(li, text, i))
  const del = document.createElement('button')
  del.className = 'rd-notes__del'; del.textContent = '×'; del.title = 'Delete note'
  del.addEventListener('click', async (e) => {
    e.stopPropagation()
    const next = (recipe.notes || []).slice(); next.splice(i, 1)
    await saveNotes(next); rerenderNotes()
  })
  li.append(span, del)
  return li
}

function startEditNote(li, text, i) {
  li.innerHTML = ''
  li.classList.add('rd-notes__item--editing')
  const inp = document.createElement('input')
  inp.type = 'text'; inp.className = 'rd-min-input rd-notes__edit'; inp.value = text
  let done = false
  const commit = async () => {
    if (done) return; done = true
    const v = inp.value.trim()
    const next = (recipe.notes || []).slice()
    if (!v) next.splice(i, 1); else next[i] = v
    await saveNotes(next); rerenderNotes()
  }
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commit() }
    if (e.key === 'Escape') { done = true; rerenderNotes() }
  })
  inp.addEventListener('blur', commit)
  li.appendChild(inp)
  requestAnimationFrame(() => inp.focus())
}

async function saveNotes(arr) {
  recipe.notes = arr
  const { error } = await supabase.from('recipes').update({ notes: arr }).eq('id', recipe.id)
  if (error) toast('Save failed', { error: true })
}

function rerenderNotes() {
  const old = screenEl.querySelector('.rd-notes')
  if (old) old.replaceWith(buildNotes())
}

// AI may only ADD non-duplicate tips to the global notes — never edit/delete.
async function addMoreTips() {
  notesLoading = true
  rerenderNotes()
  const current = recipe.notes || []
  try {
    const res = await fetch(`${FUNCTIONS_URL}/recipe-agent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'add_more_hacks',
        recipe_name: recipe.name,
        original_instructions: recipe.original_instructions || '',
        ingredients: ingredients.map(i => ({ name: i.name, quantity: i.quantity, unit: i.unit, notes: i.notes })),
        existing_hacks: current,
      }),
    })
    const data = await res.json()
    const newTips = data.new_hacks || []
    if (newTips.length) {
      const merged = [...current, ...newTips]
      await supabase.from('recipes').update({ notes: merged }).eq('id', recipe.id)
      recipe.notes = merged
      toast(`${newTips.length} new tip${newTips.length > 1 ? 's' : ''} added`)
    } else {
      toast("No new tips found — you've got them all!")
    }
  } catch {
    toast('Could not reach server', { error: true })
  } finally {
    notesLoading = false
    rerenderNotes()
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

  // Collapsed by default — header toggles the body.
  const toggle = document.createElement('button')
  toggle.className = 'rd-prepped__toggle'
  toggle.setAttribute('aria-expanded', 'false')
  const n = preppedComponents.length
  toggle.innerHTML = `<span class="rd-prepped__chev">▸</span> Prepped components${n ? ` (${n})` : ''}`
  const body = document.createElement('div')
  body.className = 'rd-prepped__body rd-prepped__body--hidden'
  toggle.addEventListener('click', () => {
    const open = body.classList.toggle('rd-prepped__body--hidden') === false
    toggle.setAttribute('aria-expanded', String(open))
    toggle.querySelector('.rd-prepped__chev').textContent = open ? '▾' : '▸'
  })
  section.appendChild(toggle)
  section.appendChild(body)

  for (const pc of preppedComponents) {
    const item = document.createElement('div')
    item.className = 'rd-prepped__item'
    item.innerHTML = `
      <span class="rd-prepped__name">${pc.name}</span>
      <span class="rd-prepped__meta">${pc.batches_remaining ?? '?'} batch${(pc.batches_remaining ?? 0) !== 1 ? 'es' : ''} left${pc.storage_notes ? ' · ' + pc.storage_notes : ''}</span>`
    body.appendChild(item)
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
  body.appendChild(addItem)
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

async function makeDefault() {
  const newDefault = activeTabId === 'original' ? null : activeTabId
  const { error }  = await supabase.from('recipes').update({ default_variant_id: newDefault }).eq('id', recipe.id)
  if (error) { toast('Save failed', { error: true }); return }
  recipe.default_variant_id = newDefault
  toast(newDefault ? 'Set as default' : 'Reverted to Original')
  const pillsEl   = screenEl.querySelector('.rd-pills')
  const contentEl = document.getElementById('rd-content')
  if (pillsEl)   pillsEl.replaceWith(buildPills())
  if (contentEl) { const nc = buildContent(); nc.id = 'rd-content'; contentEl.replaceWith(nc) }
}

// ── Scale this recipe ─────────────────────────────────────
// Label, then a single row: minimal input + outline send-icon (paper-plane,
// stroke-only — same glyph as the Chat input).
const SCALE_SEND_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5"/></svg>'
function buildScaleSection() {
  const container = document.createElement('div')
  container.className = 'rd-ai-item rd-scale'

  const head = document.createElement('div')
  head.className = 'rd-ai-head'
  const titleEl = document.createElement('span')
  titleEl.className = 'rd-ai-head__title'
  titleEl.textContent = '📏 Scale this recipe'
  head.appendChild(titleEl)

  const row = document.createElement('div')
  row.className = 'rd-scale-row'
  const input = document.createElement('input')
  input.type = 'text'; input.className = 'rd-min-input rd-scale-input'
  input.placeholder = 'e.g. 8 people or double it'
  const send = document.createElement('button')
  send.className = 'rd-scale-send'
  send.title = 'Scale'
  send.innerHTML = SCALE_SEND_ICON

  const run = async () => {
    const v = input.value.trim()
    if (!v) { input.focus(); return }
    row.innerHTML = '<div class="rd-ai-panel__loading"><div class="spinner"></div>Scaling…</div>'
    await runScaleRecipe(v)
  }
  send.addEventListener('click', run)
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); run() } })

  row.append(input, send)
  container.append(head, row)
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
  const r = scaleResult

  // Regenerate the cooking layers from the SCALED ingredients so the steps
  // show the correct scaled quantities (not the parent's un-scaled amounts).
  // Falls back to the scaling-notes overlay if regeneration fails.
  const isOriginal = activeTabId === 'original'
  const av         = variants.find(v => v.id === activeTabId) || null
  const baseLayers = isOriginal ? recipe : av
  let nightBefore = baseLayers?.night_before || []
  let morningOf   = baseLayers?.morning_of   || []
  let whenCooking = r.when_cooking_changes?.length
    ? [...(baseLayers?.when_cooking || []), '─── Scaling notes ───', ...r.when_cooking_changes]
    : (baseLayers?.when_cooking || [])
  try {
    const res = await fetch(`${FUNCTIONS_URL}/recipe-agent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'generate_adhd_layers',
        recipe_name: `${recipe.name} (${label || 'scaled'})`,
        original_instructions: recipe.original_instructions || '',
        ingredients: r.ingredients.map(i => ({ name: i.name, quantity: i.quantity, unit: i.unit, notes: i.notes })),
      }),
    })
    const gen = await res.json()
    if (!gen.error && Array.isArray(gen.when_cooking)) {
      nightBefore = gen.night_before || []
      morningOf   = gen.morning_of   || []
      whenCooking = gen.when_cooking
    }
  } catch { /* keep fallback layers */ }

  const { data: nv, error } = await supabase.from('recipe_variants')
    .insert({ recipe_id: recipe.id, label, serves: r.serves, night_before: nightBefore,
      morning_of: morningOf, when_cooking: whenCooking,
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

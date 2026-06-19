import { supabase, FUNCTIONS_URL, navigateTo, navState, toast } from '../app.js'

// ── State ─────────────────────────────────────────────────
let screenEl       = null
let mode           = 'add'        // 'add' | 'edit'
let editRecipeId   = null
let step           = 'paste'      // 'paste'|'loading'|'review'|'saving'
let formData       = {}
let ingredientRows = []           // [{id?, qtyUnit, name}]
let editSnapshot   = null         // {instructions, ingCount} for change detection

const MEAL_TYPES   = ['breakfast','lunch_dinner','snack','special']
const VALID_TAGS   = ['dump','batch_cook','freezable','kidproof','travel_friendly']
const EMOJI_FALLBACKS = {
  breakfast: '🍳', lunch_dinner: '🍽️', snack: '🍎', special: '🎉',
}

// ── Lifecycle ─────────────────────────────────────────────
export function init(el) { screenEl = el }

export async function activate({ headerLeft, headerRight }) {
  // Reset state fully on each entry
  step           = 'paste'
  formData       = {}
  ingredientRows = []
  editSnapshot   = null

  if (navState.editRecipeId) {
    mode          = 'edit'
    editRecipeId  = navState.editRecipeId
    navState.editRecipeId = null
  } else {
    mode         = 'add'
    editRecipeId = null
  }

  const backTarget = mode === 'edit' ? 'recipe-detail' : 'recipes'
  headerLeft.innerHTML = `
    <button class="header-btn" id="btn-ar-back" aria-label="Back">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5"/>
      </svg>
    </button>`
  document.getElementById('btn-ar-back').addEventListener('click', () => {
    if (mode === 'edit') navState.recipeId = editRecipeId
    navigateTo(backTarget)
  })

  const titleEl = document.getElementById('screen-title')

  if (mode === 'edit') {
    if (titleEl) titleEl.textContent = 'Edit Recipe'
    step = 'loading'
    render()
    await loadForEdit()
    step = 'review'
  } else {
    if (titleEl) titleEl.textContent = 'Add Recipe'
  }

  render()
}

// ── Edit load ─────────────────────────────────────────────
async function loadForEdit() {
  const [rRes, iRes] = await Promise.all([
    supabase.from('recipes')
      .select('id,name,emoji,meal_type,cuisine,protein,style,cooking_method,serves_base,prep_time_min,cook_time_min,is_freezable,can_double,tags,original_instructions')
      .eq('id', editRecipeId).single(),
    supabase.from('recipe_ingredients')
      .select('id,quantity,unit,name,notes,order_index')
      .eq('recipe_id', editRecipeId).order('order_index'),
  ])

  if (rRes.error || !rRes.data) { toast('Could not load recipe', { error: true }); return }
  const r = rRes.data

  formData = {
    name:                 r.name || '',
    emoji:                r.emoji || '',
    meal_type:            r.meal_type || 'lunch_dinner',
    cuisine:              r.cuisine || '',
    protein:              r.protein || '',
    style:                r.style || '',
    cooking_method:       r.cooking_method || '',
    serves_base:          r.serves_base ?? '',
    prep_time_min:        r.prep_time_min ?? '',
    cook_time_min:        r.cook_time_min ?? '',
    is_freezable:         r.is_freezable ?? false,
    can_double:           r.can_double ?? false,
    tags:                 r.tags || [],
    original_instructions: r.original_instructions || '',
  }

  const ings = iRes.data || []
  ingredientRows = ings.map(i => ({
    id:      i.id,
    qtyUnit: [fmtQty(i.quantity, i.unit)].filter(Boolean).join(''),
    name:    [i.name, i.notes ? `(${i.notes})` : ''].filter(Boolean).join(' '),
  }))

  editSnapshot = {
    instructions: r.original_instructions || '',
    ingHash:      JSON.stringify(ingredientRows.map(r => r.qtyUnit + r.name)),
  }
}

// ── Render ────────────────────────────────────────────────
function render() {
  if (!screenEl) return
  screenEl.innerHTML = ''
  const root = document.createElement('div')
  root.className = 'ar'

  if (step === 'paste')   root.appendChild(buildPasteStep())
  if (step === 'loading') root.appendChild(buildLoadingStep())
  if (step === 'review')  root.appendChild(buildReviewForm())
  if (step === 'saving')  root.appendChild(buildSavingStep('Saving and generating cooking steps…'))

  screenEl.appendChild(root)
}

// ── Step 1: Paste ─────────────────────────────────────────
function buildPasteStep() {
  const wrap = document.createElement('div')
  wrap.className = 'ar-paste'

  const hint = document.createElement('p')
  hint.className = 'ar-paste__hint'
  hint.textContent = 'Paste the full recipe here — ingredients, instructions, anything you have. Claude will extract the details.'

  const area = document.createElement('textarea')
  area.className  = 'ar-paste__area'
  area.rows       = 14
  area.placeholder = 'Paste recipe here…'
  area.value      = formData.rawPaste || ''

  const btn = document.createElement('button')
  btn.className   = 'ar-paste__btn'
  btn.textContent = 'Extract details →'
  btn.addEventListener('click', async () => {
    const text = area.value.trim()
    if (!text) { area.focus(); return }
    formData.rawPaste = text
    step = 'loading'
    render()
    await runExtract(text)
  })

  const manualLink = document.createElement('button')
  manualLink.className   = 'ar-paste__manual'
  manualLink.textContent = 'Or skip the AI and enter it manually'
  manualLink.addEventListener('click', () => {
    formData = {
      name: '', emoji: '', meal_type: 'lunch_dinner', cuisine: '', protein: '',
      style: '', cooking_method: '', serves_base: 4, prep_time_min: '', cook_time_min: '',
      is_freezable: false, can_double: false, tags: [], original_instructions: '',
    }
    ingredientRows = [{ qtyUnit: '', name: '' }]
    step = 'review'
    render()
  })

  wrap.append(hint, area, btn, manualLink)
  return wrap
}

// ── Step 2: Loading ───────────────────────────────────────
function buildLoadingStep(msg = 'Extracting recipe details…') {
  return buildSavingStep(msg)
}

function buildSavingStep(msg) {
  const wrap = document.createElement('div')
  wrap.className = 'ar-loading'
  wrap.innerHTML = `<div class="spinner"></div><p>${msg}</p>`
  return wrap
}

// ── Extract ───────────────────────────────────────────────
async function runExtract(rawText) {
  try {
    const res  = await fetch(`${FUNCTIONS_URL}/recipe-agent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'extract_recipe', raw_text: rawText }),
    })
    const data = await res.json()
    if (data.error) throw new Error(data.error)

    formData = {
      name:                 data.name || '',
      emoji:                data.emoji || '',
      meal_type:            data.meal_type || 'lunch_dinner',
      cuisine:              data.cuisine || '',
      protein:              data.protein || '',
      style:                data.style || '',
      cooking_method:       data.cooking_method || '',
      serves_base:          data.serves_base ?? '',
      prep_time_min:        data.prep_time_min ?? '',
      cook_time_min:        data.cook_time_min ?? '',
      is_freezable:         data.is_freezable ?? false,
      can_double:           data.can_double ?? false,
      tags:                 data.tags || [],
      original_instructions: data.original_instructions || '',
      rawPaste:             rawText,
    }
    ingredientRows = (data.ingredients || []).map((i, idx) => ({
      qtyUnit: fmtQty(i.quantity, i.unit),
      name:    [i.name, i.notes ? `(${i.notes})` : ''].filter(Boolean).join(' '),
      _parsed: i,
    }))
  } catch (e) {
    console.error(e)
    toast('Extraction failed — check your connection and try again', { error: true })
    step = 'paste'
    render()
    return
  }
  step = 'review'
  render()
}

// ── Step 3: Review form ───────────────────────────────────
function buildReviewForm() {
  const form = document.createElement('div')
  form.className = 'ar-form'

  form.appendChild(field('Recipe name', 'text', 'name', formData.name, 'e.g. Chickpea Curry'))
  form.appendChild(field('Emoji', 'text', 'emoji', formData.emoji, '🍛', { small: true }))

  // Meal type select
  form.appendChild(selectField('Meal type', 'meal_type', formData.meal_type, [
    { value: 'breakfast',   label: 'Breakfast' },
    { value: 'lunch_dinner',label: 'Dinner / Lunch' },
    { value: 'snack',       label: 'Snack' },
    { value: 'special',     label: 'Special occasion' },
  ]))

  form.appendChild(fieldRow([
    field('Cuisine', 'text', 'cuisine', formData.cuisine, 'e.g. Indian'),
    field('Protein', 'text', 'protein', formData.protein, 'e.g. chickpea'),
  ]))
  form.appendChild(fieldRow([
    field('Style', 'text', 'style', formData.style, 'e.g. slow simmer'),
    field('Cooking method', 'text', 'cooking_method', formData.cooking_method, 'e.g. stovetop'),
  ]))
  form.appendChild(fieldRow([
    field('Serves', 'number', 'serves_base', formData.serves_base, '4', { min: 1, max: 50 }),
    field('Prep (min)', 'number', 'prep_time_min', formData.prep_time_min, '15', { min: 0 }),
    field('Cook (min)', 'number', 'cook_time_min', formData.cook_time_min, '30', { min: 0 }),
  ]))

  // Checkboxes
  const flagSection = document.createElement('div')
  flagSection.className = 'ar-field ar-flags'
  flagSection.appendChild(checkField('Freezable', 'is_freezable', formData.is_freezable))
  flagSection.appendChild(checkField('Can double (auto-generates 2× and 3× variants on save)', 'can_double', formData.can_double))
  form.appendChild(flagSection)

  // Tags
  form.appendChild(buildTagPicker())

  // Instructions
  const instrWrap = document.createElement('div')
  instrWrap.className = 'ar-field'
  const instrLbl = document.createElement('div')
  instrLbl.className = 'ar-field__label'
  instrLbl.textContent = 'Original instructions'
  const instrArea = document.createElement('textarea')
  instrArea.className    = 'ar-field__textarea'
  instrArea.id           = 'ar-instructions'
  instrArea.rows         = 8
  instrArea.value        = formData.original_instructions
  instrArea.placeholder  = 'Paste or type the full recipe instructions here'
  instrWrap.append(instrLbl, instrArea)
  form.appendChild(instrWrap)

  // Ingredients
  form.appendChild(buildIngredientEditor())

  // Save button
  const saveWrap = document.createElement('div')
  saveWrap.className = 'ar-save-row'
  const saveBtn = document.createElement('button')
  saveBtn.className   = 'ar-save-btn'
  saveBtn.textContent = mode === 'edit' ? 'Save Changes' : 'Save Recipe'
  saveBtn.addEventListener('click', () => handleSave(form))
  saveWrap.appendChild(saveBtn)
  form.appendChild(saveWrap)

  return form
}

function field(labelText, type, name, value, placeholder, opts = {}) {
  const wrap = document.createElement('div')
  wrap.className = 'ar-field'
  if (opts.small) wrap.classList.add('ar-field--small')

  const lbl = document.createElement('div')
  lbl.className   = 'ar-field__label'
  lbl.textContent = labelText

  const inp = document.createElement('input')
  inp.type        = type
  inp.className   = 'ar-field__input'
  inp.id          = `ar-${name}`
  inp.name        = name
  inp.value       = value ?? ''
  inp.placeholder = placeholder || ''
  if (opts.min != null) inp.min = opts.min
  if (opts.max != null) inp.max = opts.max

  wrap.append(lbl, inp)
  return wrap
}

function fieldRow(fields) {
  const row = document.createElement('div')
  row.className = 'ar-field-row'
  fields.forEach(f => row.appendChild(f))
  return row
}

function selectField(labelText, name, value, options) {
  const wrap = document.createElement('div')
  wrap.className = 'ar-field'
  const lbl = document.createElement('div')
  lbl.className   = 'ar-field__label'
  lbl.textContent = labelText
  const sel = document.createElement('select')
  sel.className = 'ar-field__select'
  sel.id = `ar-${name}`
  for (const opt of options) {
    const o = document.createElement('option')
    o.value = opt.value
    o.textContent = opt.label
    if (opt.value === value) o.selected = true
    sel.appendChild(o)
  }
  wrap.append(lbl, sel)
  return wrap
}

function checkField(labelText, name, checked) {
  const row = document.createElement('label')
  row.className = 'ar-check-row'
  const cb = document.createElement('input')
  cb.type    = 'checkbox'
  cb.id      = `ar-${name}`
  cb.name    = name
  cb.checked = !!checked
  const span = document.createElement('span')
  span.textContent = labelText
  row.append(cb, span)
  return row
}

function buildTagPicker() {
  const wrap = document.createElement('div')
  wrap.className = 'ar-field'
  const lbl = document.createElement('div')
  lbl.className   = 'ar-field__label'
  lbl.textContent = 'Tags'
  const pills = document.createElement('div')
  pills.className = 'ar-tags'
  for (const tag of VALID_TAGS) {
    const btn = document.createElement('button')
    const on  = (formData.tags || []).includes(tag)
    btn.className   = `ar-tag${on ? ' ar-tag--on' : ''}`
    btn.type        = 'button'
    btn.dataset.tag = tag
    btn.textContent = tag.replace(/_/g, ' ')
    btn.addEventListener('click', () => {
      const idx = (formData.tags || []).indexOf(tag)
      if (idx >= 0) formData.tags.splice(idx, 1)
      else { formData.tags = formData.tags || []; formData.tags.push(tag) }
      btn.classList.toggle('ar-tag--on', formData.tags.includes(tag))
    })
    pills.appendChild(btn)
  }
  wrap.append(lbl, pills)
  return wrap
}

function buildIngredientEditor() {
  const wrap = document.createElement('div')
  wrap.className = 'ar-field'
  const lbl = document.createElement('div')
  lbl.className   = 'ar-field__label'
  lbl.textContent = 'Ingredients'

  const list = document.createElement('div')
  list.className = 'ar-ing-list'
  list.id = 'ar-ing-list'

  function renderRows() {
    list.innerHTML = ''
    ingredientRows.forEach((row, idx) => {
      const rowEl = document.createElement('div')
      rowEl.className = 'ar-ing-row'
      const qty = document.createElement('input')
      qty.type        = 'text'
      qty.className   = 'ar-ing-row__qty'
      qty.placeholder = '400g'
      qty.value       = row.qtyUnit
      qty.addEventListener('change', () => { ingredientRows[idx].qtyUnit = qty.value })
      const nm = document.createElement('input')
      nm.type        = 'text'
      nm.className   = 'ar-ing-row__name'
      nm.placeholder = 'chickpeas (or 2 cans, drained)'
      nm.value       = row.name
      nm.addEventListener('change', () => { ingredientRows[idx].name = nm.value })
      const del = document.createElement('button')
      del.type        = 'button'
      del.className   = 'ar-ing-row__del'
      del.textContent = '✕'
      del.addEventListener('click', () => { ingredientRows.splice(idx, 1); renderRows() })
      rowEl.append(qty, nm, del)
      list.appendChild(rowEl)
    })
  }

  renderRows()

  const addBtn = document.createElement('button')
  addBtn.type      = 'button'
  addBtn.className = 'ar-ing-add'
  addBtn.textContent = '+ Add ingredient'
  addBtn.addEventListener('click', () => {
    ingredientRows.push({ qtyUnit: '', name: '' })
    renderRows()
    const inputs = list.querySelectorAll('.ar-ing-row__qty')
    inputs[inputs.length - 1]?.focus()
  })

  wrap.append(lbl, list, addBtn)
  return wrap
}

// ── Save ──────────────────────────────────────────────────
async function handleSave(form) {
  // Read form values
  const g = id => document.getElementById(`ar-${id}`)
  const name     = g('name')?.value.trim()
  if (!name) { g('name')?.focus(); toast('Recipe name is required', { error: true }); return }

  const data = {
    name,
    emoji:                g('emoji')?.value.trim()    || null,
    meal_type:            g('meal_type')?.value       || 'lunch_dinner',
    cuisine:              g('cuisine')?.value.trim()  || null,
    protein:              g('protein')?.value.trim()  || null,
    style:                g('style')?.value.trim()    || null,
    cooking_method:       g('cooking_method')?.value.trim() || null,
    serves_base:          parseInt(g('serves_base')?.value)   || null,
    prep_time_min:        parseInt(g('prep_time_min')?.value) || null,
    cook_time_min:        parseInt(g('cook_time_min')?.value) || null,
    is_freezable:         g('is_freezable')?.checked  ?? false,
    can_double:           g('can_double')?.checked    ?? false,
    tags:                 formData.tags || [],
    original_instructions: g('instructions')?.value.trim() || null,
    active:               true,
  }

  // Check for changes in edit mode
  let regenLayers = false
  if (mode === 'edit' && editSnapshot) {
    const instrChanged = data.original_instructions !== editSnapshot.instructions
    const ingHash = JSON.stringify(ingredientRows.map(r => r.qtyUnit + r.name))
    const ingsChanged = ingHash !== editSnapshot.ingHash
    if (instrChanged || ingsChanged) {
      regenLayers = confirm('Instructions or ingredients changed. Re-generate cooking steps?')
    }
  }

  step = 'saving'
  render()

  try {
    let recipeId
    if (mode === 'add') {
      const { data: rec, error } = await supabase.from('recipes').insert(data).select('id').single()
      if (error || !rec) throw error
      recipeId = rec.id
    } else {
      const { error } = await supabase.from('recipes').update(data).eq('id', editRecipeId)
      if (error) throw error
      recipeId = editRecipeId
    }

    // Parse and upsert ingredients
    const parsedIngs = ingredientRows
      .map((r, idx) => ({ ...parseIngRow(r.qtyUnit, r.name), order_index: idx }))
      .filter(i => i.name)

    if (mode === 'edit') {
      // Delete old, insert new
      await supabase.from('recipe_ingredients').delete().eq('recipe_id', recipeId)
    }
    if (parsedIngs.length) {
      await supabase.from('recipe_ingredients').insert(
        parsedIngs.map(i => ({ ...i, recipe_id: recipeId }))
      )
    }

    // Generate ADHD layers
    if (mode === 'add' || regenLayers) {
      await generateAndSaveLayers(recipeId, data.name, data.original_instructions, parsedIngs)
    }

    // Auto-scale for can_double if brand new or newly toggled
    if (data.can_double) {
      const shouldAutoScale = mode === 'add' || (mode === 'edit' && !editSnapshot?.hadCanDouble)
      if (shouldAutoScale) {
        await autoScaleVariants(recipeId, data.name, data.serves_base || 4, parsedIngs)
      }
    }

    navState.recipeId = recipeId
    navigateTo('recipe-detail')
  } catch (e) {
    console.error(e)
    toast('Save failed — check your connection', { error: true })
    step = 'review'
    render()
  }
}

async function generateAndSaveLayers(recipeId, recipeName, instructions, ings) {
  if (!instructions) return
  try {
    const res  = await fetch(`${FUNCTIONS_URL}/recipe-agent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'generate_adhd_layers',
        recipe_name: recipeName,
        original_instructions: instructions,
        ingredients: ings,
      }),
    })
    const data = await res.json()
    if (data.night_before || data.morning_of || data.when_cooking) {
      await supabase.from('recipes').update({
        night_before:       data.night_before        || [],
        morning_of:         data.morning_of          || [],
        when_cooking:       data.when_cooking         || [],
        hacks_and_shortcuts: data.hacks_and_shortcuts || [],
      }).eq('id', recipeId)
    }
  } catch (e) {
    console.error('Layer generation failed:', e)
    // Non-fatal — recipe is saved, layers just won't exist yet
  }
}

async function autoScaleVariants(recipeId, recipeName, currentServes, ings) {
  try {
    const [r2, r3] = await Promise.all([
      fetch(`${FUNCTIONS_URL}/recipe-agent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'scale_recipe', recipe_name: recipeName,
          current_serves: currentServes, ingredients: ings, target: '2x' }),
      }).then(r => r.json()),
      fetch(`${FUNCTIONS_URL}/recipe-agent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'scale_recipe', recipe_name: recipeName,
          current_serves: currentServes, ingredients: ings, target: '3x' }),
      }).then(r => r.json()),
    ])

    for (const [scaleData, label] of [[r2, '2x batch'], [r3, '3x batch']]) {
      if (!scaleData?.ingredients) continue
      const { data: nv } = await supabase.from('recipe_variants').insert({
        recipe_id: recipeId, label,
        serves: scaleData.serves,
        when_cooking: scaleData.when_cooking_changes?.length
          ? ['─── Scaling notes ───', ...scaleData.when_cooking_changes] : [],
        notes: scaleData.scaling_notes || null, created_by: 'ai',
      }).select('id').single()
      if (!nv?.id) continue
      await supabase.from('recipe_variant_ingredients').insert(
        scaleData.ingredients.map((i, idx) => ({
          variant_id: nv.id, name: i.name, quantity: i.quantity ?? null,
          unit: i.unit ?? null, notes: i.notes ?? null, order_index: idx,
        }))
      )
    }
  } catch (e) {
    console.error('Auto-scale failed (non-fatal):', e)
  }
}

// ── Helpers ───────────────────────────────────────────────
function parseIngRow(qtyUnit, nameRaw) {
  const qtMatch = qtyUnit.trim().match(/^(\d+(?:[.,\/]\d+)?)(?:\s*([a-zA-Zé]+))?$/)
  const quantity = qtMatch ? parseFloat(qtMatch[1].replace(',', '.')) : null
  const unit     = qtMatch?.[2]?.trim() || null

  // Split "chickpeas (or 2 cans, drained)" → name + notes
  const nmMatch  = nameRaw.match(/^([^(]+?)\s*(?:\(([^)]+)\))?$/)
  const name     = (nmMatch?.[1] || nameRaw).trim()
  const notes    = nmMatch?.[2]?.trim() || null

  return { quantity, unit, name, notes }
}

function fmtQty(quantity, unit) {
  if (quantity == null) return ''
  const q = Number(quantity)
  const s = Number.isInteger(q) ? String(q) : q.toFixed(1).replace(/\.0$/, '')
  return unit ? `${s} ${unit}` : s
}

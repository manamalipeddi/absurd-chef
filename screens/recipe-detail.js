import { supabase, navigateTo, navState, toast } from '../app.js'

// ── State ─────────────────────────────────────────────────
let screenEl = null

// ── Lifecycle ─────────────────────────────────────────────
export function init(el) {
  screenEl = el
}

export async function activate({ headerLeft, headerRight }) {
  // Back button
  headerLeft.innerHTML = `
    <button class="header-btn" id="btn-back" aria-label="Back">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5"/>
      </svg>
    </button>`
  document.getElementById('btn-back').addEventListener('click', () => navigateTo('recipes'))

  await renderDetail()
}

// ── Render ────────────────────────────────────────────────
async function renderDetail() {
  if (!screenEl || !navState.recipeId) return
  screenEl.innerHTML = `<div class="loading-row"><div class="spinner"></div>Loading…</div>`

  const { data: recipe, error } = await supabase
    .from('recipes')
    .select('id, name, emoji, meal_type, ease_descriptor, original_instructions, night_before, morning_of, when_cooking, the_scary_bit, protein, cooking_method')
    .eq('id', navState.recipeId)
    .single()

  if (error || !recipe) {
    screenEl.innerHTML = `<div class="placeholder-wrap"><p class="placeholder-label">Recipe not found</p></div>`
    return
  }

  // Update header title to recipe name
  const titleEl = document.getElementById('screen-title')
  if (titleEl) titleEl.textContent = recipe.name

  screenEl.innerHTML = ''
  screenEl.appendChild(buildDetail(recipe))
}

// ── Builders ──────────────────────────────────────────────
function buildDetail(recipe) {
  const wrap = document.createElement('div')
  wrap.className = 'recipe-detail'

  wrap.appendChild(buildHero(recipe))
  wrap.appendChild(buildActions())
  wrap.appendChild(buildEaseSection(recipe))
  wrap.appendChild(buildLayers(recipe))

  return wrap
}

function buildHero(recipe) {
  const el = document.createElement('div')
  el.className = 'recipe-detail__hero'
  el.innerHTML = `
    <div class="recipe-detail__emoji" aria-hidden="true">${recipe.emoji || defaultEmoji(recipe.meal_type)}</div>
    <h2 class="recipe-detail__name">${recipe.name}</h2>`
  return el
}

function buildActions() {
  const el = document.createElement('div')
  el.className = 'recipe-detail__actions'
  el.innerHTML = `
    <button class="btn-outline" id="btn-use-tonight">Use tonight</button>
    <button class="btn-outline" id="btn-schedule">Schedule…</button>`
  el.querySelector('#btn-use-tonight').addEventListener('click', () =>
    toast('Coming soon — use Chat to change a day')
  )
  el.querySelector('#btn-schedule').addEventListener('click', () =>
    toast('Coming soon')
  )
  return el
}

function buildEaseSection(recipe) {
  const section = document.createElement('div')
  section.className = 'recipe-detail__section'

  const label = document.createElement('div')
  label.className = 'recipe-detail__section-label'
  label.textContent = 'How easy is this?'

  const row = document.createElement('div')
  row.className = 'recipe-detail__ease-row'

  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'recipe-detail__ease-input'
  input.value = recipe.ease_descriptor || ''
  input.placeholder = 'e.g. "weeknight easy" or "Sunday only"'
  input.setAttribute('aria-label', 'Ease descriptor')

  const saveBtn = document.createElement('button')
  saveBtn.className = 'btn-outline btn-outline--sm'
  saveBtn.textContent = 'Save'
  saveBtn.disabled = true

  let saved = recipe.ease_descriptor || ''
  input.addEventListener('input', () => {
    saveBtn.disabled = (input.value.trim() === saved)
  })
  saveBtn.addEventListener('click', async () => {
    const val = input.value.trim() || null
    const { error } = await supabase
      .from('recipes')
      .update({ ease_descriptor: val })
      .eq('id', recipe.id)
    if (error) {
      toast('Save failed', { error: true })
    } else {
      saved = input.value.trim()
      recipe.ease_descriptor = val
      saveBtn.disabled = true
      toast('Saved')
    }
  })

  row.append(input, saveBtn)
  section.append(label, row)
  return section
}

function buildLayers(recipe) {
  const wrap = document.createElement('div')
  wrap.className = 'recipe-detail__layers'

  if (recipe.original_instructions) {
    wrap.appendChild(layerText('📋 Original', recipe.original_instructions))
  }

  for (const { key, label } of [
    { key: 'night_before', label: '🌙 Night before' },
    { key: 'morning_of',   label: '☀️ Morning of'   },
    { key: 'when_cooking', label: '🍳 When cooking'  },
  ]) {
    const steps = recipe[key]
    if (steps?.length) wrap.appendChild(layerList(label, steps))
  }

  if (recipe.the_scary_bit) {
    wrap.appendChild(layerScary(recipe.the_scary_bit))
  }

  return wrap
}

function layerText(label, text) {
  const el = document.createElement('div')
  el.className = 'recipe-detail__section'
  el.innerHTML = `
    <div class="recipe-detail__section-label">${label}</div>
    <p class="recipe-detail__text">${text}</p>`
  return el
}

function layerList(label, steps) {
  const el = document.createElement('div')
  el.className = 'recipe-detail__section'
  el.innerHTML = `
    <div class="recipe-detail__section-label">${label}</div>
    <ul class="recipe-detail__list">${steps.map(s => `<li>${s}</li>`).join('')}</ul>`
  return el
}

function layerScary(text) {
  const el = document.createElement('div')
  el.className = 'recipe-detail__section recipe-detail__scary'
  el.innerHTML = `<span>⚠️ The scary bit</span><p>${text}</p>`
  return el
}

function defaultEmoji(mealType) {
  return { breakfast: '🍳', lunch_dinner: '🍽️', snack: '🍎', special: '🎉' }[mealType] || '🍽️'
}

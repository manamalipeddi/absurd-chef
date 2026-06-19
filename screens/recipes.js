import { supabase, navigateTo, navState } from '../app.js'

// ── Section config ────────────────────────────────────────
const SECTIONS = [
  { type: 'breakfast',    label: 'Breakfast',       defaultEmoji: '🍳',  open: false },
  { type: 'lunch_dinner', label: 'Dinner/Lunch',    defaultEmoji: '🍽️', open: true  },
  { type: 'snack',        label: 'Snacks',           defaultEmoji: '🍎',  open: false },
  { type: 'special',      label: 'Special Occasion', defaultEmoji: '🎉',  open: false },
]

// ── State ─────────────────────────────────────────────────
let allRecipes  = []
let stashMap    = {}   // recipe_id → total available portions
let screenEl    = null
const openState = {}   // meal_type → boolean

// ── Lifecycle ─────────────────────────────────────────────
export function init(el) {
  screenEl = el
  SECTIONS.forEach(s => { openState[s.type] = s.open })
}

export async function activate({ headerLeft, headerRight }) {
  if (!screenEl) return
  headerRight.innerHTML = `
    <button class="header-btn" id="btn-add-recipe" aria-label="Add recipe">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15"/>
      </svg>
    </button>`
  document.getElementById('btn-add-recipe').addEventListener('click', () => navigateTo('add-recipe'))
  screenEl.innerHTML = `<div class="loading-row"><div class="spinner"></div>Loading recipes…</div>`
  await loadData()
  render()
}

// ── Data ──────────────────────────────────────────────────
async function loadData() {
  const [recipeRes, stashRes] = await Promise.all([
    supabase
      .from('recipes')
      .select('id, name, meal_type, cooking_method, is_preferred, ease_descriptor, emoji, active')
      .eq('active', true)
      .order('name'),
    supabase
      .from('freezer_stash')
      .select('recipe_id, portions')
      .eq('used', false),
  ])

  allRecipes = recipeRes.data || []

  stashMap = {}
  for (const row of (stashRes.data || [])) {
    if (row.portions > 0) {
      stashMap[row.recipe_id] = (stashMap[row.recipe_id] || 0) + row.portions
    }
  }
}

// ── Render ────────────────────────────────────────────────
function render() {
  if (!screenEl) return
  screenEl.innerHTML = ''

  for (const section of SECTIONS) {
    const recipes = allRecipes.filter(r => r.meal_type === section.type)
    if (!recipes.length) continue
    screenEl.appendChild(buildSection(section, recipes))
  }
}

function buildSection(section, recipes) {
  const wrap = document.createElement('div')
  wrap.className = 'recipe-section'

  const header = document.createElement('button')
  header.className = 'recipe-section__header'
  header.setAttribute('aria-expanded', String(openState[section.type]))
  header.innerHTML = `
    <span class="recipe-section__label">
      ${section.label}
      <span class="recipe-section__count">(${recipes.length})</span>
    </span>
    <svg class="recipe-section__chevron${openState[section.type] ? ' recipe-section__chevron--open' : ''}"
         viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path stroke-linecap="round" stroke-linejoin="round" d="m19 9-7 7-7-7"/>
    </svg>`

  const body = document.createElement('div')
  body.className = 'recipe-section__body' + (openState[section.type] ? '' : ' recipe-section__body--hidden')

  const card = document.createElement('div')
  card.className = 'card'
  recipes.forEach((recipe, i) => {
    const row = buildRow(recipe, section.defaultEmoji)
    if (i < recipes.length - 1) row.classList.add('recipe-row--ruled')
    card.appendChild(row)
  })
  body.appendChild(card)

  header.addEventListener('click', () => {
    openState[section.type] = !openState[section.type]
    header.setAttribute('aria-expanded', String(openState[section.type]))
    body.classList.toggle('recipe-section__body--hidden', !openState[section.type])
    header.querySelector('.recipe-section__chevron')
      .classList.toggle('recipe-section__chevron--open', openState[section.type])
  })

  wrap.append(header, body)
  return wrap
}

function buildRow(recipe, fallbackEmoji) {
  const portions = stashMap[recipe.id] || 0

  const row = document.createElement('div')
  row.className = 'recipe-row'

  // Emoji slot
  const emojiEl = document.createElement('div')
  emojiEl.className = 'recipe-row__emoji'
  emojiEl.setAttribute('aria-hidden', 'true')
  emojiEl.textContent = recipe.emoji || fallbackEmoji

  // Centre text
  const centre = document.createElement('div')
  centre.className = 'recipe-row__centre'

  const name = document.createElement('span')
  name.className = 'recipe-row__name'
  name.textContent = recipe.name
  centre.appendChild(name)

  const subParts = []
  if (recipe.ease_descriptor)  subParts.push(recipe.ease_descriptor)
  if (recipe.cooking_method)   subParts.push(fmtMethod(recipe.cooking_method))
  if (portions > 0)            subParts.push(`🧊 ${portions}`)

  if (subParts.length) {
    const sub = document.createElement('span')
    sub.className = 'recipe-row__sub'
    sub.textContent = subParts.join(' · ')
    centre.appendChild(sub)
  }

  // Heart toggle
  const heart = buildHeart(recipe)

  row.append(emojiEl, centre, heart)

  // Tap body → recipe detail
  row.addEventListener('click', () => {
    navState.recipeId = recipe.id
    navigateTo('recipe-detail')
  })

  return row
}

function buildHeart(recipe) {
  const btn = document.createElement('button')
  btn.className = 'recipe-row__heart' + (recipe.is_preferred ? ' recipe-row__heart--on' : '')
  btn.setAttribute('aria-label', recipe.is_preferred ? 'Remove favourite' : 'Add to favourites')
  btn.innerHTML = heartSvg(recipe.is_preferred)

  btn.addEventListener('click', async e => {
    e.stopPropagation()
    recipe.is_preferred = !recipe.is_preferred
    btn.className = 'recipe-row__heart' + (recipe.is_preferred ? ' recipe-row__heart--on' : '')
    btn.innerHTML = heartSvg(recipe.is_preferred)
    btn.setAttribute('aria-label', recipe.is_preferred ? 'Remove favourite' : 'Add to favourites')
    await supabase.from('recipes').update({ is_preferred: recipe.is_preferred }).eq('id', recipe.id)
  })

  return btn
}

// ── Helpers ───────────────────────────────────────────────
function fmtMethod(m) {
  return ({
    slow_cook:   'Slow cook',
    oven:        'Oven',
    stovetop:    'Stovetop',
    instant_pot: 'Instant Pot',
    grill:       'Grill',
    no_cook:     'No cook',
  })[m] || m
}

function heartSvg(filled) {
  return filled
    ? `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
         <path d="M11.645 20.91l-.007-.003-.022-.012a15.247 15.247 0 0 1-.383-.218 25.18 25.18 0 0 1-4.244-3.17C4.688 15.36 2.25 12.174 2.25 8.25 2.25 5.322 4.714 3 7.688 3A5.5 5.5 0 0 1 12 5.052 5.5 5.5 0 0 1 16.313 3c2.973 0 5.437 2.322 5.437 5.25 0 3.925-2.438 7.111-4.739 9.256a25.175 25.175 0 0 1-4.244 3.17 15.247 15.247 0 0 1-.383.219l-.022.012-.007.004-.003.001a.752.752 0 0 1-.704 0l-.003-.001Z"/>
       </svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
         <path stroke-linecap="round" stroke-linejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z"/>
       </svg>`
}

import { supabase, navigateTo, navState, mkFab } from '../app.js'

// ── Section config ────────────────────────────────────────
const SECTIONS = [
  { type: 'breakfast',    label: 'Breakfast',       defaultEmoji: '🍳',  open: true  },
  { type: 'lunch_dinner', label: 'Dinner/Lunch',    defaultEmoji: '🍽️', open: true  },
  { type: 'snack',        label: 'Snacks',           defaultEmoji: '🍎',  open: false },
  { type: 'special',      label: 'Special Occasion', defaultEmoji: '🎉',  open: false },
]

// ── State ─────────────────────────────────────────────────
let allRecipes      = []
let inactiveRecipes = []
let stashMap        = {}
let nextPlanByRecipe = new Map()  // recipe_id → earliest upcoming plan_date
let screenEl        = null
let showInactive    = false
let recipeSearch    = ''          // name filter across all sections
const openState     = {}

// ── Lifecycle ─────────────────────────────────────────────
export function init(el) {
  screenEl = el
  SECTIONS.forEach(s => { openState[s.type] = s.open })
}

export async function activate({ headerLeft, headerRight }) {
  if (!screenEl) return
  headerRight.innerHTML = ''   // adding a recipe is now the standard FAB
  screenEl.innerHTML = `<div class="loading-row"><div class="spinner"></div>Loading recipes…</div>`
  await loadData()
  render()
}

// ── Data ──────────────────────────────────────────────────
async function loadData() {
  const d = new Date()
  const todayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const [recipeRes, inactiveRes, stashRes, upcomingRes] = await Promise.all([
    supabase.from('recipes')
      .select('id, name, meal_type, is_preferred, ease_descriptor, emoji, active, last_made, prep_time_min, cook_time_min')
      .eq('active', true).or('is_placeholder.is.null,is_placeholder.eq.false').order('name'),
    supabase.from('recipes')
      .select('id, name, meal_type, emoji')
      .eq('active', false).or('is_placeholder.is.null,is_placeholder.eq.false').order('name'),
    supabase.from('freezer_stash')
      .select('recipe_id, portions').eq('used', false),
    // Upcoming scheduled slots (today forward). Read both recipe_id and
    // actual_recipe_id so swaps are attributed to the recipe actually in the
    // slot, not the one that was replaced.
    supabase.from('meal_plans')
      .select('recipe_id, actual_recipe_id, plan_date').gte('plan_date', todayStr)
      .order('plan_date'),
  ])

  allRecipes      = recipeRes.data   || []
  inactiveRecipes = inactiveRes.data || []

  // The effective recipe for a slot is the substitute if one was set, else the
  // planned recipe. A swapped-out original gets no credit; the substitute does.
  // recipe_id → earliest upcoming plan_date (rows arrive ordered ascending).
  nextPlanByRecipe = new Map()
  for (const row of (upcomingRes.data || [])) {
    const eff = row.actual_recipe_id || row.recipe_id
    if (eff && !nextPlanByRecipe.has(eff)) nextPlanByRecipe.set(eff, row.plan_date)
  }

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

  // Minimal search box (same treatment as the Inventory search). Only the list
  // re-renders on input, so focus/caret are kept.
  const searchWrap = document.createElement('div')
  searchWrap.className = 'pn-inv-searchwrap'
  const search = document.createElement('input')
  search.type = 'search'; search.className = 'pn-inv-search'
  search.placeholder = 'Search recipes…'; search.value = recipeSearch
  const icon = document.createElement('span')
  icon.className = 'pn-inv-search-icon'
  icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>'
  searchWrap.append(search, icon)
  screenEl.appendChild(searchWrap)

  const listEl = document.createElement('div')
  search.addEventListener('input', () => { recipeSearch = search.value; renderRecipeList(listEl) })
  screenEl.appendChild(listEl)
  renderRecipeList(listEl)

  renderFooter()

  screenEl.appendChild(mkFab(() => navigateTo('add-recipe'), 'Add recipe'))

  // Restore scroll when returning from Recipe Detail (back navigation).
  if (navState.scrollRecipes != null) {
    const top = navState.scrollRecipes; navState.scrollRecipes = null
    requestAnimationFrame(() => { screenEl.scrollTop = top })
  }
}

// Fills the list container, filtered by the search box. While searching,
// sections auto-open so matches are visible (without mutating saved open state).
function renderRecipeList(listEl) {
  listEl.innerHTML = ''
  const q = recipeSearch.trim().toLowerCase()
  let hasAny = false
  for (const section of SECTIONS) {
    let recipes = allRecipes.filter(r => r.meal_type === section.type)
    if (q) recipes = recipes.filter(r => (r.name || '').toLowerCase().includes(q))
    if (!recipes.length) continue
    hasAny = true
    listEl.appendChild(buildSection(section, recipes, !!q))
  }
  if (!hasAny) {
    const wrap = document.createElement('div')
    wrap.className = 'placeholder-wrap'
    wrap.innerHTML = q
      ? `<p class="placeholder-label">No matching recipes</p><p class="placeholder-sub">Try a different search</p>`
      : `<p class="placeholder-label">No recipes yet</p><p class="placeholder-sub">Tap + to add your first recipe</p>`
    listEl.appendChild(wrap)
  }
}

function renderFooter() {
  if (!screenEl) return
  screenEl.querySelector('#recipes-footer')?.remove()
  if (inactiveRecipes.length === 0) return

  const footer = document.createElement('div')
  footer.id = 'recipes-footer'

  const toggleBtn = document.createElement('button')
  toggleBtn.className = 'pn-hidden-toggle'
  toggleBtn.textContent = showInactive
    ? 'Hide inactive recipes'
    : `Show inactive recipes (${inactiveRecipes.length})`
  toggleBtn.addEventListener('click', () => {
    showInactive = !showInactive
    renderFooter()
  })
  footer.appendChild(toggleBtn)

  if (showInactive) {
    const label = document.createElement('div')
    label.className = 'section-label'
    label.textContent = `Inactive (${inactiveRecipes.length})`
    footer.appendChild(label)

    const card = document.createElement('div')
    card.className = 'card'
    card.style.margin = '0 16px 8px'
    inactiveRecipes.forEach((recipe, i) => {
      const row = buildInactiveRow(recipe)
      if (i < inactiveRecipes.length - 1) row.classList.add('recipe-row--ruled')
      card.appendChild(row)
    })
    footer.appendChild(card)
  }

  screenEl.appendChild(footer)
}

function buildSection(section, recipes, forceOpen = false) {
  const isOpen = forceOpen || openState[section.type]
  const wrap = document.createElement('div')
  wrap.className = 'recipe-section'

  const header = document.createElement('button')
  header.className = 'recipe-section__header'
  header.setAttribute('aria-expanded', String(isOpen))
  header.dataset.mealType = section.type
  header.innerHTML = `
    <span class="recipe-section__label">
      ${section.label}
      <span class="recipe-section__count">(${recipes.length})</span>
    </span>
    <svg class="recipe-section__chevron${isOpen ? ' recipe-section__chevron--open' : ''}"
         viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path stroke-linecap="round" stroke-linejoin="round" d="m19 9-7 7-7-7"/>
    </svg>`

  const body = document.createElement('div')
  body.className = 'recipe-section__body' + (isOpen ? '' : ' recipe-section__body--hidden')

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

  const emojiEl = document.createElement('div')
  emojiEl.className = 'recipe-row__emoji'
  emojiEl.setAttribute('aria-hidden', 'true')
  emojiEl.textContent = recipe.emoji || fallbackEmoji

  const centre = document.createElement('div')
  centre.className = 'recipe-row__centre'
  const name = document.createElement('span')
  name.className = 'recipe-row__name'
  name.textContent = recipe.name
  centre.appendChild(name)

  const subParts = []
  if (recipe.ease_descriptor) subParts.push(recipe.ease_descriptor)
  // Forward-looking (next planned) wins over backward-looking (last served).
  subParts.push(dateContextLabel(nextPlanByRecipe.get(recipe.id) || null, recipe.last_made))
  const active = fmtActiveTime(recipe.prep_time_min, recipe.cook_time_min)
  if (active) subParts.push(active)
  if (portions > 0)           subParts.push(`🧊 ${portions}`)
  if (subParts.length) {
    const sub = document.createElement('span')
    sub.className = 'recipe-row__sub'
    sub.textContent = subParts.join(' · ')
    centre.appendChild(sub)
  }

  const heart = buildHeart(recipe)
  const dots  = buildDots(recipe, row)

  row.append(emojiEl, centre, heart, dots)

  row.addEventListener('click', () => {
    navState.recipeId = recipe.id
    navState.recipeFrom = 'recipes'
    navState.scrollRecipes = screenEl?.scrollTop ?? 0
    navigateTo('recipe-detail')
  })

  return row
}

function buildInactiveRow(recipe) {
  const row = document.createElement('div')
  row.className = 'recipe-row recipe-row--inactive'

  const emojiEl = document.createElement('div')
  emojiEl.className = 'recipe-row__emoji'
  emojiEl.setAttribute('aria-hidden', 'true')
  emojiEl.textContent = recipe.emoji || '🍽️'

  const centre = document.createElement('div')
  centre.className = 'recipe-row__centre'
  const name = document.createElement('span')
  name.className = 'recipe-row__name'
  name.textContent = recipe.name
  centre.appendChild(name)
  const sectionLabel = SECTIONS.find(s => s.type === recipe.meal_type)?.label
  if (sectionLabel) {
    const sub = document.createElement('span')
    sub.className = 'recipe-row__sub'
    sub.textContent = sectionLabel
    centre.appendChild(sub)
  }

  const btn = document.createElement('button')
  btn.className = 'pn-unhide-btn'
  btn.textContent = 'Reactivate'
  btn.addEventListener('click', e => {
    e.stopPropagation()
    reactivateRecipe(recipe, row)
  })

  row.append(emojiEl, centre, btn)
  return row
}

// ── Dots / dropdown ───────────────────────────────────────
let activeDropdown = null

function closeDropdown() {
  if (activeDropdown) { activeDropdown.remove(); activeDropdown = null }
}

function openDropdown(anchorBtn, items) {
  closeDropdown()

  const menu = document.createElement('div')
  menu.className = 'recipe-dropdown'
  items.forEach(({ label, danger, onClick }) => {
    const btn = document.createElement('button')
    btn.className = 'recipe-dropdown__item' + (danger ? ' recipe-dropdown__item--danger' : '')
    btn.textContent = label
    btn.addEventListener('click', e => { e.stopPropagation(); closeDropdown(); onClick() })
    menu.appendChild(btn)
  })

  document.body.appendChild(menu)
  activeDropdown = menu

  const rect = anchorBtn.getBoundingClientRect()
  menu.style.top   = (rect.bottom + 4) + 'px'
  menu.style.right = (window.innerWidth - rect.right) + 'px'

  // close on next outside tap
  setTimeout(() => document.addEventListener('click', closeDropdown, { once: true }), 0)
}

function buildDots(recipe, row) {
  const btn = document.createElement('button')
  btn.className = 'recipe-row__dots'
  btn.setAttribute('aria-label', 'More options')
  btn.innerHTML = `<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" width="16" height="16">
    <circle cx="4" cy="10" r="1.5"/><circle cx="10" cy="10" r="1.5"/><circle cx="16" cy="10" r="1.5"/>
  </svg>`
  btn.addEventListener('click', e => {
    e.stopPropagation()
    openDropdown(btn, [
      { label: 'Deactivate', danger: true, onClick: () => deactivateRecipe(recipe, row) },
    ])
  })
  return btn
}

// ── Deactivate / Reactivate ───────────────────────────────
async function deactivateRecipe(recipe, row) {
  row.style.opacity = '0.4'
  row.style.pointerEvents = 'none'

  const { error } = await supabase.from('recipes').update({ active: false }).eq('id', recipe.id)
  if (error) {
    row.style.opacity = ''
    row.style.pointerEvents = ''
    return
  }

  allRecipes      = allRecipes.filter(r => r.id !== recipe.id)
  inactiveRecipes = [...inactiveRecipes, { id: recipe.id, name: recipe.name, meal_type: recipe.meal_type, emoji: recipe.emoji }]
    .sort((a, b) => a.name.localeCompare(b.name))

  // Update the section count badge without re-rendering the section
  const sectionHeader = screenEl?.querySelector(`[data-meal-type="${recipe.meal_type}"]`)
  const countEl = sectionHeader?.querySelector('.recipe-section__count')
  if (countEl) {
    const n = parseInt(countEl.textContent.replace(/[()]/g, '')) || 0
    countEl.textContent = `(${Math.max(0, n - 1)})`
  }

  // Animate out then remove
  row.style.transition = 'opacity 0.15s'
  row.style.opacity = '0'
  setTimeout(() => { row.remove(); renderFooter() }, 150)
}

async function reactivateRecipe(recipe, row) {
  row.style.opacity = '0.4'
  row.style.pointerEvents = 'none'

  const { error } = await supabase.from('recipes').update({ active: true }).eq('id', recipe.id)
  if (error) {
    row.style.opacity = ''
    row.style.pointerEvents = ''
    return
  }

  await loadData()
  render()
}

// ── Heart ─────────────────────────────────────────────────
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
// Forward- and backward-looking date context for a recipe card:
//   next planned (wins) → "on the menu today" / "tomorrow" / "in X days"
//   else last served    → "served yesterday" / "served X days/weeks/months ago"
//   6+ months ago        → "pretend you never made it"
//   neither              → "never made"
function dateContextLabel(nextDate, lastMade) {
  const today = new Date(); today.setHours(0, 0, 0, 0)

  if (nextDate) {
    const nd = new Date(nextDate + 'T00:00:00'); nd.setHours(0, 0, 0, 0)
    const x = Math.round((nd - today) / 86400000)
    if (x <= 0) return 'on the menu today'
    if (x === 1) return 'tomorrow'
    return `in ${x} days`
  }

  if (lastMade) {
    const lm = new Date(lastMade + 'T00:00:00'); lm.setHours(0, 0, 0, 0)
    const sixMonthsAgo = new Date(today); sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6)
    if (lm < sixMonthsAgo) return 'pretend you never made it'
    const d = Math.round((today - lm) / 86400000)
    if (d <= 0) return 'served today'
    if (d === 1) return 'served yesterday'
    if (d <= 6) return `served ${d} days ago`
    if (d <= 29) { const w = Math.round(d / 7); return `served ${w} week${w !== 1 ? 's' : ''} ago` }
    const m = Math.round(d / 30); return `served ${m} month${m !== 1 ? 's' : ''} ago`
  }

  return 'never made'
}

// prep + cook combined active time; omit when neither is set.
function fmtActiveTime(prep, cook) {
  if (prep == null && cook == null) return null
  const t = (Number(prep) || 0) + (Number(cook) || 0)
  return t > 0 ? `${t} min` : null
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

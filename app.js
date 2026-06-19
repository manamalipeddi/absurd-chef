import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── Supabase client ──────────────────────────────────────
export const supabase = createClient(
  'https://tsigszlaklspuankhztx.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRzaWdzemxha2xzcHVhbmtoenR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE1OTQ0NTYsImV4cCI6MjA5NzE3MDQ1Nn0.i3M3rETJTYPgHdomAQmAyp0v2uxqVBF__8FUhPVbHhw'
)

export const FUNCTIONS_URL = 'https://tsigszlaklspuankhztx.supabase.co/functions/v1'

// Shared state for passing data between screens (e.g. recipe detail target)
export const navState = {}

// ── Screen registry ──────────────────────────────────────
const SCREENS = {
  pantry:         { title: 'Pantry',        module: './screens/pantry.js' },
  recipes:        { title: 'Recipes',       module: './screens/recipes.js' },
  plan:           { title: 'This Week',     module: './screens/plan.js' },
  chat:           { title: 'AbsurdChef',    module: './screens/chat.js' },
  setup:          { title: 'Setup',         module: './screens/setup.js' },
  'recipe-detail':{ title: '',              module: './screens/recipe-detail.js' },
  'add-recipe':   { title: 'Add Recipe',   module: './screens/add-recipe.js' },
}

const loaded        = new Set()
const screenModules = {}

// ── DOM refs ─────────────────────────────────────────────
const screenTitle = document.getElementById('screen-title')
const headerLeft  = document.getElementById('header-left')
const headerRight = document.getElementById('header-right')
const navBtns     = document.querySelectorAll('.nav-btn')

// ── Navigation ───────────────────────────────────────────
let currentScreen = 'plan'

export async function navigateTo(id) {
  if (id === currentScreen && loaded.has(id)) {
    // Already here — just re-activate (refresh data)
    const mod = screenModules[id]
    if (mod?.activate) await mod.activate({ headerLeft, headerRight })
    return
  }

  document.getElementById(`screen-${currentScreen}`).classList.remove('screen--active')
  document.getElementById(`screen-${id}`).classList.add('screen--active')
  // Only flip nav highlight for top-level screens that have a nav button
  if (document.querySelector(`.nav-btn[data-screen="${id}"]`)) {
    navBtns.forEach(b => b.classList.toggle('nav-btn--active', b.dataset.screen === id))
  }
  screenTitle.textContent = SCREENS[id].title
  headerLeft.innerHTML  = ''
  headerRight.innerHTML = ''
  currentScreen = id

  if (!loaded.has(id)) {
    loaded.add(id)
    try {
      const mod = await import(SCREENS[id].module)
      screenModules[id] = mod
      // init: one-time DOM setup (create elements, register listeners)
      if (mod.init) await mod.init(document.getElementById(`screen-${id}`))
    } catch (e) {
      console.warn(`Screen ${id} failed to load`, e)
    }
  }

  // activate: called every visit — sets header buttons + refreshes data
  const mod = screenModules[id]
  if (mod?.activate) await mod.activate({ headerLeft, headerRight })
}

navBtns.forEach(btn =>
  btn.addEventListener('click', () => navigateTo(btn.dataset.screen))
)

// ── Toast ─────────────────────────────────────────────────
const toastContainer = document.createElement('div')
toastContainer.id = 'toast-container'
document.body.appendChild(toastContainer)

export function toast(msg, { error = false, duration = 3000 } = {}) {
  const el = document.createElement('div')
  el.className = 'toast' + (error ? ' toast--error' : '')
  el.textContent = msg
  toastContainer.prepend(el)
  setTimeout(() => el.remove(), duration)
}

// ── Boot ──────────────────────────────────────────────────
async function boot() {
  // Load initial screen
  await navigateTo('plan')

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {})
  }
}

boot()

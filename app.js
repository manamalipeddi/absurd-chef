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
  pantry:                  { title: 'Pantry',           module: './screens/pantry.js' },
  recipes:                 { title: 'Recipes',          module: './screens/recipes.js' },
  plan:                    { title: "Absurd Chef's Plan", module: './screens/plan.js' },
  chat:                    { title: 'Absurd Chef',      module: './screens/chat.js' },
  setup:                   { title: 'Setup',            module: './screens/setup.js' },
  'setup-family':          { title: 'Family',           module: './screens/setup-family.js' },
  'setup-weekly-template': { title: 'Weekly Template',  module: './screens/setup-weekly-template.js' },
  'setup-day-settings':    { title: 'Day Settings',     module: './screens/setup-day-settings.js' },
  'setup-preschool-menu':  { title: 'Preschool Menu',   module: './screens/setup-preschool-menu.js' },
  'setup-ingredients':     { title: 'Ingredients',      module: './screens/setup-ingredients.js' },
  'recipe-detail':         { title: '',                 module: './screens/recipe-detail.js' },
  'add-recipe':            { title: 'Add Recipe',       module: './screens/add-recipe.js' },
}

const loaded        = new Set()
const screenModules = {}

// ── DOM refs ─────────────────────────────────────────────
const screenTitle = document.getElementById('screen-title')
const headerLeft  = document.getElementById('header-left')
const headerRight = document.getElementById('header-right')
const navBtns     = document.querySelectorAll('.nav-btn')

// ── Navigation (history-aware) ───────────────────────────
// Every screen change pushes a real browser-history entry and every modal
// pushes one too, so the OS/browser Back gesture steps back through the app's
// own navigation (one level at a time) instead of exiting the PWA.
let currentScreen = 'plan'
const modalStack = []      // { el, onClose } — topmost last
let suppressPop = false     // set when WE call history.back() ourselves

// Swap the visible screen + (lazy) load + activate. No history side-effects.
async function applyScreen(id) {
  if (id === currentScreen && loaded.has(id)) {
    const mod = screenModules[id]
    if (mod?.activate) await mod.activate({ headerLeft, headerRight })
    return
  }
  document.getElementById(`screen-${currentScreen}`)?.classList.remove('screen--active')
  document.getElementById(`screen-${id}`)?.classList.add('screen--active')
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
      if (mod.init) await mod.init(document.getElementById(`screen-${id}`))
    } catch (e) {
      console.warn(`Screen ${id} failed to load`, e)
    }
  }
  const mod = screenModules[id]
  if (mod?.activate) await mod.activate({ headerLeft, headerRight })
}

// Forward navigation (user action): push a history entry, then show the screen.
// { replace:true } swaps the current entry instead of pushing — used when a
// flow shouldn't be re-reachable by Back (e.g. after saving from a form).
export async function navigateTo(id, { replace = false } = {}) {
  if (id === currentScreen && loaded.has(id) && !modalStack.length) {
    await applyScreen(id)   // re-activate / refresh in place
    return
  }
  const leaving = screenModules[currentScreen]
  if (leaving?.canLeave && !leaving.canLeave()) return
  history[replace ? 'replaceState' : 'pushState']({ screen: id }, '')
  await applyScreen(id)
}

// Modal/picker/bottom-sheet history integration. Caller appends `el` to the DOM
// and passes how to dismiss it; opening pushes a history entry so Back closes
// just the modal. Manual closes must go through closeModal() to stay balanced.
export function openModal(el, onClose) {
  modalStack.push({ el, onClose })
  history.pushState({ modal: true }, '')
}
export function closeModal(el) {
  const idx = modalStack.findIndex(m => m.el === el)
  if (idx === -1) { el.remove(); return }
  modalStack.splice(idx)           // drop this entry and any above it
  el.remove()
  suppressPop = true               // balance the pushed entry without re-closing
  history.back()
}

// In-place sub-views (a form that REPLACES a tab/list's content, not an overlay)
// also need a real history entry — otherwise Back/▷-swipe escapes the whole
// screen (e.g. Inventory edit → Recipes) instead of returning to the list. On
// open, register `onBack` (restores the underlying list); Back runs it. Call the
// returned .done() when the view is dismissed by its own UI (Cancel/Save) so the
// pushed entry is balanced without re-running onBack.
export function pushView(onBack) {
  const entry = { onClose: onBack }
  modalStack.push(entry)
  history.pushState({ modal: true }, '')
  return {
    done() {
      const i = modalStack.indexOf(entry)
      if (i === -1) return
      modalStack.splice(i)
      suppressPop = true
      history.back()
    },
  }
}

window.addEventListener('popstate', async (e) => {
  if (suppressPop) { suppressPop = false; return }
  // 1. A modal is open → Back closes just the top modal.
  if (modalStack.length) {
    const m = modalStack.pop()
    if (m.onClose) m.onClose(); else m.el.remove()
    return
  }
  // 2. Respect a screen's unsaved-changes veto (re-push to cancel the Back).
  const leaving = screenModules[currentScreen]
  if (leaving?.canLeave && !leaving.canLeave()) {
    history.pushState({ screen: currentScreen }, '')
    return
  }
  // 3. Step back to the previous screen.
  await applyScreen((e.state && e.state.screen) || 'plan')
})

navBtns.forEach(btn =>
  btn.addEventListener('click', () => navigateTo(btn.dataset.screen))
)

// ── Floating action button ────────────────────────────────
// Standard FAB: circular, fixed bottom-right above the nav, accent-green fill.
// Append it to a screen's (re-rendered) content so it hides with the screen and
// refreshes on re-render; wire onClick to that screen's existing add action.
export function mkFab(onClick, label = 'Add') {
  const b = document.createElement('button')
  b.className = 'fab'
  b.type = 'button'
  b.setAttribute('aria-label', label)
  b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`
  b.addEventListener('click', onClick)
  return b
}

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
  // Seed the initial history entry, then show the first screen without pushing.
  history.replaceState({ screen: 'plan' }, '')
  await applyScreen('plan')

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {})
  }
}

boot()

import { supabase, FUNCTIONS_URL, toast, navState } from '../app.js'

// ── State (persists across tab switches) ──────────────────
const messages   = []   // { role, content }  — sent to API
const bubbles    = []   // rendered DOM nodes — parallel array
let   greeted    = false
let   busy       = false
let   listEl     = null
let   inputEl    = null
let   sendBtn    = null

// ── Lifecycle ─────────────────────────────────────────────
export function init(el) {
  el.classList.add('chat-screen')

  // Message list
  listEl = document.createElement('div')
  listEl.id = 'chat-list'
  el.appendChild(listEl)

  // Input area
  const inputArea = document.createElement('div')
  inputArea.id = 'chat-input-area'
  inputArea.innerHTML = `
    <textarea id="chat-input" rows="1"
      placeholder="Ask me anything…"
      aria-label="Message AbsurdChef"></textarea>
    <button id="chat-send" aria-label="Send">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5"/>
      </svg>
    </button>`
  el.appendChild(inputArea)

  inputEl = document.getElementById('chat-input')
  sendBtn = document.getElementById('chat-send')

  // Auto-resize textarea
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto'
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px'
  })

  // Send on Enter (Shift+Enter = newline)
  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
  })

  sendBtn.addEventListener('click', sendMessage)
}

export async function activate({ headerLeft, headerRight }) {
  // Pre-fill input when arriving from Plan "Discuss this day" button
  if (navState.chatPrefill && inputEl) {
    inputEl.value = navState.chatPrefill
    inputEl.style.height = 'auto'
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px'
    navState.chatPrefill = null
    requestAnimationFrame(() => inputEl.focus())
  }
  if (!greeted) {
    greeted = true
    await showGreeting()
  }
}

// ── Greeting ──────────────────────────────────────────────
async function showGreeting() {
  const today = new Date().toISOString().slice(0, 10)
  const { data } = await supabase
    .from('meal_plans')
    .select('plan_date')
    .gte('plan_date', today)
    .order('plan_date')
    .limit(14)

  let greeting
  if (data?.length) {
    const first = fmtShort(data[0].plan_date)
    const last  = fmtShort(data[data.length - 1].plan_date)
    greeting = `Hi! I've got ${data.length} dinners planned for ${first} – ${last}. What do you need?`
  } else {
    greeting = `Hi! No plan yet — tap the ✨ on the Plan tab to generate one, then come back and ask me anything.`
  }

  appendBubble('assistant', greeting)
}

// ── Send ──────────────────────────────────────────────────
async function sendMessage() {
  const text = inputEl.value.trim()
  if (!text || busy) return

  inputEl.value = ''
  inputEl.style.height = 'auto'
  busy = true
  setSendState(false)

  messages.push({ role: 'user', content: text })
  appendBubble('user', text)

  const typingEl = showTyping()

  try {
    const res  = await fetch(`${FUNCTIONS_URL}/chat-agent`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ messages }),
    })
    const json = await res.json()
    typingEl.remove()

    messages.push({ role: 'assistant', content: json.message })
    const bubble = appendBubble('assistant', json.message)

    if (json.action) await handleAction(json.action, bubble)
  } catch (e) {
    typingEl.remove()
    appendBubble('assistant', 'Sorry, something went wrong. Try again.')
    toast('Chat error', { error: true })
  } finally {
    busy = false
    setSendState(true)
    inputEl.focus()
  }
}

// ── Action handling ───────────────────────────────────────
async function handleAction(action, afterEl) {
  if (action.type === 'override_day') {
    // Plan was already updated server-side — notify Plan screen to refresh
    document.dispatchEvent(new CustomEvent('plan-updated'))
    // Show change card
    const card = buildChangeCard(action)
    afterEl.insertAdjacentElement('afterend', card)
    scrollToBottom()
  }

  if (action.type === 'show_recipe') {
    const card = await buildRecipeCard(action)
    if (card) {
      afterEl.insertAdjacentElement('afterend', card)
      scrollToBottom()
    }
  }
}

// ── Bubble DOM ────────────────────────────────────────────
function appendBubble(role, text) {
  const wrap = document.createElement('div')
  wrap.className = `chat-bubble chat-bubble--${role}`

  const inner = document.createElement('div')
  inner.className = 'chat-bubble__inner'
  inner.textContent = text

  wrap.appendChild(inner)
  listEl.appendChild(wrap)
  bubbles.push(wrap)
  scrollToBottom()
  return wrap
}

function showTyping() {
  const wrap = document.createElement('div')
  wrap.className = 'chat-bubble chat-bubble--assistant'
  wrap.innerHTML = `<div class="chat-bubble__inner chat-typing">
    <span></span><span></span><span></span>
  </div>`
  listEl.appendChild(wrap)
  scrollToBottom()
  return wrap
}

// ── Action cards ──────────────────────────────────────────
function buildChangeCard(action) {
  const el = document.createElement('div')
  el.className = 'chat-card chat-card--change'
  const day = action.date ? fmtDay(action.date) : ''
  el.innerHTML = `
    <span class="chat-card__icon">✓</span>
    <div class="chat-card__body">
      <span class="chat-card__title">${day ? day + ' changed' : 'Plan updated'}</span>
      <span class="chat-card__sub">${action.recipe_name || ''}</span>
    </div>`
  return el
}

async function buildRecipeCard(action) {
  if (!action.recipe_id) return null
  const { data } = await supabase
    .from('recipes')
    .select('night_before, morning_of, when_cooking, the_scary_bit')
    .eq('id', action.recipe_id)
    .single()
  if (!data) return null

  const el = document.createElement('div')
  el.className = 'chat-card chat-card--recipe'

  const sections = [
    { key: 'night_before', label: 'Night before', icon: '🌙' },
    { key: 'morning_of',   label: 'Morning of',   icon: '☀️' },
    { key: 'when_cooking', label: 'When cooking',  icon: '🍳' },
  ]

  let html = `<div class="chat-card__recipe-title">${action.recipe_name}</div>`

  for (const { key, label, icon } of sections) {
    const steps = data[key]
    if (!steps?.length) continue
    html += `<div class="chat-card__recipe-section">
      <span class="chat-card__recipe-label">${icon} ${label}</span>
      <ul>${steps.map((s) => `<li>${s}</li>`).join('')}</ul>
    </div>`
  }

  if (data.the_scary_bit) {
    html += `<div class="chat-card__scary">
      <span>⚠️ The scary bit</span>
      <p>${data.the_scary_bit}</p>
    </div>`
  }

  el.innerHTML = html
  return el
}

// ── UI helpers ────────────────────────────────────────────
function setSendState(enabled) {
  if (sendBtn) sendBtn.disabled = !enabled
  if (inputEl) inputEl.disabled = !enabled
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    if (listEl) listEl.scrollTop = listEl.scrollHeight
  })
}

function fmtShort(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z')
  return d.toLocaleString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

function fmtDay(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z')
  return d.toLocaleString('en', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
}

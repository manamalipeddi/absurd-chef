import { supabase, FUNCTIONS_URL, toast, navState } from '../app.js'

// ── State (persists across tab switches) ──────────────────
let listEl          = null
let inputEl         = null
let sendBtn         = null
let busy            = false
let historyLoaded   = false
let oldestCreatedAt = null
let loadMoreBtn     = null

// ── Lifecycle ─────────────────────────────────────────────
export function init(el) {
  el.innerHTML = ''
  el.classList.add('chat-screen')

  listEl = document.createElement('div')
  listEl.id = 'chat-list'
  el.appendChild(listEl)

  const inputArea = document.createElement('div')
  inputArea.id = 'chat-input-area'
  inputArea.innerHTML = `
    <textarea id="chat-input" rows="1"
      placeholder="How can Absurd Chef help you?"
      aria-label="Message AbsurdChef"></textarea>
    <button id="chat-send" aria-label="Send">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5"/>
      </svg>
    </button>`
  el.appendChild(inputArea)

  inputEl = document.getElementById('chat-input')
  sendBtn = document.getElementById('chat-send')

  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto'
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px'
  })
  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
  })
  sendBtn.addEventListener('click', sendMessage)
}

export async function activate({ headerLeft, headerRight }) {
  headerLeft.innerHTML  = ''
  headerRight.innerHTML = ''

  if (navState.chatPrefill && inputEl) {
    inputEl.value = navState.chatPrefill
    inputEl.style.height = 'auto'
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px'
    navState.chatPrefill = null
    requestAnimationFrame(() => inputEl.focus())
  }

  if (!historyLoaded) {
    historyLoaded = true
    await loadHistory()
  }
}

// ── History loading ───────────────────────────────────────
async function loadHistory() {
  listEl.innerHTML = `<div class="loading-row"><div class="spinner"></div></div>`

  const { data } = await supabase
    .from('chat_history')
    .select('id, role, content, created_at')
    .in('role', ['user', 'assistant'])
    .order('created_at', { ascending: false })
    .limit(25)

  listEl.innerHTML = ''

  if (!data?.length) {
    showGreeting()
    return
  }

  const msgs = [...data].reverse()
  oldestCreatedAt = msgs[0].created_at

  // Check if there are older messages
  const { count } = await supabase
    .from('chat_history')
    .select('id', { count: 'exact', head: true })
    .in('role', ['user', 'assistant'])
    .lt('created_at', oldestCreatedAt)

  if ((count || 0) > 0) {
    loadMoreBtn = document.createElement('button')
    loadMoreBtn.className = 'chat-load-more'
    loadMoreBtn.textContent = 'Load earlier messages'
    loadMoreBtn.addEventListener('click', loadOlderMessages)
    listEl.appendChild(loadMoreBtn)
  }

  msgs.forEach(msg => appendBubble(msg.role, msg.content))
  scrollToBottom()
}

async function loadOlderMessages() {
  if (!oldestCreatedAt || !loadMoreBtn) return
  loadMoreBtn.textContent = 'Loading…'
  loadMoreBtn.disabled = true

  const { data } = await supabase
    .from('chat_history')
    .select('id, role, content, created_at')
    .in('role', ['user', 'assistant'])
    .lt('created_at', oldestCreatedAt)
    .order('created_at', { ascending: false })
    .limit(25)

  if (!data?.length) { loadMoreBtn.remove(); loadMoreBtn = null; return }

  const msgs = [...data].reverse()
  oldestCreatedAt = msgs[0].created_at

  const anchor = listEl.querySelector('.chat-bubble')
  msgs.forEach(msg => {
    listEl.insertBefore(createBubble(msg.role, msg.content), anchor)
  })

  const { count } = await supabase
    .from('chat_history')
    .select('id', { count: 'exact', head: true })
    .in('role', ['user', 'assistant'])
    .lt('created_at', oldestCreatedAt)

  if ((count || 0) > 0) {
    loadMoreBtn.textContent = 'Load earlier messages'
    loadMoreBtn.disabled = false
  } else {
    loadMoreBtn.remove()
    loadMoreBtn = null
  }
}

// ── Greeting (shown only when there is no prior history) ──
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

  appendBubble('user', text)
  const typingEl = showTyping()

  try {
    const res  = await fetch(`${FUNCTIONS_URL}/chat-agent`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ message: text }),
    })
    const json = await res.json()
    typingEl.remove()
    appendBubble('assistant', json.reply || json.message || 'Something went wrong.')
  } catch {
    typingEl.remove()
    appendBubble('assistant', 'Sorry, something went wrong. Try again.')
    toast('Chat error', { error: true })
  } finally {
    busy = false
    setSendState(true)
    inputEl.focus()
  }
}

// ── Bubble DOM ────────────────────────────────────────────
function createBubble(role, text) {
  const wrap  = document.createElement('div')
  wrap.className = `chat-bubble chat-bubble--${role}`
  const inner = document.createElement('div')
  inner.className = 'chat-bubble__inner'
  inner.innerHTML = renderText(text)
  wrap.appendChild(inner)
  return wrap
}

function appendBubble(role, text) {
  const wrap = createBubble(role, text)
  listEl.appendChild(wrap)
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

// ── Text rendering ────────────────────────────────────────
function renderText(text) {
  if (!text) return ''
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br>')
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

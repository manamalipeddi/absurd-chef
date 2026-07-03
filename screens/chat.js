import { supabase, FUNCTIONS_URL, toast, navState, setProcessing } from '../app.js'

// ── State (persists across tab switches) ──────────────────
let listEl          = null
let inputEl         = null
let sendBtn         = null
let busy            = false
let oldestCreatedAt = null
let loadMoreBtn     = null
// The most recent completed reply's processing log — re-attached after a
// DB-driven reload so the log survives navigating away from the chat and back.
let lastLog         = null   // { content, lines }

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

  // A disabled input swallows its own events, so listen on the (always-enabled)
  // input area: tapping anywhere in it while busy shows the "still working" tip.
  inputArea.addEventListener('pointerdown', () => { if (busy) showInputTooltip() })

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

  // Read the last messages from the DB on every mount, so a response that
  // completed server-side while away shows up on return. Skip only while a send
  // is in flight on this instance (the open stream is still updating the list).
  if (!busy) await loadHistory()
}

// ── History loading ───────────────────────────────────────
// Chronological asc; on an equal created_at (e.g. a user+reply pair saved in the
// same batch) the user message sorts before the assistant reply.
function sortChrono(rows) {
  return [...rows].sort((a, b) =>
    a.created_at < b.created_at ? -1 :
    a.created_at > b.created_at ? 1 :
    (a.role === 'user' ? -1 : 1))
}

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

  const msgs = sortChrono(data)
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

  // Re-attach the processing log to the most recent reply, so it doesn't vanish
  // when you leave the chat and come back (the log lives in memory, not the DB).
  const last = msgs[msgs.length - 1]
  if (lastLog && last?.role === 'assistant' && last.content === lastLog.content && lastLog.lines.length >= 2) {
    listEl.appendChild(buildLogToggle(lastLog.lines))
  }

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

  const msgs = sortChrono(data)
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
  // Cross-screen indicator: if the user navigates away, app.js shows a pill.
  setProcessing(true, 'Processing…')

  appendBubble('user', text)
  const statusEl = showStatus()
  const logEl    = statusEl.querySelector('.chat-status__log')
  const logLines = []                                   // {ts, label} — for the log toggle
  let lastLabel  = 'Reading your message…'
  const pushLine = (ts, label, isError) => {
    logLines.push({ ts: ts || '', label })
    addStatusLine(logEl, ts, label, isError)
  }
  // A failure mid inventory/order write needs a clearer, action-specific message.
  const isInventoryStep = () => /stock|inventor|order/i.test(lastLabel)
  const failMsg = () => isInventoryStep()
    ? 'Failed while updating inventory. Your order confirmation has not been fully processed. Try again or paste it again into the chat.'
    : `Something went wrong while ${lastLabel.replace(/…$/, '').toLowerCase()}. Try again or check the relevant tab.`

  try {
    const res = await fetch(`${FUNCTIONS_URL}/chat-agent`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      // tz_offset → status timestamps render in the user's local wall-clock time.
      body:    JSON.stringify({ message: text, tz_offset: new Date().getTimezoneOffset() }),
    })
    if (!res.ok || !res.body) throw new Error('stream unavailable')

    // Read the SSE stream: each status event APPENDS a timestamped line to the
    // growing log; done carries the full reply; error carries a where-it-failed
    // message.
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = '', replyText = null, streamErr = null, finished = false

    while (!finished) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const dataLine = buf.slice(0, i).split('\n').find(l => l.startsWith('data:'))
        buf = buf.slice(i + 2)
        if (!dataLine) continue
        let evt; try { evt = JSON.parse(dataLine.slice(5).trim()) } catch { continue }
        if (evt.type === 'status') {
          lastLabel = evt.label
          pushLine(evt.ts, evt.label)
          setProcessing(true, evt.label)          // keep the pill label current
        } else if (evt.type === 'done')  { replyText = evt.text || 'Done.'; finished = true }
        else if (evt.type === 'error')   { streamErr = evt.message || failMsg(); finished = true }
      }
    }

    if (replyText != null) {
      // Replace the whole status block with the reply, then keep a collapsed log.
      statusEl.remove()
      appendBubble('assistant', replyText)
      if (logLines.length >= 2) listEl.appendChild(buildLogToggle(logLines))
      // Remember it so a reload (after navigating away) can re-attach the log.
      lastLog = { content: replyText, lines: logLines.slice() }
      scrollToBottom()
    } else {
      // Errored (or stream ended without done): keep the log visible, stop the
      // dots, and append the failure line so the last successful step is shown.
      markStatusError(statusEl)
      pushLine('', streamErr || failMsg(), true)
    }
  } catch {
    markStatusError(statusEl)
    pushLine('', failMsg(), true)
    toast('Chat error', { error: true })
  } finally {
    busy = false
    setSendState(true)
    setProcessing(false)
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
  // Tap the bubble to copy its text (the raw message, so newlines/tables/markdown
  // survive). A manual text selection is left alone — only a plain tap copies.
  wrap.addEventListener('click', () => {
    const sel = window.getSelection && window.getSelection().toString()
    if (sel) return
    copyText(text)
  })
  return wrap
}

// Copy to clipboard with a fallback for webviews without the async Clipboard API.
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
    } else {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'; ta.style.top = '-1000px'; ta.style.opacity = '0'
      document.body.appendChild(ta); ta.focus(); ta.select()
      document.execCommand('copy'); ta.remove()
    }
    toast('Copied')
  } catch {
    toast('Copy failed', { error: true })
  }
}

function appendBubble(role, text) {
  const wrap = createBubble(role, text)
  listEl.appendChild(wrap)
  scrollToBottom()
  return wrap
}

// Live status block: animated dots (persist until done) above a GROWING
// timestamped log. Each status event appends a new line rather than replacing
// the previous one, so the user sees the whole trail of work.
function showStatus() {
  const wrap = document.createElement('div')
  wrap.className = 'chat-bubble chat-bubble--assistant chat-status'
  wrap.innerHTML = `<div class="chat-bubble__inner chat-status__inner">
    <span class="chat-typing"><span></span><span></span><span></span></span>
    <div class="chat-status__log"></div>
  </div>`
  listEl.appendChild(wrap)
  scrollToBottom()
  return wrap
}

// Append one "HH:MM:SS  label" row to a log container.
function addStatusLine(logEl, ts, label, isError) {
  if (!logEl) return
  const line = document.createElement('div')
  line.className = 'chat-status__line' + (isError ? ' chat-status__line--error' : '')
  const t = document.createElement('span'); t.className = 'chat-status__ts';   t.textContent = ts || ''
  const x = document.createElement('span'); x.className = 'chat-status__text'; x.textContent = label
  line.append(t, x)
  logEl.appendChild(line)
  scrollToBottom()
}

// On error: stop the animated dots but keep the log + the appended error line,
// so the block shows the last successful step and where it failed.
function markStatusError(statusEl) {
  statusEl.classList.add('chat-status--error')
  statusEl.querySelector('.chat-typing')?.remove()
}

// Collapsed "Show processing log" control shown under a completed reply.
function buildLogToggle(logLines) {
  const wrap = document.createElement('div')
  wrap.className = 'chat-log-wrap'
  const btn = document.createElement('button')
  btn.className = 'chat-log-toggle'
  btn.textContent = 'Show processing log'
  const log = document.createElement('div')
  log.className = 'chat-log'
  log.hidden = true
  logLines.forEach(l => addStatusLine(log, l.ts, l.label))
  btn.addEventListener('click', () => {
    log.hidden = !log.hidden
    btn.textContent = log.hidden ? 'Show processing log' : 'Hide processing log'
    if (!log.hidden) scrollToBottom()
  })
  wrap.append(btn, log)
  return wrap
}

// Brief "still working" tip when the user taps the disabled input mid-request.
let tooltipTimer = null
function showInputTooltip() {
  let tip = document.getElementById('chat-input-tooltip')
  if (!tip) {
    tip = document.createElement('div')
    tip.id = 'chat-input-tooltip'
    tip.textContent = 'Still working on your last message'
    document.getElementById('chat-input-area')?.appendChild(tip)
  }
  tip.classList.add('visible')
  clearTimeout(tooltipTimer)
  tooltipTimer = setTimeout(() => tip && tip.classList.remove('visible'), 1600)
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
  if (inputEl) {
    inputEl.disabled = !enabled
    inputEl.placeholder = enabled ? 'How can Absurd Chef help you?' : 'Processing — please wait…'
  }
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

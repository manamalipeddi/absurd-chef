import { supabase, toast, pushView } from '../app.js'

// One consolidated reference-data screen for the five managed recipe vocabularies.
// List (active, with usage count) → edit (rename + propagate, deactivate) →
// Show-hidden / Reactivate. Same pattern as the Ingredients screen.
const KINDS = [
  { kind: 'tag',            table: 'recipe_tags',            label: 'Tags',            field: 'tags',           isArray: true },
  { kind: 'cuisine',        table: 'recipe_cuisines',        label: 'Cuisines',        field: 'cuisine' },
  { kind: 'cooking_method', table: 'recipe_cooking_methods', label: 'Cooking Methods', field: 'cooking_method' },
  { kind: 'protein',        table: 'recipe_proteins',        label: 'Proteins',        field: 'protein' },
  { kind: 'style',          table: 'recipe_styles',          label: 'Styles',          field: 'style' },
]

let screenEl = null
let vocab    = {}                 // kind -> rows [{id, name, active}]
let recipes  = []                 // active recipes (for usage counts)
let showHidden = {}               // kind -> bool
let formView = null

export function init(el) { screenEl = el }

export async function activate({ headerLeft, headerRight }) {
  headerLeft.innerHTML = backBtn('ref-back')
  headerRight.innerHTML = ''
  document.getElementById('ref-back').addEventListener('click', () => history.back())
  showHidden = {}
  formView = null
  await load()
  renderList()
}

async function load() {
  const results = await Promise.all([
    ...KINDS.map(k => supabase.from(k.table).select('id, name, active').order('name')),
    supabase.from('recipes').select('tags, cuisine, cooking_method, protein, style').eq('active', true),
  ])
  KINDS.forEach((k, i) => { vocab[k.kind] = results[i].data || [] })
  recipes = results[results.length - 1].data || []
}

function usageCount(cfg, name) {
  if (cfg.isArray) return recipes.filter(r => (r.tags || []).includes(name)).length
  return recipes.filter(r => r[cfg.field] === name).length
}

async function backToList() { formView = null; await load(); renderList() }
function closeForm() { const h = formView; formView = null; if (h) h.done(); load().then(renderList) }

// ── List ──────────────────────────────────────────────────
function renderList() {
  screenEl.innerHTML = ''
  for (const cfg of KINDS) screenEl.appendChild(buildSection(cfg))
}

function buildSection(cfg) {
  const wrap = document.createElement('div')
  wrap.className = 'su-ref-section'

  const heading = document.createElement('div')
  heading.className = 'su-ref-heading'
  heading.textContent = cfg.label
  wrap.appendChild(heading)

  const rows = vocab[cfg.kind] || []
  const active = rows.filter(r => r.active !== false)
  const hidden = rows.filter(r => r.active === false)

  if (!active.length) {
    wrap.appendChild(mkEmpty(`No ${cfg.label.toLowerCase()} yet.`))
  } else {
    const card = document.createElement('div')
    card.className = 'card su-card'
    active.forEach((row, i) => card.appendChild(buildRow(cfg, row, i < active.length - 1)))
    wrap.appendChild(card)
  }

  if (hidden.length) wrap.appendChild(buildHidden(cfg, hidden))
  return wrap
}

function buildRow(cfg, row, ruled) {
  const el = document.createElement('div')
  el.className = 'su-list-row su-mi-row' + (ruled ? ' su-list-row--ruled' : '')
  const centre = document.createElement('div'); centre.className = 'su-mi-line'
  const main = document.createElement('span'); main.className = 'su-list-row__main'; main.textContent = row.name
  const n = usageCount(cfg, row.name)
  const count = document.createElement('span'); count.className = 'su-mi-count'
  count.textContent = n ? `· ${n} recipe${n !== 1 ? 's' : ''}` : '· unused'
  centre.append(main, count)
  el.appendChild(centre)
  el.addEventListener('click', () => openEdit(cfg, row))
  return el
}

function buildHidden(cfg, hidden) {
  const frag = document.createElement('div')
  const toggle = document.createElement('button')
  toggle.className = 'pn-hidden-toggle'
  const open = !!showHidden[cfg.kind]
  toggle.textContent = `${open ? 'Hide' : 'Show'} ${hidden.length} hidden`
  toggle.addEventListener('click', () => { showHidden[cfg.kind] = !open; renderList() })
  frag.appendChild(toggle)

  if (open) {
    const card = document.createElement('div')
    card.className = 'card pn-hidden-card'
    hidden.forEach((row, i) => {
      const el = document.createElement('div')
      el.className = 'su-list-row' + (i < hidden.length - 1 ? ' su-list-row--ruled' : '')
      const centre = document.createElement('div'); centre.className = 'su-list-row__centre'
      const main = document.createElement('div'); main.className = 'su-list-row__main'; main.textContent = row.name
      centre.appendChild(main)
      const reBtn = document.createElement('button')
      reBtn.className = 'su-reactivate-btn'; reBtn.textContent = 'Reactivate'
      reBtn.addEventListener('click', async (e) => {
        e.stopPropagation()
        await supabase.from(cfg.table).update({ active: true }).eq('id', row.id)
        toast('Reactivated')
        await load(); renderList()
      })
      el.append(centre, reBtn)
      card.appendChild(el)
    })
    frag.appendChild(card)
  }
  return frag
}

// ── Edit (rename + deactivate) ────────────────────────────
function openEdit(cfg, row) {
  screenEl.innerHTML = ''
  formView = pushView(() => backToList())

  const form = document.createElement('div')
  form.className = 'su-form'

  const nameInp = mkInput('text', row.name, '')
  form.append(mkField(`${cfg.label.replace(/s$/, '')} name *`, nameInp))

  const { save, cancel } = mkActions()
  cancel.addEventListener('click', () => closeForm())
  save.addEventListener('click', async () => {
    const newName = nameInp.value.trim()
    if (!newName) { toast('Name is required', { error: true }); return }
    if (newName === row.name) { closeForm(); return }
    save.disabled = true; save.textContent = 'Saving…'
    // Atomic rename + propagate to existing recipes (single RPC transaction).
    const { error } = await supabase.rpc('rename_recipe_vocab', {
      kind: cfg.kind, old_name: row.name, new_name: newName,
    })
    if (error) {
      toast(/duplicate|unique/i.test(error.message) ? 'That name already exists' : 'Rename failed', { error: true })
      save.disabled = false; save.textContent = 'Save'; return
    }
    toast('Renamed')
    closeForm()
  })
  const actions = document.createElement('div'); actions.className = 'su-actions'
  actions.append(cancel, save)
  form.appendChild(actions)

  // Usage + deactivate
  const n = usageCount(cfg, row.name)
  const used = document.createElement('p')
  used.className = 'su-hint'
  used.textContent = n ? `Used in ${n} recipe${n !== 1 ? 's' : ''}.` : 'Not used by any active recipe.'
  form.appendChild(used)

  const danger = document.createElement('div'); danger.className = 'su-danger-zone'
  const btn = document.createElement('button'); btn.className = 'su-deactivate-btn'; btn.textContent = 'Deactivate'
  btn.addEventListener('click', async () => {
    if (n > 0) {
      const ok = confirm(`This ${cfg.label.replace(/s$/, '').toLowerCase()} is used in ${n} recipe${n !== 1 ? 's' : ''}. Deactivating it won't remove it from those recipes, but it will no longer appear as an option for new recipes. Continue?`)
      if (!ok) return
    }
    btn.disabled = true
    const { error } = await supabase.from(cfg.table).update({ active: false }).eq('id', row.id)
    if (error) { toast('Failed', { error: true }); btn.disabled = false; return }
    toast(`${row.name} deactivated`)
    closeForm()
  })
  danger.appendChild(btn)
  form.appendChild(danger)

  screenEl.appendChild(form)
}

// ── Helpers ───────────────────────────────────────────────
function mkInput(type, value, placeholder) {
  const el = document.createElement('input')
  el.type = type; el.className = 'su-input'; el.value = value
  if (placeholder) el.placeholder = placeholder
  return el
}
function mkField(label, input) {
  const w = document.createElement('div'); w.className = 'su-field'
  const l = document.createElement('label'); l.className = 'su-label'; l.textContent = label
  w.append(l, input); return w
}
function mkActions() {
  const save = document.createElement('button'); save.className = 'su-btn-primary'; save.textContent = 'Save'
  const cancel = document.createElement('button'); cancel.className = 'su-btn-ghost'; cancel.textContent = 'Cancel'
  return { save, cancel }
}
function mkEmpty(msg) { const p = document.createElement('p'); p.className = 'su-empty'; p.textContent = msg; return p }
function backBtn(id) {
  return `<button class="header-btn" id="${id}">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5"/>
    </svg>
  </button>`
}

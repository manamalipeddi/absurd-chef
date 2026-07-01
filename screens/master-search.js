import { supabase, openModal, closeModal, toast } from '../app.js'

const norm = s => String(s || '').toLowerCase().trim()

// Searchable master_ingredients picker with a genuine create-new option. Shared
// by the Inventory link editor and the Add/Edit Recipe ingredient rows. Fetches
// active masters on open; onPick(master) receives the chosen/created row;
// defaultCat seeds default_category for a newly created ingredient. Not
// auto-focused (consistent with the recipe picker).
export async function openMasterSearch(query, defaultCat, onPick) {
  // Load all masters (incl. inactive) so a search can surface an existing
  // inactive vocabulary entry instead of prompting a duplicate "create new".
  const { data } = await supabase.from('master_ingredients')
    .select('id, canonical_name, aliases, active').order('canonical_name')
  const masters = data || []

  const overlay = document.createElement('div'); overlay.className = 'picker-overlay'
  const sheet   = document.createElement('div'); sheet.className = 'picker-sheet'
  const head    = document.createElement('div'); head.className = 'picker-header'
  head.innerHTML = `<span class="picker-title">Link ingredient</span><button class="picker-close" aria-label="Close">✕</button>`
  head.querySelector('.picker-close').addEventListener('click', () => closeModal(overlay))
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(overlay) })

  const search = document.createElement('input')
  search.type = 'text'; search.className = 'picker-search'; search.placeholder = 'Search ingredients…'
  search.value = query || ''
  const list = document.createElement('div'); list.className = 'picker-list'

  const mkRow = (label, onClick, cls, inactive) => {
    const b = document.createElement('button')
    b.className = 'picker-row' + (cls ? ' ' + cls : '')
    const s = document.createElement('span'); s.className = 'picker-row__name' + (inactive ? ' is-inactive-name' : ''); s.textContent = label
    b.appendChild(s)
    // Inactive masters stay selectable (inactivity is a vocabulary state, not a
    // block on linking) — just dimmed with an "Inactive" tag.
    if (inactive) { const t = document.createElement('span'); t.className = 'inactive-tag'; t.textContent = 'Inactive'; b.appendChild(t) }
    b.addEventListener('click', onClick); return b
  }
  function renderResults(q) {
    const lq = norm(q); list.innerHTML = ''
    // Default view (no query) shows active only; a search includes inactive too.
    const hits = lq
      ? masters.filter(m => norm(m.canonical_name).includes(lq) || (m.aliases || []).some(a => norm(a).includes(lq)))
      : masters.filter(m => m.active !== false).slice(0, 60)
    for (const m of hits) list.appendChild(mkRow(m.canonical_name, () => { closeModal(overlay); onPick(m) }, null, m.active === false))
    if (lq && !masters.some(m => norm(m.canonical_name) === lq)) {
      list.appendChild(mkRow(`+ Create new ingredient: “${q.trim()}”`, async () => {
        const { data: row, error } = await supabase.from('master_ingredients')
          .insert({ canonical_name: q.trim(), default_category: defaultCat || 'pantry', active: true }).select().single()
        if (error || !row) { toast('Create failed', { error: true }); return }
        toast('Ingredient created')
        closeModal(overlay); onPick(row)
      }, 'picker-row--other'))
    }
  }
  search.addEventListener('input', () => renderResults(search.value))
  renderResults(search.value)

  sheet.append(head, search, list)
  overlay.appendChild(sheet)
  document.body.appendChild(overlay)
  openModal(overlay, () => overlay.remove())
}

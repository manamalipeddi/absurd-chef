import { navigateTo } from '../app.js'

const SECTIONS = [
  { id: 'setup-family',          emoji: '👨‍👩‍👧‍👦', label: 'Family',          sub: 'Members, allergies & preferences' },
  { id: 'setup-weekly-template', emoji: '📅', label: 'Weekly Template', sub: 'Meal constraints by day' },
  { id: 'setup-day-settings',    emoji: '🗓️', label: 'Day Settings',    sub: 'Commute, kids home, away & guests' },
  { id: 'setup-preschool-menu',  emoji: '🏫', label: 'Preschool Menu',  sub: "This week's lunch menu" },
  { id: 'setup-ingredients',     emoji: '🥕', label: 'Ingredients',     sub: 'Master ingredient list & matching' },
  { id: 'setup-reference',       emoji: '🏷️', label: 'Recipe Vocabulary', sub: 'Tags, cuisines, methods, proteins, styles' },
]

let screenEl = null

export function init(el) { screenEl = el }

export function activate({ headerLeft, headerRight }) {
  headerLeft.innerHTML = ''
  headerRight.innerHTML = ''
  if (!screenEl) return
  screenEl.innerHTML = ''

  const card = document.createElement('div')
  card.className = 'card su-hub-card'

  SECTIONS.forEach((sec, i) => {
    const row = document.createElement('button')
    row.className = 'su-hub-row' + (i < SECTIONS.length - 1 ? ' su-hub-row--ruled' : '')

    const emoji = document.createElement('span')
    emoji.className = 'su-hub-emoji'
    emoji.textContent = sec.emoji

    const centre = document.createElement('div')
    centre.className = 'su-hub-centre'
    const lbl = document.createElement('span')
    lbl.className = 'su-hub-label'
    lbl.textContent = sec.label
    const sub = document.createElement('span')
    sub.className = 'su-hub-sub'
    sub.textContent = sec.sub
    centre.append(lbl, sub)

    const chevWrap = document.createElement('span')
    chevWrap.innerHTML = `<svg class="su-hub-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path stroke-linecap="round" stroke-linejoin="round" d="m9 18 6-6-6-6"/>
    </svg>`

    row.append(emoji, centre, chevWrap)
    row.addEventListener('click', () => navigateTo(sec.id))
    card.appendChild(row)
  })

  screenEl.appendChild(card)
}

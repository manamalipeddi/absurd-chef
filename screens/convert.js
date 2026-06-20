// Render-time US→metric conversion. Conversion data lives on master_ingredients
// (unit_type / grams_per_cup); this module only formats. Always additive — the
// original measurement is shown first, metric in brackets after.

const CUP_ML = 240, TBSP_ML = 15, TSP_ML = 5
const OZ_G = 28.3495, LB_G = 453.592

const CUP = ['cup', 'cups', 'c']
const TBSP = ['tbsp', 'tbsp.', 'tablespoon', 'tablespoons', 'tbs']
const TSP = ['tsp', 'tsp.', 'teaspoon', 'teaspoons']
const OZ = ['oz', 'oz.', 'ounce', 'ounces']
const LB = ['lb', 'lbs', 'lb.', 'pound', 'pounds']

function gram(g) {
  const r = g >= 100 ? Math.round(g / 5) * 5 : Math.round(g)
  return `${r}g`
}
function kg(g) { return `${(g / 1000).toFixed(g % 1000 === 0 ? 0 : 1)}kg` }
function mlFmt(ml) { return `${Math.round(ml / 5) * 5}ml` }

// Returns { text, approx } or null (no conversion — leave the unit untouched).
export function convert(quantity, unit, master) {
  if (quantity == null || !unit) return null
  const u = String(unit).toLowerCase().trim()
  const utype = master?.unit_type

  if (OZ.includes(u)) return { text: gram(quantity * OZ_G), approx: false }
  if (LB.includes(u)) { const g = quantity * LB_G; return { text: g >= 1000 ? kg(g) : gram(g), approx: false } }

  if (CUP.includes(u)) {
    if (utype === 'liquid_volume') return { text: mlFmt(quantity * CUP_ML), approx: false }
    if (utype === 'solid_volume' && master.grams_per_cup) return { text: gram(quantity * master.grams_per_cup), approx: true }
    if (utype === 'count' || utype === 'weight_only') return null  // not a cup-measured solid
    return { text: gram(quantity * 150), approx: true }            // unlinked: generic best-effort
  }

  // tbsp/tsp only convert when they stand in for a meaningful liquid/solid amount;
  // as small spice measures (count/weight_only/unlinked) they're left untouched.
  const isTbsp = TBSP.includes(u), isTsp = TSP.includes(u)
  if (isTbsp || isTsp) {
    const per = isTbsp ? TBSP_ML : TSP_ML
    if (utype === 'liquid_volume') return { text: mlFmt(quantity * per), approx: false }
    if (utype === 'solid_volume' && master.grams_per_cup)
      return { text: gram(quantity * master.grams_per_cup / (isTbsp ? 16 : 48)), approx: true }
    return null
  }
  return null
}

// "" or " (~240g)" — appended after the original measurement on an ingredient row.
export function convBracket(quantity, unit, master) {
  const c = convert(quantity, unit, master)
  return c ? ` (${c.approx ? '~' : ''}${c.text})` : ''
}

// Best-effort conversion of free text (e.g. original_instructions). Weight (oz/lb)
// and temperature (°F) are exact; cup/tbsp/tsp convert to volume (ml) — always a
// valid metric volume even without knowing the ingredient's density.
const num = '(\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d+(?:\\.\\d+)?)'
function parseNum(s) {
  s = s.trim()
  let m = s.match(/^(\d+)\s+(\d+)\/(\d+)$/); if (m) return +m[1] + (+m[2] / +m[3])
  m = s.match(/^(\d+)\/(\d+)$/); if (m) return +m[1] / +m[2]
  return parseFloat(s)
}
export function convertText(text) {
  if (!text) return text
  let t = text
  t = t.replace(/(\d+)\s?°?\s?F\b/g, (m, f) => `${m} (${Math.round((+f - 32) * 5 / 9)}°C)`)
  t = t.replace(new RegExp(`${num}\\s?(oz|ounces?|ounce)\\b`, 'gi'), (m, n) => `${m} (${gram(parseNum(n) * OZ_G)})`)
  t = t.replace(new RegExp(`${num}\\s?(lbs?|pounds?|pound)\\b`, 'gi'), (m, n) => { const g = parseNum(n) * LB_G; return `${m} (${g >= 1000 ? kg(g) : gram(g)})` })
  t = t.replace(new RegExp(`${num}\\s?(cups?)\\b`, 'gi'), (m, n) => `${m} (${mlFmt(parseNum(n) * CUP_ML)})`)
  t = t.replace(new RegExp(`${num}\\s?(tbsp\\.?|tablespoons?)\\b`, 'gi'), (m, n) => `${m} (${mlFmt(parseNum(n) * TBSP_ML)})`)
  t = t.replace(new RegExp(`${num}\\s?(tsp\\.?|teaspoons?)\\b`, 'gi'), (m, n) => `${m} (${mlFmt(parseNum(n) * TSP_ML)})`)
  return t
}

const CACHE = 'absurdchef-v122'

// Local-dev guard: the SW never serves from cache when the page is loaded from a
// dev host, so edited files always load fresh (no version bump / unregister
// dance) — including a phone hitting the Mac over the LAN. Covers localhost,
// loopback, private LAN ranges (10/8, 172.16–31/12, 192.168/16) and *.local.
// Anything else (e.g. the Vercel domain) keeps the cache-first behaviour below.
const H = self.location.hostname
const DEV =
  H === 'localhost' ||
  /^127\./.test(H) ||
  /^10\./.test(H) ||
  /^192\.168\./.test(H) ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(H) ||
  H.endsWith('.local')

const SHELL = [
  './', './index.html', './style.css', './app.js', './manifest.json',
  './screens/plan.js', './screens/chat.js', './screens/recipes.js',
  './screens/recipe-detail.js', './screens/add-recipe.js',
  './screens/pantry.js', './screens/setup.js',
  './screens/setup-family.js', './screens/setup-weekly-template.js',
  './screens/setup-day-settings.js', './screens/setup-preschool-menu.js',
  './screens/setup-ingredients.js', './screens/convert.js',
  './screens/master-search.js', './screens/setup-reference.js',
]

self.addEventListener('install', e => {
  // In dev, skip pre-caching entirely and activate immediately.
  if (DEV) { self.skipWaiting(); return }
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', e => {
  // Dev: pass everything through to the network — always fresh from disk.
  if (DEV) return

  const url = e.request.url
  // always network for API calls
  if (url.includes('supabase.co')) return

  // cache-first for shell assets
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  )
})

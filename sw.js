const CACHE = 'absurdchef-v3'
const SHELL = [
  './', './index.html', './style.css', './app.js', './manifest.json',
  './screens/plan.js', './screens/chat.js', './screens/recipes.js',
  './screens/recipe-detail.js', './screens/pantry.js', './screens/setup.js',
]

self.addEventListener('install', e => {
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
  const url = e.request.url
  // always network for API calls
  if (url.includes('supabase.co')) return

  // cache-first for shell assets
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  )
})

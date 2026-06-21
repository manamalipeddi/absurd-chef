const CACHE = 'absurdchef-v93'
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

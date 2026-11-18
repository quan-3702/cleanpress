const CACHE = 'cleanpress-v1';
const ASSETS = ['./', 'index.html', 'help.html', 'privacy.html', 'style.css', 'clean-core.js', 'app.js', 'df.js', 'df-worker.js', 'mp3-worker.js', 'lame.min.js', 'LICENSE-DeepFilterNet.txt', 'manifest.json', 'icon-192.png', 'icon-512.png', 'icon-512-maskable.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())); });
// the AI model ("cleanpress-model") is kept: it is large and only downloaded once
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== 'cleanpress-model' && k.startsWith('cleanpress')).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req)));
});

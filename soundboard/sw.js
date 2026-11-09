// Service Worker: App-Shell offline verfügbar (cache-first, im Hintergrund aktualisiert).
// Bei Code-Änderungen CACHE hochzählen. Neue Versionen werden erst beim nächsten Start aktiv
// (kein skipWaiting), damit sich die App nie mitten in einer Show austauscht.
const CACHE = 'soundboard-shell-v5';
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'util.js', 'store.js', 'engine.js', 'midi.js',
  'project.js', 'ui.js', 'dialogs.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png',
  'icon-maskable-512.png', 'icon.svg', 'icon-small.svg', 'logo.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: true });
    const net = fetch(req).then((res) => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    const res = await net;
    if (res) return res;
    if (req.mode === 'navigate') { const idx = await caches.match('index.html'); if (idx) return idx; }
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  })());
});

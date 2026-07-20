// خدمة الكاش للتطبيق (PWA) — تسمح بفتح التطبيق حتى مع ضعف الشبكة
const CACHE = 'azoom-shell-v1';
const SHELL = ['/', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;                 // الحفظ والرفع دائماً عبر الشبكة
  if (url.pathname.startsWith('/api/')) return;           // بيانات حية دائماً
  // الشبكة أولاً (لالتقاط التحديثات) مع الرجوع للكاش عند الانقطاع
  e.respondWith(
    fetch(e.request).then(r => {
      if (r.ok && (SHELL.includes(url.pathname) || url.pathname.startsWith('/uploads/'))) {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return r;
    }).catch(() =>
      caches.match(e.request).then(m => m || (url.pathname.startsWith('/uploads/')
        ? new Response('', { status: 404 })
        : caches.match('/')))
    )
  );
});

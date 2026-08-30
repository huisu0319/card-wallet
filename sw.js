/* 네트워크 우선 + 오프라인 폴백 (홈 화면 앱으로 쓸 때만 동작) */
const CACHE = 'card-wallet-v4';
const SHELL = ['./', './index.html', './css/style.css', './js/app.js', './js/photo.js', './manifest.json', './icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // 내 파일은 HTTP 캐시를 건너뛰고 늘 새로 받는다 (옛 버전이 남는 것을 막음)
  const sameOrigin = new URL(e.request.url).origin === self.location.origin;
  const req = sameOrigin ? new Request(e.request, { cache: 'no-store' }) : e.request;
  e.respondWith(
    fetch(req)
      .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});

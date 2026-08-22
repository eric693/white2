// Service Worker：只做「外殼快取」，資料一律走網路。
//
// 後台的內容是即時的（餘額、稅單、庫存），快取 API 回應只會讓管理員看到舊資料做錯決定，
// 所以這裡刻意只快取靜態外殼（HTML/CSS/JS），/api/* 完全不碰。
const SHELL = 'w2-shell-v1';
const SHELL_FILES = [
  '/', '/index.html', '/css/style.css',
  '/js/api.js', '/js/ui.js', '/js/helpers.js', '/js/app.js',
  '/manifest.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== SHELL).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // API、上傳檔案、跨網域一律直接走網路，不進快取
  if (url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) return;
  if (e.request.method !== 'GET') return;

  // 外殼：網路優先、失敗才用快取（這樣改版後不用等使用者清快取，離線也還能開）
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(SHELL).then(c => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request).then(hit => hit || caches.match('/index.html')))
  );
});

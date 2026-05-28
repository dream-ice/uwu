// UwU service worker —— 缓存 App 外壳，让 PWA 在酒馆没运行/断网时也能打开。
// 作用域 = 本文件所在目录 /scripts/extensions/third-party/uwu/，只接管 UwU 自己的文件，不影响酒馆。
const CACHE = 'uwu-shell-v1';
const SCOPE_PREFIX = '/scripts/extensions/third-party/uwu/';

self.addEventListener('install', () => {
  self.skipWaiting();           // 新版本立即接管
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // 清掉旧版本缓存
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('uwu-shell-') && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // 只缓存 UwU 自己的同源文件；其它(酒馆/外部 API)一律放行不碰
  if (url.origin !== self.location.origin || !url.pathname.startsWith(SCOPE_PREFIX)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    // 后台静默拉新版本并更新缓存
    const networkFetch = fetch(req).then(res => {
      if (res && res.status === 200 && res.type === 'basic') cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    // 缓存优先：有缓存秒开 + 离线可用；没缓存才等网络
    return cached || (await networkFetch) || new Response('离线且无缓存', { status: 503 });
  })());
});

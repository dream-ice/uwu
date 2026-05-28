// UwU service worker —— 安装时「预缓存」整个 App 外壳，让 PWA 在酒馆没运行/断网时也能打开。
// 作用域 = 本文件所在目录 /scripts/extensions/third-party/uwu/，只接管 UwU 自己的文件，不影响酒馆。
const CACHE = 'uwu-shell-v3';
const SCOPE_PREFIX = '/scripts/extensions/third-party/uwu/';

// App 外壳：所有同源本地文件（相对 sw.js 解析）。CDN 依赖不在此列，离线时靠联网。
const SHELL = [
  'index.html',
  'style.css', 'contacts.css', 'more_menu.css',
  'css/base.css', 'css/chat.css', 'css/layout.css', 'css/settings.css',
  'css/modules/cot_settings.css', 'css/modules/forum.css', 'css/modules/journal.css',
  'css/modules/live.css', 'css/modules/monitor.css', 'css/modules/more.css',
  'css/modules/peek.css', 'css/modules/pomodoro.css', 'css/modules/search.css',
  'css/modules/shop.css', 'css/modules/steps.css', 'css/modules/tutorial.css',
  'css/modules/video_call.css', 'css/modules/worldbook.css',
  'js/chat.js', 'js/contacts.js', 'js/db.js', 'js/group_chat.js', 'js/main.js',
  'js/settings.js', 'js/ui.js', 'js/utils.js', 'js/workshop.js',
  'js/modules/battery_interaction.js', 'js/modules/character_import.js',
  'js/modules/chat_ai.js', 'js/modules/chat_features.js', 'js/modules/chat_list.js',
  'js/modules/chat_ops.js', 'js/modules/chat_render.js', 'js/modules/cot_settings.js',
  'js/modules/forum.js', 'js/modules/gallery.js', 'js/modules/journal.js',
  'js/modules/live.js', 'js/modules/more_menu.js', 'js/modules/peek.js',
  'js/modules/pomodoro.js', 'js/modules/search.js', 'js/modules/shop.js',
  'js/modules/sticker.js', 'js/modules/storage.js', 'js/modules/tavern_sync.js',
  'js/modules/tutorial.js', 'js/modules/video_call.js', 'js/modules/widgets.js',
  'js/modules/worldbook.js'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 逐个缓存：单个失败不影响其它（addAll 是全有或全无，太脆）
    await Promise.allSettled(SHELL.map(async (path) => {
      try {
        const res = await fetch(path, { credentials: 'same-origin', cache: 'reload' });
        if (res && res.ok) await cache.put(path, res.clone());
      } catch (e) { /* 单个文件失败忽略 */ }
    }));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('uwu-shell-') && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // 只接管 UwU 自己的同源文件；酒馆 API / 外部 CDN 一律放行不碰
  if (url.origin !== self.location.origin || !url.pathname.startsWith(SCOPE_PREFIX)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    // 后台静默拉新版本并更新缓存
    const networkFetch = fetch(req).then(res => {
      if (res && res.status === 200 && res.type === 'basic') cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    // 缓存优先：有缓存秒开 + 离线可用
    if (cached) { networkFetch; return cached; }
    const net = await networkFetch;
    if (net) return net;
    // 导航请求（启动 App）兜底：拿不到就回缓存的 index.html
    if (req.mode === 'navigate') {
      const fallback = await cache.match('index.html');
      if (fallback) return fallback;
    }
    return new Response('离线且无缓存', { status: 503 });
  })());
});

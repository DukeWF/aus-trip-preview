/* 澳洲行监测 · 离线 Service Worker
   策略：
   - 静态资源(index.html / vendor / 图片 / svg)：stale-while-revalidate
     —— 先给缓存(秒开、离线可用)，后台拉新写回缓存供下次。
   - 数据(/api/*、线上预览的 snapshot.json 与 itinerary.pdf)：network-first
     —— 在线时保证价格/行程新鲜(线上每轮抓价后更新、PDF 随发版更新)，断网才回退缓存。
   同源 GET 才处理；非 GET(写操作)与跨域一律放行网络。
   本地由 FastAPI GET /sw.js 提供、线上预览放在站点根，作用域均为 '/'。 */
// 前端有结构性改动(新面板/新字段/样式修复)时**必须**升版本号：
// stale-while-revalidate 会先返回旧 index.html，不换 key 的话老用户要多打开一次才看到新版。
const CACHE = 'austrip-cache-v7';
// 数据快照的**稳定键**缓存(键固定为 /snapshot.json，不带 ?t=)：
// 供「省流量/离线模式」主动读取、以及断网回退——外壳升版时**不清除**它，数据不丢。
const SNAP_CACHE = 'austrip-snap';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => e.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter(k => k !== CACHE && k !== SNAP_CACHE).map(k => caches.delete(k)));
  await self.clients.claim();
})()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // 页面本身(navigate / index.html)也走 network-first：SWR 会先吐旧 index.html，
  // 前端一有改动就得多打开一次才生效——实测发布后线上仍显示旧版清单，误导排查。
  // 静态资源(vendor/图片/svg)体积大且几乎不变，继续 SWR 保持秒开与离线可用。
  const isDoc = req.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('/index.html');
  const isApi = isDoc || url.pathname.startsWith('/api/') || url.pathname.endsWith('/snapshot.json')
    || url.pathname.endsWith('/itinerary.pdf');
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (isApi) {
      // network-first：在线取新并回填，断网回退缓存。
      // ⚠️ 必须 cache:'reload'：GitHub Pages 给静态文件发 Cache-Control: max-age=600，
      // SW 里直接 fetch(req) 会命中**浏览器 HTTP 缓存**、拿回 10 分钟前的旧文件，
      // network-first 形同虚设（实测线上 snapshot.json 少 3 条监测项）。
      // navigate 模式的 Request 不能用 new Request(req, {...}) 复制，故按 URL 重发。
      try {
        const res = await fetch(req.url, { cache: 'reload', credentials: 'same-origin' });
        if (res && res.status === 200) {
          cache.put(req, res.clone());
          // snapshot.json 额外写一份到稳定键缓存(去掉 ?t= 时间戳)，供省流量/离线主动复用。
          if (url.pathname.endsWith('/snapshot.json')) {
            (await caches.open(SNAP_CACHE)).put('/snapshot.json', res.clone());
          }
        }
        return res;
      } catch (_) {
        // 断网回退缓存。页面请求要回退到缓存的 index.html（否则会把 {offline:true}
        // 这段 JSON 当页面渲染出来），取不到才给纯文本提示。
        // snapshot.json 的请求带 ?t= 时间戳、按原样匹配必 MISS，故先回退稳定键缓存。
        const cached = await cache.match(req)
          || (url.pathname.endsWith('/snapshot.json') ? await (await caches.open(SNAP_CACHE)).match('/snapshot.json') : null)
          || (isDoc ? await cache.match('/index.html') : null);
        if (cached) return cached;
        return isDoc
          ? new Response('离线且无缓存页面', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
          : new Response(JSON.stringify({ offline: true }),
            { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
    }
    // 静态：stale-while-revalidate
    const cached = await cache.match(req);
    const network = fetch(req).then(res => {
      if (res && res.status === 200) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    return cached || (await network) || new Response('离线且无缓存', { status: 503 });
  })());
});

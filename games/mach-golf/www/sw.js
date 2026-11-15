/* Mach Golf — offline cache. Bump CACHE on every release. */
const CACHE='mach-v2-gauge';
const ASSETS=[
  './','./index.html','./manifest.json','./icon.svg','./icon-192.png','./icon-512.png',
  './img/brand/gauge-wordmark.png','./img/brand/gauge-splash.webp'
];
self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET') return;
  e.respondWith(
    caches.match(e.request).then(hit=>hit||fetch(e.request).then(res=>{
      const copy=res.clone();
      caches.open(CACHE).then(c=>{ try{ c.put(e.request,copy); }catch(_){} });
      return res;
    }).catch(()=>caches.match('./index.html')))
  );
});

/* Tap-In offline support for the web / PWA build.
 * - The app shell and every bundled course pack are cached on first visit, so the
 *   app and the lidar greens work on the course with no signal.
 * - Hashed build assets: cache-first. Course packs: stale-while-revalidate.
 * - Pages: network-first, falling back to the cached app.
 * Cross-origin requests (weather, map tiles, live OSM/USGS) are left alone.
 */
const VERSION = "tapin-v0.8.8";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg", "./icon-192.png", "./icon-512.png", "./courses/index.json"];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await c.addAll(SHELL).catch(() => {});
    // course packs are cached the first time each course is opened (there are dozens)
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    e.respondWith((async () => {
      try {
        const r = await fetch(req);
        (await caches.open(VERSION)).put("./index.html", r.clone());
        return r;
      } catch {
        return (await caches.match("./index.html")) || (await caches.match("./")) || Response.error();
      }
    })());
    return;
  }

  if (url.pathname.includes("/courses/")) {
    e.respondWith((async () => {
      const c = await caches.open(VERSION);
      const hit = await c.match(req, { ignoreSearch: true });
      const net = fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => null);
      return hit || (await net) || Response.error();
    })());
    return;
  }

  e.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    try {
      const r = await fetch(req);
      if (r.ok && (url.pathname.includes("/assets/") || /\.(png|svg|webmanifest|json)$/.test(url.pathname))) (await caches.open(VERSION)).put(req, r.clone());
      return r;
    } catch {
      return Response.error();
    }
  })());
});

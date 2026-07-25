const CACHE_PREFIX = "miruyote-shell-";
const CACHE = `${CACHE_PREFIX}v5`;
const ASSETS = ["./", "./index.html", "./styles.css", "./app.js", "./manifest.webmanifest"];
const SHELL_URLS = new Set(ASSETS.map(asset => new URL(asset, self.location.href).href));

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const isNavigation = event.request.mode === "navigate";
  if (!isNavigation && !SHELL_URLS.has(url.href)) return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.ok && !isNavigation) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        if (isNavigation) return caches.match("./index.html");
        return Response.error();
      })
  );
});

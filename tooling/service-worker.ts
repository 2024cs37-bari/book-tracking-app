export interface ShellAsset {
  readonly url: string;
  readonly integrity: string;
}

/** A version owns its shell cache for as long as any reader still uses it. */
export function generateServiceWorker(cacheName: string, assets: readonly ShellAsset[]): string {
  return `const CACHE=${JSON.stringify(cacheName)};
const ASSETS=${JSON.stringify(assets)};
const SCOPE=new URL(self.registration.scope);
const assetUrls=new Set(ASSETS.map(asset => new URL(asset.url, SCOPE).href));
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS.map(asset =>
    new Request(new URL(asset.url, SCOPE), {cache:'reload', integrity:asset.integrity})
  ))).catch(async error => {
    await caches.delete(CACHE);
    throw error;
  }));
  // No skipWaiting: an active reader must keep its matching engine and assets.
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys
    .filter(key => key.startsWith('reader-shell-') && key !== CACHE)
    .map(key => caches.delete(key))
  )).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url=new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== SCOPE.origin ||
      !url.pathname.startsWith(SCOPE.pathname)) return;
  const path=url.pathname.slice(SCOPE.pathname.length);
  // Auth and private APIs always reach the network and never the shell cache.
  if (path === 'api' || path.startsWith('api/') || path.startsWith('cdn-cgi/')) return;
  const assetUrl=new URL(url);
  assetUrl.search='';
  if (event.request.mode !== 'navigate' && !assetUrls.has(assetUrl.href)) return;
  event.respondWith(caches.open(CACHE).then(async cache => {
    if (event.request.mode === 'navigate') {
      return (await cache.match(new URL('./index.html', SCOPE))) || fetch(event.request);
    }
    return (await cache.match(assetUrl.href)) || fetch(event.request);
  }));
});
`;
}

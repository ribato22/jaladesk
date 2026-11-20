/**
 * JalaDesk Web Companion — Offline-First PWA Service Worker
 *
 * Precaches the local app shell for instant offline-first launch under `/jaladesk/app/`
 * (or `./` on local servers). Strictly NEVER caches Google Drive, GitHub Gist, WebDAV,
 * WebSocket, authenticated requests, or any cross-origin API traffic.
 */

const CACHE_PREFIX = 'jaladesk-web-pwa-';
const CACHE_NAME = `${CACHE_PREFIX}v7`;

const PRECACHE_PATHS = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './gateway-client.js',
  './vt-terminal-web.js',
  './vault-core.js',
  './web-oauth-config.js',
  './manifest.webmanifest',
  '../assets/jaladesk-oauth-logo-120.png',
  '../assets/jaladesk-logo.png',
];

const NEVER_CACHE_HOSTS = new Set([
  'www.googleapis.com',
  'googleapis.com',
  'accounts.google.com',
  'oauth2.googleapis.com',
  'openidconnect.googleapis.com',
  'api.github.com',
  'gist.githubusercontent.com',
  'raw.githubusercontent.com',
]);

function resolveAllowedCacheUrls() {
  const base = self.location.href;
  const urls = new Set();
  for (const relPath of PRECACHE_PATHS) {
    try {
      urls.add(new URL(relPath, base).href);
    } catch {
      // Ignore unresolvable relative entry
    }
  }
  return urls;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_PATHS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
            .map((staleKey) => caches.delete(staleKey)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function isCacheableShellRequest(request, url) {
  if (request.method !== 'GET') return false;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if (
    NEVER_CACHE_HOSTS.has(host) ||
    host.endsWith('.googleapis.com') ||
    host.endsWith('.accounts.google.com')
  ) {
    return false;
  }
  if (url.origin !== self.location.origin) return false;
  if (request.headers && request.headers.has('Authorization')) return false;
  if (url.search && url.search.length > 0) return false;

  const allowedUrls = resolveAllowedCacheUrls();
  if (allowedUrls.has(url.href)) return true;

  if (request.mode === 'navigate') {
    const scopeUrl = new URL('./', self.location.href);
    return url.pathname === scopeUrl.pathname || url.pathname === `${scopeUrl.pathname}index.html`;
  }
  return false;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  if (!isCacheableShellRequest(request, url)) {
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request, { ignoreSearch: false });

      const networkFetch = fetch(request)
        .then((response) => {
          if (response && response.ok && response.type === 'basic') {
            cache.put(request, response.clone()).catch(() => {});
          }
          return response;
        })
        .catch(() => null);

      if (cached) {
        event.waitUntil(networkFetch);
        return cached;
      }

      const fresh = await networkFetch;
      if (fresh) return fresh;

      if (request.mode === 'navigate') {
        const fallback = (await cache.match('./index.html')) || (await cache.match('./'));
        if (fallback) return fallback;
      }

      return new Response('Offline — JalaDesk Web shell asset is unavailable.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }),
  );
});

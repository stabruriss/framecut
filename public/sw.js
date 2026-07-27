const CACHE_NAME = 'framecut-shell-__FRAMECUT_CACHE_VERSION__';
const APP_SHELL = [
  './framecut-mark.svg',
  './framecut-192.png',
  './framecut-512.png',
  './manifest.webmanifest',
  './vendor/wasm-vips/vips-es6.js',
  './vendor/wasm-vips/vips.wasm',
];

self.addEventListener('install', (event) => {
  event.waitUntil(installShell());
});

async function installShell() {
  const cache = await caches.open(CACHE_NAME);
  const indexUrl = new URL('./', self.location.href);
  const indexResponse = await fetch(indexUrl, { cache: 'no-cache' });
  if (!indexResponse.ok) {
    throw new Error('Unable to cache the Framecut shell.');
  }

  await cache.put(indexUrl, indexResponse.clone());
  await cache.addAll(APP_SHELL);

  const html = await indexResponse.text();
  const visited = new Set();
  await Promise.all(
    extractHtmlUrls(html, indexUrl).map((url) =>
      cacheDiscoveredAsset(cache, url, visited, true),
    ),
  );
  await self.skipWaiting();
}

async function cacheDiscoveredAsset(cache, url, visited, required) {
  if (visited.has(url.href)) {
    return;
  }
  visited.add(url.href);

  const response = await fetch(url);
  if (!response.ok) {
    if (required) {
      throw new Error(`Unable to cache ${url.pathname}.`);
    }
    return;
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (
    !required &&
    contentType.includes('text/html') &&
    !url.pathname.endsWith('.html')
  ) {
    return;
  }

  await cache.put(url, response.clone());
  let nestedUrls = [];
  if (contentType.includes('text/css')) {
    nestedUrls = extractCssUrls(await response.text(), url);
  } else if (
    contentType.includes('javascript') &&
    required
  ) {
    nestedUrls = extractJsUrls(await response.text(), url);
  }

  await Promise.all(
    nestedUrls.map((nestedUrl) =>
      cacheDiscoveredAsset(cache, nestedUrl, visited, true),
    ),
  );
}

function urlsFromMatches(source, baseUrl, patterns) {
  const urls = new Set();
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const candidate = match[1].trim();
      if (
        candidate.startsWith('#') ||
        candidate.toLowerCase().startsWith('%23') ||
        candidate.startsWith('data:')
      ) {
        continue;
      }
      try {
        const url = new URL(candidate, baseUrl);
        if (url.origin === self.location.origin) {
          urls.add(url.href);
        }
      } catch {
        // Ignore CSS and bundle fragments that are not URLs.
      }
    }
  }

  return [...urls].map((url) => new URL(url));
}

function extractHtmlUrls(source, baseUrl) {
  return urlsFromMatches(source, baseUrl, [
    /(?:src|href)=["']([^"'#]+)["']/g,
  ]);
}

function extractCssUrls(source, baseUrl) {
  return urlsFromMatches(source, baseUrl, [
    /url\(\s*["']?([^"'()#]+)["']?\s*\)/g,
  ]);
}

function extractJsUrls(source, baseUrl) {
  return urlsFromMatches(source, baseUrl, [
    /new URL\(["']([^"']+\.js)["'],\s*import\.meta\.url\)/g,
    /import\(["']([^"']+\.js)["']\)/g,
  ]);
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                key.startsWith('framecut-shell-') &&
                key !== CACHE_NAME,
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (
          response.ok &&
          new URL(event.request.url).origin === self.location.origin
        ) {
          const copy = response.clone();
          void caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) {
          return cached;
        }

        if (event.request.mode === 'navigate') {
          const shell = await caches.match(
            new URL('./', self.location.href),
          );
          if (shell) {
            return shell;
          }
        }

        throw new Error('Framecut is offline and this asset is not cached yet.');
      }),
  );
});

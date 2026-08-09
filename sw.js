/**
 * ================================================================
 * WILAN SUN TRACKER — sw.js
 * Service Worker  ·  Cache-First strategy for static app shell
 *
 * IMPORTANT: Every time you update index.html, app.js, or any
 * file listed in STATIC_ASSETS, you MUST bump CACHE_VERSION.
 * The activate event deletes old caches, forcing users to download
 * the new shell on their next visit.
 *
 * Fetch strategy overview:
 *   ① Check cache  →  return immediately (works fully offline)
 *   ② Cache miss   →  fetch from network, store in cache, return
 *   ③ Network fail →  for navigation requests, serve index.html
 *                     for all other requests, return 503
 *
 * Non-GET requests (POST to Supabase, etc.) always bypass the
 * cache and go straight to the network.
 * ================================================================
 */

'use strict';

// ── Cache identity ───────────────────────────────────────────────
// Bump the version suffix (v1 → v2) whenever you change any file
// in STATIC_ASSETS. Format: '<app-slug>-v<integer>'
const CACHE_NAME = 'wilan-sun-tracker-v15';

// ── App shell — files required for offline launch ────────────────
// CDN resources (Tailwind, SunCalc) are NOT listed here by default.
// If you want offline support for CDN scripts, add their full URLs.
// Example: 'https://cdn.tailwindcss.com'  (pin to an exact version
// URL rather than the bare play CDN to get a stable response.)
// Relative paths resolve correctly whether served from / or /wilan-sun-tracker/
const STATIC_ASSETS = [
  './',
  './index.html',
  './app.js',
  './stars.js',
  './manifest.json',
  './sw.js',
  './icons/icon-192x192.png',
  './icons/icon-512x512.png',
];


// ================================================================
// INSTALL
// Runs once when this SW version is first registered.
// Caches all STATIC_ASSETS atomically — if any single file fails
// to fetch (e.g. 404), the entire install fails and the old SW
// remains in control. Fix the file path and redeploy to retry.
// `skipWaiting()` bypasses the waiting state so the new SW
// activates immediately (even if other tabs are open).
// ================================================================
self.addEventListener('install', (event) => {
  console.log(`[SW] Installing ${CACHE_NAME}…`);

  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => {
        console.log('[SW] Pre-caching app shell:', STATIC_ASSETS);
        return cache.addAll(STATIC_ASSETS);
      })
      .then(() => {
        console.log('[SW] Pre-cache complete. Activating immediately.');
        return self.skipWaiting();
      })
      .catch((err) => {
        console.error('[SW] Pre-cache failed — check that all STATIC_ASSETS paths resolve:', err);
        // Don't rethrow: a failed install leaves the previous SW in place,
        // which is better than leaving users with a broken shell.
      })
  );
});


// ================================================================
// ACTIVATE
// Runs after install, once this SW has taken control.
// Deletes any caches whose name differs from CACHE_NAME so stale
// files from previous versions don't consume device storage.
// `clients.claim()` makes this SW the controller for all existing
// open tabs immediately — without requiring a page reload.
// ================================================================
self.addEventListener('activate', (event) => {
  console.log(`[SW] Activating ${CACHE_NAME}…`);

  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter((name) => name !== CACHE_NAME) // keep only current version
            .map((name) => {
              console.log('[SW] Deleting old cache:', name);
              return caches.delete(name);
            })
        )
      )
      .then(() => {
        console.log('[SW] Old caches cleared. Claiming all clients.');
        return self.clients.claim();
      })
  );
});


// ================================================================
// FETCH
// Intercepts every network request made by controlled pages.
//
// Rules:
//  • Non-GET requests  →  pass through to network (never cache)
//  • Cross-origin GET  →  pass through; optionally cache on success
//  • Same-origin GET   →  cache-first; update cache on network hit
// ================================================================
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only cache GET requests
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const isSameOrigin = url.origin === self.location.origin;

  event.respondWith(resolveRequest(request, isSameOrigin));
});

/**
 * Cache-First with Network Fallback.
 * @param {Request} request
 * @param {boolean} isSameOrigin  — whether to cache network responses
 * @returns {Promise<Response>}
 */
async function resolveRequest(request, isSameOrigin) {
  // ① Try cache
  const cached = await caches.match(request);
  if (cached) {
    return cached;
  }

  // ② Cache miss — try network
  try {
    const networkResponse = await fetch(request);

    // Cache valid same-origin responses for future offline use
    if (isSameOrigin && networkResponse.ok) {
      const cache = await caches.open(CACHE_NAME);
      // Clone before consuming: a Response body can only be read once
      cache.put(request, networkResponse.clone());
    }

    return networkResponse;

  } catch {
    // ③ Both cache and network failed (device is offline)
    if (request.mode === 'navigate') {
      // For page navigations, serve the cached shell so the app
      // can load and show an offline state via its own UI logic.
      const shell = await caches.match('./index.html');
      if (shell) return shell;
    }

    // For sub-resources (images, fonts, API calls) return a minimal
    // 503 so the caller can handle the failure gracefully.
    return new Response(null, {
      status:     503,
      statusText: 'Service Unavailable — offline',
    });
  }
}


// ================================================================
// MESSAGE
// Allows the page to send control commands to the SW.
//
// Supported commands:
//   { type: 'SKIP_WAITING' }  — activate a waiting SW immediately
//   { type: 'GET_VERSION'  }  — reply with current cache name
//
// Usage from app.js:
//   navigator.serviceWorker.controller.postMessage({ type: 'SKIP_WAITING' });
// ================================================================
self.addEventListener('message', (event) => {
  if (!event.data?.type) return;

  switch (event.data.type) {
    case 'SKIP_WAITING':
      console.log('[SW] SKIP_WAITING received — activating now.');
      self.skipWaiting();
      break;

    case 'GET_VERSION':
      event.source?.postMessage({ type: 'VERSION', version: CACHE_NAME });
      break;

    default:
      console.warn('[SW] Unknown message type:', event.data.type);
  }
});

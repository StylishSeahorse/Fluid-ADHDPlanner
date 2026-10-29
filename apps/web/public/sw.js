/*
 * Fluid's service worker.
 *
 * Three jobs, in order of importance:
 *
 *   1. Show push notifications, and take a tap to the right screen.
 *   2. Make the app installable (Android requires a service worker) and give
 *      it an honest offline screen instead of the browser's dinosaur.
 *   3. Keep the last-seen copy of the main screens, so opening the app on a
 *      train shows the day as it was rather than nothing at all.
 *
 * It deliberately does NOT cache API calls, server actions or anything that
 * writes. A planner that silently shows stale data as if it were live is worse
 * than one that says "offline".
 *
 * Registered as /sw.js?dev=1 in development, where Next's unhashed dev chunks
 * change on every edit — caching them would serve yesterday's code.
 */

const VERSION = 'v1';
const SHELL_CACHE = `fluid-shell-${VERSION}`;
const STATIC_CACHE = `fluid-static-${VERSION}`;
const PAGES_CACHE = `fluid-pages-${VERSION}`;

const DEV = new URL(self.location.href).searchParams.has('dev');
const OFFLINE_URL = '/offline.html';
const SHELL = [OFFLINE_URL, '/icons/icon-192.png', '/icons/badge-96.png'];

/** Screens worth keeping a last-seen copy of. Never settings or auth pages. */
const OFFLINE_PAGES = ['/today', '/week', '/projects', '/review'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  const keep = new Set([SHELL_CACHE, STATIC_CACHE, PAGES_CACHE]);
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => !keep.has(name)).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Hashed build assets never change under the same name: cache-first is safe.
  if (!DEV && url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      }),
    );
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(navigate(request, url));
  }
});

/** Network first; on failure, the last-seen copy of the page, else the offline screen. */
async function navigate(request, url) {
  try {
    const response = await fetch(request);
    // A redirect means "signed out" or similar — never keep that as the page.
    if (!DEV && response.ok && !response.redirected && OFFLINE_PAGES.includes(url.pathname)) {
      const cache = await caches.open(PAGES_CACHE);
      await cache.put(url.pathname, response.clone());
    }
    return response;
  } catch {
    const pages = await caches.open(PAGES_CACHE);
    const lastSeen = await pages.match(url.pathname);
    if (lastSeen) return lastSeen;

    const shell = await caches.open(SHELL_CACHE);
    return (await shell.match(OFFLINE_URL)) ?? Response.error();
  }
}

self.addEventListener('message', (event) => {
  // Sent from the login screen: a signed-out device must not keep showing the
  // previous person's day offline.
  if (event.data && event.data.type === 'clear-pages') {
    event.waitUntil(caches.delete(PAGES_CACHE));
  }
});

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : '' };
  }

  const title = payload.title || 'Fluid';
  const actions = Array.isArray(payload.actions) ? payload.actions : [];

  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || '',
      icon: '/icons/icon-192.png',
      // Android draws this monochrome glyph in the status bar.
      badge: '/icons/badge-96.png',
      tag: payload.tag || undefined,
      // A replaced reminder (same tag) should still buzz — it is new news.
      renotify: Boolean(payload.tag),
      timestamp: Date.now(),
      vibrate: [80, 40, 80],
      data: { url: payload.url || '/today', actions },
      actions: actions.slice(0, 2).map((entry) => ({ action: entry.action, title: entry.title })),
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = event.notification.data || {};
  const chosen = (data.actions || []).find((entry) => entry.action === event.action);
  const target = new URL(chosen ? chosen.url : data.url || '/today', self.location.origin);
  // Only ever navigate within the app, whatever the payload says.
  if (target.origin !== self.location.origin) return;

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (existing) {
        await existing.focus();
        if ('navigate' in existing) return existing.navigate(target.href);
        return undefined;
      }
      return self.clients.openWindow(target.href);
    })(),
  );
});

// The push service rotated this device's subscription. Re-register it with the
// server so reminders keep arriving; the request carries the session cookie.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const options = event.oldSubscription ? event.oldSubscription.options : null;
      const subscription =
        event.newSubscription || (options ? await self.registration.pushManager.subscribe(options) : null);
      if (!subscription) return;

      await fetch('/api/push/subscription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          subscription: subscription.toJSON(),
          previousEndpoint: event.oldSubscription ? event.oldSubscription.endpoint : null,
        }),
      });
    })(),
  );
});

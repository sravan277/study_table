/*
 * Day Dial service worker.
 *
 * Plain JavaScript on purpose: it is served from /public and must keep working when
 * Next is not in the picture. A script at /sw.js already defaults to scope "/", so no
 * Service-Worker-Allowed header is strictly required — next.config.ts sends one anyway
 * so moving this file to a sub-path does not silently break the scope.
 *
 * Three things are deliberately absent:
 *
 *   - a fetch handler. Caching the app shell would fight Next's own cache headers and
 *     make a code change look like it did not take.
 *   - pushsubscriptionchange handling. Chrome does not implement it (crbug 646721), so
 *     the code would never run. Dead subscriptions are pruned server-side by status
 *     code instead, which is the approach that actually works.
 *   - notificationclose. Nothing to do on close.
 */

const CACHE = "day-dial-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("push", (event) => {
  let payload = { title: "Day Dial", body: "", tag: undefined, url: "/" };

  if (event.data) {
    try {
      payload = { ...payload, ...event.data.json() };
    } catch {
      // Some browsers deliver text, and a push service will happily send malformed
      // bytes. Falling back to a plain text body beats dropping the notification.
      payload.body = event.data.text();
    }
  }

  const options = {
    body: payload.body,
    // Collapse repeats: a second reminder for the same block replaces the first
    // instead of stacking three of them on the lock screen.
    tag: payload.tag,
    renotify: Boolean(payload.tag),
    requireInteraction: true,
    icon: "/icon.svg",
    badge: "/badge.svg",
    timestamp: Date.now(),
    data: { url: payload.url ?? "/" },
    actions: [{ action: "open", title: "Open" }],
  };

  event.waitUntil(self.registration.showNotification(payload.title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  event.waitUntil(
    (async () => {
      const target = event.notification.data?.url ?? "/";
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });

      // Focus an existing tab rather than opening a duplicate. That matters because the
      // running timer lives in that tab's memory — a fresh window would start cold.
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          await client.focus();
          if ("navigate" in client && client.url !== target) {
            await client.navigate(target).catch(() => undefined);
          }
          return;
        }
      }

      await self.clients.openWindow(target);
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});

void CACHE;
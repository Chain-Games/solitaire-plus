/* global self, URL */
/*
 * Blockari service worker: Web Push and nothing else. No fetch handler, no
 * cache — the app loads from the network exactly as it does without a
 * worker, so a deploy changes nothing here. A push shows the payload the
 * server sent ({ title, body, url, tag }); a tap focuses an open Blockari
 * tab on that URL, or opens one.
 */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Blockari';
  const url = data.url || '/';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      tag: data.tag || undefined,
      icon: '/brand/icon-192.png',
      badge: '/brand/mark-128.png',
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  const target = new URL(url, self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const same = wins.find((w) => w.url === target);
      if (same) return same.focus();
      const any = wins.find((w) => 'navigate' in w);
      if (any) return any.navigate(target).then((w) => (w ? w.focus() : undefined));
      return self.clients.openWindow(target);
    }),
  );
});

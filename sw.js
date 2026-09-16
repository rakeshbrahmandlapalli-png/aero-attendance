// Never store attendance or authentication responses on shared devices.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).catch(() => new Response(
    '<!doctype html><html lang="en-GB"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aero Attendance</title><main style="font:18px system-ui;max-width:420px;margin:15vh auto;padding:24px"><h1>You are offline</h1><p>Reconnect to view attendance or record a shift. No changes have been queued.</p><button onclick="location.reload()" style="padding:12px 24px">Try again</button></main></html>',
    {status:503,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}}
  )));
});

// Phone notifications. send-push sends {title, body, url, tag}; iPhones
// require every push to show a notification, so one is always shown.
self.addEventListener('push', event => {
  let note = {};
  try { note = event.data ? event.data.json() : {}; } catch (e) { note = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(note.title || 'Aero Attendance', {
    body: note.body || '',
    tag: note.tag || undefined,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: note.url || '/' }
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data && event.notification.data.url || '/', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const open = list.find(c => c.url.split('#')[0].split('?')[0] === target);
    return open ? open.focus() : self.clients.openWindow(target);
  }));
});

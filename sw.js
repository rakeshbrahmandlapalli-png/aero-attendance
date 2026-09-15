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

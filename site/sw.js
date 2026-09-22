// Network-only: never store market data, wallet responses or signed requests.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", event => {
  if (event.request.mode !== "navigate" || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).catch(() => new Response(
    '<!doctype html><html lang="es"><meta name="viewport" content="width=device-width, initial-scale=1"><title>TRENCHES - Sin conexion</title><body style="background:#0b1221;color:white;font:18px system-ui;padding:36px"><h1>Sin conexion</h1><p>Conectate a Internet para consultar mercados y operar.</p><a style="color:#a78bfa" href="/app.html">Volver a intentar</a></body></html>',
    {status:503,headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"}}
  )));
});

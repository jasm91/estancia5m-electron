/**
 * SG Ventas — Service Worker v0.7.23
 * Funcionalidades:
 *   1. Cache estático del shell (offline básico)
 *   2. Recepción de push notifications
 *   3. Click handler para abrir el panel en la conversación correcta
 *   4. v0.7.15: SKIP_WAITING message handler para que el client pueda
 *      activar inmediatamente una nueva versión sin desinstalar la PWA
 *   5. v0.7.23: bump cache version (fix wa.me en modal de lead + fix
 *      selectConversation cambia tab a inbox)
 */

// v0.9.69 (auditoría 12-jun P1#15): el cache version quedó congelado en v0.7.23
// → el navegador nunca detectaba un sw.js nuevo → el banner "Actualizar" jamás
// disparaba y cada deploy requería Cmd+Shift+R manual. REGLA: bumpear esta
// constante EN CADA RELEASE que toque el panel (idealmente = APP_VERSION).
const CACHE_VERSION = 'sg-ventas-v0.9.580';
const STATIC_ASSETS = [
  './',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/icon-badge.png',
];

// === Install: precachear shell ===
// v0.7.15: NO hacemos skipWaiting() automático. Queremos que el SW nuevo
// quede en estado "waiting" para que el client pueda detectarlo y mostrar
// banner "Actualizar". Cuando el usuario toque ese banner, el client manda
// el mensaje SKIP_WAITING al SW (ver message handler abajo).
self.addEventListener('install', (event) => {
  // v0.9.296 — activar la versión nueva de INMEDIATO. Antes esperaba el banner del
  // client; si una versión quedaba rota y colgaba la página, no se podía tocar el banner
  // → la versión rota quedaba pegada. Con skipWaiting el SW nuevo entra solo.
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(STATIC_ASSETS).catch(() => {}))
  );
});

// === Activate: borrar caches viejos ===
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// === Fetch: network-first con fallback a cache ===
// (No interceptamos las rutas de API para que siempre pidan al servidor)
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Solo manejamos GETs del propio origen
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // No interferir con rutas API
  if (url.pathname.startsWith('/api/')) return;

  // v0.9.296 — el HTML del shell se pide SIEMPRE fresco (no-store) para que una versión
  // vieja/rota no quede servida desde la caché HTTP del navegador (fue la causa del cuelgue).
  const isShell = request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('/panel/') || url.pathname.endsWith('/index.html');
  event.respondWith(
    fetch(isShell ? new Request(request.url, { cache: 'no-store', credentials: 'same-origin' }) : request)
      .then((response) => {
        // Cachear solo respuestas válidas del shell
        if (response.ok && (url.pathname.endsWith('.svg') || url.pathname.endsWith('.webmanifest') || url.pathname === '/' || url.pathname.endsWith('/panel/') || url.pathname.endsWith('/index.html'))) {
          const clone = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, clone)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(request).then((c) => c || caches.match('./')))
  );
});

// === Push: mostrar notificación nativa ===
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'SG Ventas', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || '💬 SG Ventas';
  const options = {
    body: data.body || 'Tienes un mensaje nuevo',
    icon: './icons/icon-192.png',
    badge: './icons/icon-badge.png',
    // v0.9.254: si el server manda un tag explícito (ej. cita "appt-N"), se respeta para que esa
    // notif NO se colapse con las del chat (que usan el teléfono como tag). Fallback al tel o genérico.
    tag: data.tag || data.conversation_phone || 'sg-ventas-notif',
    renotify: true,
    requireInteraction: false,
    data: {
      url: data.url || './',
      conversation_phone: data.conversation_phone,
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// === Click en notificación: abrir/enfocar panel ===
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || './';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Si ya hay una ventana abierta, enfocarla
      for (const client of clients) {
        if (client.url.includes('/panel') && 'focus' in client) {
          if (event.notification.data?.conversation_phone && 'navigate' in client) {
            client.navigate(targetUrl).catch(() => {});
          }
          return client.focus();
        }
      }
      // Si no, abrir nueva
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});

// === v0.7.15: SKIP_WAITING message handler ===
// El client puede mandar este mensaje cuando el usuario toca "Actualizar".
// Esto fuerza al SW nuevo (que está en estado "waiting") a activarse
// inmediatamente sin necesidad de cerrar todas las pestañas/PWA.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

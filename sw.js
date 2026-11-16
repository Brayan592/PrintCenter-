// PrintCenterPro Service Worker - v.20.26.11.100 Uptade IA
const CACHE_NAME = 'printcenterpro-v20.26.11.100';
const APP_SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon.svg',
  '/pwa-192x192.png',
  '/pwa-512x512.png',
  '/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(APP_SHELL_ASSETS).catch(() => {});
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
          return null;
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never intercept or cache API calls, SSE streams, or cross-origin requests
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) {
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('/', clone)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('/') || caches.match('/index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});

function buildNotificationOptions(payload = {}) {
  const data = payload.data || {};
  return {
    body: payload.body || 'Tienes una nueva alerta operativa en PrintCenterPro.',
    icon: payload.icon || '/pwa-192x192.png',
    badge: payload.badge || '/pwa-192x192.png',
    tag: payload.tag || ('pcp-alert-' + (data.alertType || 'general')),
    renotify: Boolean(payload.renotify !== false),
    requireInteraction: Boolean(data.urgency === 'critical' || payload.requireInteraction),
    vibrate: data.urgency === 'critical' ? [220, 90, 220, 90, 280] : [160, 80, 160],
    timestamp: payload.timestamp || Date.now(),
    data: {
      url: data.url || '/',
      tab: data.tab || 'dashboard',
      alertType: data.alertType || 'general',
      noteId: data.noteId || null,
      targetId: data.targetId || null,
      urgency: data.urgency || 'warning'
    },
    actions: payload.actions || [
      { action: 'open_tab', title: data.actionLabel || 'Ver ahora' },
      { action: 'mark_read', title: 'Marcar vista' }
    ]
  };
}

// Receive W3C Web Push notifications from backend
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = {
      title: 'PrintCenterPro Admin',
      body: event.data ? event.data.text() : 'Alerta del sistema'
    };
  }

  const title = payload.title || 'PrintCenterPro Admin';
  const options = buildNotificationOptions(payload);

  event.waitUntil(
    self.registration.showNotification(title, options).then(async () => {
      const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      windowClients.forEach((client) => {
        client.postMessage({
          type: 'PUSH_RECEIVED',
          payload: { title, ...options }
        });
      });
    })
  );
});

// Handle direct notification trigger & lifecycle messages from active page
self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (msg.type === 'SHOW_ADMIN_NOTIFICATION' && msg.payload) {
    const title = msg.payload.title || 'Alerta PrintCenterPro';
    const options = buildNotificationOptions(msg.payload);
    event.waitUntil(self.registration.showNotification(title, options));
  }
});

// Handle click on notification or action button
self.addEventListener('notificationclick', (event) => {
  const notification = event.notification;
  const data = notification.data || {};
  const action = event.action || 'open_tab';
  notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      const targetTab = data.tab || 'dashboard';
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        if ('focus' in client) {
          client.postMessage({
            type: 'NOTIFICATION_CLICKED',
            action,
            data
          });
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        const query = `?alertTab=${encodeURIComponent(targetTab)}${data.noteId ? `&noteId=${encodeURIComponent(data.noteId)}` : ''}`;
        return self.clients.openWindow('/' + query);
      }
      return null;
    })
  );
});

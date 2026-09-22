self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request, { cache: 'no-store' }));
});
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data?.json() || {}; } catch {}
  event.waitUntil(self.registration.showNotification(data.title || '分析狀態更新', {
    body: data.body || '請返回網站查看分析結果。',
    tag: data.tag || 'analysis-completion',
    icon: '/icons/app-icon-192.png',
    data: { url: data.url || '/' },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    let url = new URL('/', self.location.origin);
    try {
      const candidate = new URL(event.notification.data?.url || '/', self.location.origin);
      if (candidate.origin === self.location.origin && candidate.pathname === '/') url = candidate;
    } catch {}
    // Open the saved result separately; never navigate away from an active task.
    await self.clients.openWindow(url.href);
  })());
});

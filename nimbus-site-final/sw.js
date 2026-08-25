self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));

self.addEventListener('push', e => {
  const d = e.data ? e.data.json() : { title: 'Nimbus â˜ï¸', body: 'Hey!' };
  e.waitUntil(self.registration.showNotification(d.title || 'Nimbus', {
    body: d.body || '',
    icon: d.icon || '',
    badge: d.badge || '',
    tag: d.tag || 'nimbus',
    data: d.data || {}
  }));
});

self.addEventListener('notificationclick', e => {
  const data = e.notification.data || {};
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    for (const c of cs) {
      if (c.url && 'focus' in c) {
        c.postMessage({ nimbusNotifClick: true, data });
        return c.focus();
      }
    }
    const qs = new URLSearchParams();
    if (data.type) qs.set('open', data.type);
    if (data.id != null) qs.set('id', data.id);
    const target = self.registration.scope + (qs.toString() ? ('?' + qs.toString()) : '');
    if (clients.openWindow) return clients.openWindow(target);
  }));
});


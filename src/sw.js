self.addEventListener('push', function(event) {
  var data = { title: 'CC Channel', body: 'New message' }
  try { data = event.data.json() } catch(e) {}
  event.waitUntil(
    self.registration.showNotification(data.title || 'CC Channel', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'channel-msg',
      renotify: true,
      data: data
    })
  )
})

self.addEventListener('notificationclick', function(event) {
  event.notification.close()
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(cl) {
      for (var i = 0; i < cl.length; i++) {
        if (cl[i].url.includes(self.registration.scope)) return cl[i].focus()
      }
      return clients.openWindow('/')
    })
  )
})

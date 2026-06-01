self.addEventListener('push', function(event) {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { body: event.data ? event.data.text() : 'New notification!' };
  }

  const title = data.title || 'NotifyFlow Alert';
  const options = {
    body: data.body || 'You have a new B2B notification!',
    icon: 'https://images.unsplash.com/photo-1579783902614-a3fb3927b6a5?w=128&auto=format&fit=crop&q=60',
    badge: 'https://images.unsplash.com/photo-1579783902614-a3fb3927b6a5?w=128&auto=format&fit=crop&q=60',
    data: data.data || {},
    vibrate: [100, 50, 100],
    actions: [
      { action: 'explore', title: 'Open Dashboard' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    clients.openWindow('http://localhost:5173/')
  );
});

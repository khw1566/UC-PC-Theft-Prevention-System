// PCGuard 서비스 워커: 브라우저가 닫혀 있어도 푸시 알림을 띄웁니다.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { title: "PCGuard", body: event.data && event.data.text() };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "PCGuard", {
      body: data.body || "",
      icon: "/static/icon-192.png",
      badge: "/static/icon-192.png",
      data: { url: data.url || "/" },
      requireInteraction: true,
      vibrate: [200, 100, 200],
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data.url || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (w.url.startsWith(self.location.origin)) return w.navigate(url).then((c) => (c || w).focus());
      }
      return self.clients.openWindow(url);
    })
  );
});

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));
// No fetch handler: every request goes straight to the network (live trading data, login redirects).

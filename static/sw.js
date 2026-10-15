// Notespice service worker.
//
// Deliberately minimal, matching the rest of this app: it exists to
// satisfy the two things a PWA actually needs a service worker for -
// installability, and the app shell still loading if the network is
// briefly unavailable. It does NOT cache note data. Every /api/
// request always goes straight to the network; caching that would
// mean occasionally showing stale notes, which is a much worse outcome
// for a notes app than "this one request failed."
const SHELL_CACHE = "notespice-shell-v22";
const SHELL_FILES = [
  "/",
  "/app.js",
  "/style.css",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/fonts/TrindleSans-Variable.woff2",
  "/fonts/TrindleSans-Italic-Variable.woff2",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never intercept API calls - always hit the network directly.
  if (url.pathname.startsWith("/api/")) return;

  // Shell files: try the network first (so updates are picked up
  // immediately when online), falling back to the cached copy only if
  // the network request fails.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

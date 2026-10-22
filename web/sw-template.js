// Let's Sing service worker: makes the app installable and usable offline.
// `npm run build` copies this to dist/sw.js with VERSION and SHELL filled in
// (scripts/stamp-sw.mjs).
//
// Two caches:
// - The app shell (page, code, icons, hymn list, soundfont) lives in a cache
//   named after VERSION, a hash of every published file. Any release installs
//   a new worker that starts a fresh shell cache and deletes the old one.
// - Hymn MIDI files and scores live in CONTENT_CACHE, which releases never delete.
//   The app requests them as midi/<file>?v=<content hash> (scores/ likewise), so an unchanged hymn keeps
//   its offline copy across updates and a changed one is a new URL, fetched
//   fresh. The page removes copies no current hymn uses (pruneOldHymns in
//   src/main.js).

const VERSION = "__VERSION__";
const CACHE = `lets-sing-${VERSION}`;
const CONTENT_CACHE = "lets-sing-content";
const SHELL = __SHELL__;

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys
                .filter((k) => k.startsWith("lets-sing-") && k !== CACHE && k !== CONTENT_CACHE)
                .map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener("fetch", (event) => {
    const req = event.request;
    const url = new URL(req.url);
    if (req.method !== "GET" || url.origin !== location.origin) return;

    if (req.mode === "navigate") {
        // Network first, so an online visit always gets the current version;
        // offline, the cached app page.
        event.respondWith(
            fetch(req).catch(() => caches.match("./index.html", { ignoreSearch: true, ignoreVary: true }))
        );
        return;
    }

    // Hymns: matched exactly, version query included. Everything else ignores
    // the query string.
    const isHymn = url.pathname.includes("/midi/") || url.pathname.includes("/scores/");
    const cacheName = isHymn ? CONTENT_CACHE : CACHE;
    // ignoreVary: script/style tags send an Origin header the install-time
    // request didn't, and servers that answer with "Vary: Origin" would
    // otherwise turn every cached file into a miss when offline.
    const options = { ignoreSearch: !isHymn, ignoreVary: true };

    event.respondWith(
        caches.open(cacheName).then(async (cache) => {
            const hit = await cache.match(req, options);
            if (hit) return hit;
            const res = await fetch(req);
            if (res.ok) cache.put(req, res.clone());
            return res;
        })
    );
});

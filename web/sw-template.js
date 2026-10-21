// Let's Sing service worker: makes the app installable and usable offline.
// `npm run build` copies this to dist/sw.js with VERSION and SHELL filled in
// (scripts/stamp-sw.mjs).
//
// - The app shell (page, code, icons, hymn list, soundfont) is cached on install.
// - Each hymn's MIDI file is cached the first time it's played, or all at once
//   with the "Download all hymns" button.
// - Everything is cache-first. VERSION is a hash of every published file, so
//   any change (new hymn, fixed MIDI, app update) installs a new worker that
//   starts a fresh cache and deletes the old one -- no stale files can linger.

const VERSION = "__VERSION__";
const CACHE = `lets-sing-${VERSION}`;
const SHELL = __SHELL__;

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k.startsWith("lets-sing-") && k !== CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener("fetch", (event) => {
    const req = event.request;
    if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;

    if (req.mode === "navigate") {
        // Network first, so an online visit always gets the current version;
        // offline, the cached app page.
        event.respondWith(
            fetch(req).catch(() => caches.match("./index.html", { ignoreSearch: true, ignoreVary: true }))
        );
        return;
    }

    event.respondWith(
        caches.open(CACHE).then(async (cache) => {
            // ignoreVary: script/style tags send an Origin header the install-time
            // request didn't, and servers that answer with "Vary: Origin" would
            // otherwise turn every cached file into a miss when offline.
            const hit = await cache.match(req, { ignoreSearch: true, ignoreVary: true });
            if (hit) return hit;
            const res = await fetch(req);
            if (res.ok) cache.put(req, res.clone());
            return res;
        })
    );
});

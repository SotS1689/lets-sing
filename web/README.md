# Let's Sing — web app (PWA)

The browser version of Let's Sing: the same hymn list and four-part player as
the Android app, installable from the browser ("Add to Home Screen") and usable
offline. No Android Studio or Play Store involved.

## Everyday commands (run inside `web/`)

| Command | What it does |
|---|---|
| `npm install` | One-time setup (downloads the libraries into `node_modules/`). |
| `npm run dev` | Runs the app at http://localhost:5173 and reloads as you edit. |
| `npm run build` | Makes the finished site in `dist/`, ready to upload to any static host. |
| `npm run preview` | Serves `dist/` at http://localhost:4173 to try the real build, including offline mode. |

Both `dev` and `build` first run `scripts/prepare-content.mjs`, which copies
the **root `hymns_data.json`** (still the one master copy) and the Android
project's `assets/midi/` files into `public/`. So the content workflow is
unchanged: edit the root JSON / add MIDI files as before, then build.

## How it works

- `src/main.js` — the two screens (list `#/`, player `#/hymn/<id>`), search, settings.
- `src/player.js` — playback via [SpessaSynth](https://github.com/spessasus/spessasynth_lib)
  (Apache-2.0) in an AudioWorklet. Channels 0–3 = S/A/T/B; each voice slider
  sets that channel's gain, tempo is the sequencer's playback rate (no pitch
  change), pitch is a global key shift.
- `public/soundfont/instruments.sf2` — only the four instruments the player
  offers (Grand Piano, Pipe Organ, Nylon Guitar, Concert Choir) from GeneralUser
  GS: 3.8 MB instead of 32 MB. The chosen one (default Piano, remembered per
  device) is locked onto every channel. Rebuild with `npm run build-soundfont`.
- Each part's name button turns it fully on/off (gain 0) without losing its
  slider setting.
- `sw-template.js` → `dist/sw.js` — the service worker. Caches the app shell on
  install and each MIDI on first play (or all at once via the "Download all"
  button). The cache name is a hash of every published file, so any content
  change replaces the whole cache — no stale MIDI files.
- Icons: `python scripts/make_icons.py` redraws them from the Android launcher artwork.

## Publishing

The live site is **https://sots1689.github.io/lets-sing/**. Every push to
`main` that changes `web/`, `hymns_data.json` or the Android MIDI folder
rebuilds and republishes it automatically (`.github/workflows/pages.yml`;
progress shows in the repo's **Actions** tab, usually done in about a minute).
Installed copies pick up the new version the next time they're opened online.

## Testing on a phone

Audio worklets and offline support only work over **HTTPS** (or on
`localhost`), so opening the dev server from a phone by its local IP address
won't play sound. Test on a phone with the live site above.

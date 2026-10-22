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

## Sheet music

The player shows the hymn's score and lights each note as it sounds, every part
in its own colour (the ring around its S/A/T/B button), only for parts that are
switched on. The design follows the #doreancon hymnal player
(gitlab.com/svrbc/doreancon.org), used with its developer's permission.

- **Scores** are Open Hymnal's own ABC files, in `../Sheet Music/abc/`, named
  like the hymn's MIDI file (`<name>.abc` beside `<name>.mid`).
  `python "../Sheet Music/download_openhymnal_abc.py"` fetches any that are
  missing; to add a score from elsewhere, drop it in with the matching name.
- **`scripts/build-scores.mjs`** (run by prepare-content) works out, ahead of
  time, when every notehead sounds in *our* MIDI file: each part's MIDI notes are
  matched by pitch against the score line it follows, which handles intros,
  every verse, repeats, ties, and parts written as chords. A score whose notes
  don't line up with the MIDI is **left out**, with the reason printed during
  the build, rather than lighting the wrong notes. So are scores with organ or
  accompaniment staves. The results go to `public/scores/` (`.abc` + `.json` note map).
- A score belongs to the tune, so hymns sharing a tune share it. The words under
  its notes are shown only when they are that hymn's own verse 1 (a psalm sung to
  a hymn's tune shows the notes alone), and the verse being sung is followed only
  when the MIDI plays that hymn's verses.
- **`src/score.js`** draws the score with [abcjs](https://abcjs.net) (MIT)
  and lights the notes. It loads only on a hymn's page. Two views, switched in
  the Music card's header and remembered per device:
  - **Scroll** (the default): the whole tune on one long line, at a size readable
    on a phone, sliding past so the note being sung stays just short of the middle (passing it
    halfway through each note), with the notes just sung still in sight on its
    left and the next ones on its right. The line holds the tune twice, end to
    end (this verse, then the next with its words), so the end of a verse runs
    straight on into the next one. It's redrawn a verse along once the old verse
    has slid out of sight, so the swap doesn't show. Only the current verse's words are under
    it, swapped in as each verse starts, and the clef and key are pinned at the left edge.
  - **Page**: the score as a hymnal prints it, reflowed to the screen.
- Scores are cached like MIDI files: on first view, kept across app updates
  unless they change, and included in "Download all".

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

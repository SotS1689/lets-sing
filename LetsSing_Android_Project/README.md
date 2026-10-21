# Let's Sing — Phase 1 (Android, Kotlin + Jetpack Compose)

A hymn-harmony learning app: browse/search 338 public-domain hymns
(sourced from OpenHymnal.org), play back true 4-part SATB MIDI with
independent per-voice volume sliders, and a live tempo slider. Karaoke-
style timed lyric sync is intentionally **not** included yet — lyrics are
shown as plain static text for now.

## What's implemented

- **Browse/search**: alphabetical list, live search over title/tune/composer.
- **Room database**, seeded on first launch from `assets/hymns_data.json`.
- **MIDI playback via TinySoundFont + TinyMidiLoader (JNI)** — see
  "Audio engine" below for why this replaced an earlier FluidSynth plan.
- **Per-voice volume sliders** (Soprano/Alto/Tenor/Bass): each sends a
  live MIDI CC7 (channel volume) message to that voice's channel.
  Channel mapping (0=S, 1=A, 2=T, 3=B) is based on OpenHymnal's ABC
  voice convention and **verified against a real downloaded file**
  (`Abide_With_Me-Eventide.mid`): channel 0 had the highest average note
  pitch (67.3), descending through channels 1, 2, 3 (down to 48.3,
  lowest) — exactly S/A/T/B order. Only spot-checked on that one file,
  not all 338 — worth a second check if any hymn's parts sound swapped.
- **Tempo slider** (50%-150%): scales how fast the engine advances
  through the MIDI event timeline relative to real audio time. Since
  this is symbolic (not audio time-stretching), there's no pitch
  distortion at any speed, and no per-file BPM bookkeeping is needed —
  "100%" is correct for every hymn automatically, whatever its own
  original tempo is.
- **SoundFont bundled**: `assets/soundfonts/default.sf2` is
  GeneralUser GS (proper General MIDI mapping, free/unrestricted
  license — see `GeneralUser-GS-LICENSE.txt` next to it). The engine
  explicitly forces every SATB channel onto GM program 52 (Concert
  Choir) at load time, rather than trusting the file's own Program
  Change data (which is Grand Piano/program 0 for all of OpenHymnal's
  files) — a sustained choir-like timbre suits a "learn to sing your
  part" app better. Change `kDefaultGmProgram` in `native-lib.cpp` to
  try something else (e.g. 19 = Pipe Organ).

## What's NOT implemented yet

- Karaoke-style lyric highlighting synced to playback position.
- Hymnal-order browsing (Trinity Hymnal numbering) — only ~163 of the 338
  hymns have a confirmed Trinity Hymnal cross-reference from earlier data
  work; alphabetical browsing + search cover the gap for now.
- MIDI files — **you need to add these** (see below); everything else
  (soundfont, native audio libraries) is now bundled and requires no
  extra setup.

## Required setup before this builds

### 1. MIDI files

Copy your already-downloaded OpenHymnal `.mid` files into:

    app/src/main/assets/midi/

The file names must exactly match the `midi_url`'s last path segment for
each hymn in `assets/hymns_data.json` (e.g. `Amazing_Grace-New_Britain.mid`).

### 2. SoundFont and native audio library — already done

Unlike an earlier version of this project, **nothing external needs to
be added**. The SoundFont is bundled at `assets/soundfonts/default.sf2`,
and the native audio code (`tsf.h` / `tml.h`, MIT-licensed, zero
dependencies) is vendored directly under
`app/src/main/cpp/third_party/tsf/`. No git submodule, no prebuilt
binaries to source, no NDK dependency chain to assemble.

### 3. Standard Android project setup

This project is missing the Gradle wrapper binary/jar (not something a
text-based tool can usefully generate) — open it in a recent Android
Studio and let it regenerate the wrapper, or run `gradle wrapper` once
you have a local Gradle install.

## Audio engine: why TinySoundFont instead of FluidSynth

An earlier version of this project targeted FluidSynth. That turned out
to be substantially more work than it looked: FluidSynth's actual Android
build requires cross-compiling a full dependency chain from source —
glib, gettext, libffi, libinstpatch, libsndfile, oboe, and FluidSynth
itself (see FluidSynth's own `.azure/azure-pipelines-android.yml` for
what that really involves — it's a legitimate multi-hour CI pipeline).
That's not something reasonable to set up by hand, and not something
achievable in a sandboxed environment without NDK/network access to
gnu.org/gnome.org/xiph.org either.

**TinySoundFont** (`tsf.h`) + **TinyMidiLoader** (`tml.h`) cover the same
core need — SoundFont-based playback with per-channel volume and
adjustable tempo — as single-header, dependency-free, MIT-licensed C
libraries. The tradeoff is losing some of FluidSynth's more advanced
features (reverb/chorus DSP, more nuanced envelope handling), which this
app doesn't need.

This also meant writing our own playback loop instead of using a
library's built-in "player" (FluidSynth has one; TinySoundFont doesn't).
That turned out to be a net win for this app specifically: tempo control
is just "how fast do we advance through the MIDI message timeline
relative to real audio time," fully within our own code, rather than
depending on a specific library API for tempo override.

## Architecture notes

- **`audio/MidiEngine.kt`** — Kotlin-facing API; wraps the JNI calls into
  a clean interface (`init`, `load`, `play`, `pause`, `stop`, `seekFraction`,
  `setVoiceVolume`, `setTempoScale`, `pollPosition`).
- **`cpp/native-lib.cpp`** — the real playback engine: owns a TinySoundFont
  synth instance, a parsed TinyMidiLoader message list, and an AAudio
  stream with a data callback that advances through MIDI messages and
  renders audio each callback, guarded by a mutex shared with the
  JNI-exposed control functions (play/pause/seek/volume/tempo).
- **`data/`** — Room entity/DAO/database + the one-time JSON importer.
- **`ui/`** — two Compose screens (list, detail/player) each backed by
  their own ViewModel.

## Known simplifications worth revisiting

- The audio callback holds a `std::mutex` shared with UI-thread-triggered
  JNI calls (volume/tempo/seek changes). Lock hold times are short, but
  a real-time audio callback blocking on a mutex at all is a known
  simplification — a lock-free or double-buffered state handoff would be
  the fully "correct" real-time-safe approach. Not expected to cause
  audible issues in practice for this app's usage pattern, but worth
  knowing about.
- The AAudio stream is opened once and left running continuously
  (outputting silence when paused/stopped) rather than started/stopped
  per play/pause, to avoid AAudio's stream-start latency. Small always-on
  battery cost while a hymn's detail screen is open.
- SATB channel mapping (0/1/2/3) was verified against **one** real file
  (`Abide_With_Me-Eventide.mid`) — a global assumption applied to all 338
  hymns based on that single check plus OpenHymnal's documented ABC
  convention. Worth spot-checking a few more before fully trusting it.
- Slider values currently persist across hymns rather than resetting to
  hymn-specific defaults; change this in `PlayerViewModel.loadHymn()` if
  you'd rather each hymn open at 100/100/100/100/100%.
- The bundled SoundFont is ~32MB, which will show up directly in APK
  size. Fine for Phase 1 development; worth reconsidering (smaller
  SoundFont, or download-on-first-launch instead of bundling) before a
  real release.

## Beta testing: emulator vs. real device

Both work, and you don't need a phone to start:

- **Android Studio's built-in emulator** (Device Manager / AVD) runs a
  virtual phone directly on your PC, audio included, no cable needed.
  This project's `abiFilters` includes `x86_64` specifically so it runs
  on the emulator without extra config. Good for iterating quickly.
- **A real device via USB debugging** (enable Developer Options + USB
  debugging on the phone) shows up as a run target right alongside the
  emulator in Android Studio — same build, not a separate process. Worth
  a final check here before considering something "beta ready," since
  audio latency/behavior can differ slightly from the emulator.

Neither of these gets you to *other people's* phones for a wider beta —
that's a separate step later (Google Play's internal testing track, or
Firebase App Distribution).

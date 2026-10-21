# Psalm database workflow

> Only the ongoing intake tool (`compile_psalms.py`, `Psalms_To_Add.xlsx`) and
> `full_1912_psalter_index.json` live here now. The other scripts and data
> this README mentions (MIDI sourcing, research output, backups) were moved
> (2026-10-21) to `..\..\Let's Sing App - Archive\Psalms\`, same file names.

Adds all 150 metrical Psalms into the same `hymns_data.json` the app already
seeds from, using the same spreadsheet-intake pattern as
[`Missing Hymns/compile_hymns.py`](../Missing%20Hymns/compile_hymns.py).

## Current status (2026-09-08)

- **145 of 150 Psalms have a dedicated entry** in `hymns_data.json`, all
  with real, verbatim public-domain text (never AI-recalled, never copied
  from a Trinity Psalter Hymnal page). The remaining 5 (Psalms 72, 90, 98,
  100, 146) are intentionally *not* duplicated as separate entries — their
  public-domain text turned out to be word-for-word identical to a hymn
  already in the library, so those existing hymns were retitled with the
  psalm number in parentheses instead (e.g. `All People That On Earth Do
  Dwell (Psalm 100)`) — see the table below. Psalm 23 *was* kept as a
  genuine second setting, since its researched text (Rous/Crimond) actually
  differs from the existing hymn's (Bain/Brother James' Air alt.).
- **All 145 entries now have MIDI** — see "MIDI" below for how.

## The copyright situation (read this first)

You love the **Trinity Psalter** (Crown & Covenant Publications, 1994), but
its exact wording is under active copyright and **cannot** be reproduced in
a distributed app without permission. The workaround: Trinity Psalter draws
heavily from **The Psalter, 1912** (a joint Presbyterian psalter that *is*
public domain — it predates 1928), so its wording is usually very close to
what you actually want, with zero copyright risk.

**Text source priority for every Psalm, in order:**
1. **The Psalter, 1912** — closest in spirit/wording to Trinity Psalter.
2. **The Scottish Psalter, 1650** — public domain, more archaic English.
3. **Isaac Watts, "The Psalms of David Imitated," 1719** — public domain,
   freer Christianized paraphrase (e.g. "Joy to the World" = Psalm 98).

**Tunes are not the copyright problem** — the tunes Trinity Psalter pairs
with each psalm are almost all centuries-old public-domain melodies (the
same pool your 338 existing hymns already draw from). It's fine to pick the
same tune Trinity Psalter uses for a given psalm (that pairing is a fact,
not their copyrighted expression) — just don't copy their verse text.

`compile_psalms.py` actively **blocks** (won't merge) any row whose
`text_source` mentions Trinity Psalter, Book of Psalms for Worship/Singing,
or later copyrighted Psalter Hymnal editions — a safety net, not a
substitute for checking the actual wording yourself. It also blocks (not
just warns on) any row whose `psalm_number` already has a dedicated entry
in `hymns_data.json`, so re-running `populate_from_master.py` after a merge
can never silently create a duplicate.

## Files

- **`Psalms_To_Add.xlsx`** — intake spreadsheet, sheet **"To Add"**, one row
  pre-numbered for each Psalm 1-150. Fill in the yellow-equivalent columns;
  row 3 is a worked example (Psalm 23 / Crimond / The Psalter, 1912).
- **`compile_psalms.py`** — merges finished rows into `../hymns_data.json`,
  adding a `psalm_number` field to each new entry (everything else uses the
  same schema as the existing hymns: `title`, `tune`, `composer_arranger`,
  `midi_url`, `mp3_url`, `verses`, `credits`, plus new `meter` and
  `text_source` fields).
- **`generate_psalms_template.py`** — one-time generator for
  `Psalms_To_Add.xlsx`. Don't re-run this once you've started filling rows
  in (it will refuse to overwrite unless you pass `--force`, which discards
  your work).
- **`build_master_list.py`, `populate_from_master.py`, `psalms_master.json`,
  `research_output/`** — the research → scrape → spreadsheet pipeline used
  to get the first 128 psalms' text (see git/session history for how it
  works; `psalms_master.json` is the merged, reusable result).
- **`parse_full_index.py`, `full_1912_psalter_index.json`** — a complete,
  parsed copy of *The Psalter, 1912*'s table of contents (from
  `hymnary.org/hymnal/PS1912`) — every setting of every psalm in the book,
  with full verbatim text. Used to finish the last 17 psalms; also the
  place to look if you ever want a *second* setting for a psalm that
  already has one.
- **`source_midi.py`, `apply_midi_sourcing.py`, `psalm_midi_sourcing.json`,
  `psalm_midi_remaining.json`, `psalm_midi/`** — the MIDI-sourcing pipeline
  (see "MIDI" below).

## Adding Psalms

1. Open `Psalms_To_Add.xlsx`, sheet "To Add". `psalm_number` is already
   filled in for all 150 rows.
2. For each row, fill in:
   - **title** — the first line/title of the public-domain text you're using.
   - **tune** — a real, public-domain hymn tune matching the meter.
   - **meter** — e.g. `CM`, `LM`, `8.7.8.7`.
   - **text_source** — e.g. `The Psalter, 1912`. Never `Trinity Psalter`.
   - **verses** — each verse its own paragraph (Alt+Enter for a line break
     within a verse, blank line between verses). Refrains start their own
     paragraph with the word "Refrain".
   - **composer_arranger**, **midi_url**, **mp3_url**, **credits** — same
     conventions as the hymn workflow.
   - A row is only picked up once it has `psalm_number` + `title` + `verses`
     — you don't have to finish every column in one sitting.
3. Run:
   ```
   py compile_psalms.py
   ```
   (or `python3 compile_psalms.py` if that's on your PATH). Use
   `--dry-run` to preview without writing anything.

## A few Psalm numbers are covered by a retitled hymn, not a dedicated entry

These hymns' text is word-for-word identical to a Psalm, so rather than
duplicate them they were retitled with "(Psalm N)" and left as-is (Psalm 23
is the one exception — it *does* have its own dedicated, textually-distinct
entry, since the researched Psalm 23 text (Rous/Crimond) differs from this
hymn's):

| Psalm | Existing hymn (now retitled) |
|---|---|
| 23 | "The Lord's My Shepherd" (Scottish Psalter/Bain, 1650/1915) — kept separate; a distinct "The Lord's My Shepherd, I'll Not Want" (Rous/Crimond) entry also exists |
| 72 | "Jesus Shall Reign (Psalm 72)" |
| 90 | "Our God, Our Help In Ages Past (Psalm 90)" |
| 98 | "Joy to the World (Psalm 98)" |
| 100 | "All People That On Earth Do Dwell (Psalm 100)" |
| 146 | "Hallelujah, Praise Jehovah, O My Soul (Psalm 146)" |

If you ever want a second, textually-distinct setting for 72/90/98/100/146
(the way Psalm 23 has one), `compile_psalms.py` will only block a
`psalm_number` that already has a *dedicated psalm entry* — these five
don't have one (just a retitled hymn), so adding one later works normally.

## Psalm 119

It's unusually long (176 verses, 22 acrostic sections). For this
one-setting-per-psalm pass, only the opening ALEPH stanza (vv. 1-8) was
set, matching the 1912 Psalter's own first section for this psalm.

## MIDI (145 of 145 psalms done)

`source_midi.py` sources a MIDI file for every psalm's tune, two ways:

1. **Reuse** — if the tune's already used by an existing hymn in
   `hymns_data.json` (matched by normalized tune name), the psalm just
   points at that hymn's existing `midi_url`/file in `assets/midi/` — the
   MIDI content is the tune's music, independent of whose words it's
   paired with, so this is legitimate reuse, not a hack. **11 tunes**
   resolved this way, no download needed.
2. **Download from the Cyber Hymnal** (hymntime.com/tch) — a long-established,
   explicitly public-domain hymn-tune archive (see its `misc/copyrite.htm`)
   that predictably URLs each tune at `mid/<l1>/<l2>/<l3>/<l4>/<slug>.mid`.
   **129 tunes** resolved this way across two passes: 103 by directly
   guessing/verifying the slug (`source_midi.py`), and another 36 whose
   slug is disambiguated by composer (e.g. `richmond_haweis.mid`, not
   `richmond.mid`) — found by cross-referencing Cyber Hymnal's own tune
   index and hymnary.org (`psalm_midi_remaining.json` has the full
   reasoning per tune, including composer/meter confirmation).

Every downloaded file is verified before being trusted — not just an HTTP
200, the actual bytes must start with the real MIDI header `MThd` — then
staged in `psalm_midi/` and copied into
`../LetsSing_Android_Project/app/src/main/assets/midi/`.

3. **User-supplied files, converted to true SATB.** The last 5 tunes
   (CULROSS, ST. LEONARD, Jude/Galilee, Ulster, Amelia) came back
   genuinely not-found from two research passes (see git/session history
   for why) — you found and supplied a public-domain MIDI for each
   yourself. Every one of those files turned out to be a standard
   NoteWorthy-Composer **2-voice-per-staff** export (channel 0 = Soprano+Alto
   stacked as two simultaneous notes, channel 1 = Tenor+Bass the same way)
   rather than 4 independent channels, which would have silently broken the
   per-voice volume sliders (S and A would move together, T and B would
   move together). `convert_2voice_to_satb.py` splits each pair into two
   true monophonic channels — at each moment two notes sound together, the
   higher one becomes the upper voice and the lower one the lower voice; a
   lone note (a unison moment) is duplicated into both, since that's what's
   actually happening in the score. Verified by checking each output's
   average pitch per channel comes out cleanly descending
   (Soprano > Alto > Tenor > Bass), the same sanity check the main app
   README uses to confirm channel mapping.

   Cross-checking these 5 tunes against their psalm's actual verse text
   caught **3 wrong meter tags** left over from the very first, least-verified
   research pass (Psalms 101-150 batch, which warned most of its meters were
   "assumed CM, not independently verified"):
   - **Psalm 128**: tagged CM, actually **8.7.8.7** — the tune name "Jude"
     was also wrong (that's the *composer*, William H. Jude; the tune is
     **Galilee**). Both fixed.
   - **Psalm 132**: tagged CM, actually **8.7.8.7** — matches "Ulster"
     (a.k.a. "All the Way," Robert Lowry) correctly once fixed.
   - **Psalm 148**: tagged CM, actually **66.66.88** — "Amelia" was a
     wrong-meter tune with no real PD MIDI; **Millennium** (Plymouth
     Collection, 1855), the tune you supplied, is a correct 66.66.88 match
     and is now used instead.

   ST. LEONARD (Psalm 96) and CULROSS (Psalm 93) needed no meter/tune
   correction — those were already right, just missing a file.

A handful of the tunes downloaded automatically are still flagged "medium
confidence" in `psalm_midi_remaining.json` (Petition, SOUTHPORT, CHRISTINE,
Sacred Morn, Rose Hill) — meter or title matched but not both independently
confirmed; worth a quick listen before trusting them fully.

## Note for the Android app

The app's Room entity/JSON importer (`LetsSing_Android_Project/app/.../data/`)
currently only knows about the original hymn fields. Now that Psalms have
landed in `hymns_data.json` with `psalm_number`/`meter`/`text_source`, those
fields need corresponding columns added to the Room entity and the importer
before a "browse by Psalm number" view can use them — a separate, small
app-code change, not part of this data-compilation step.

# Hymn database workflow

## From a Cyber Hymnal page (one command)

For a hymn on the Cyber Hymnal (hymntime.com/tch/htm/...), including another
tune for a hymn the app already has, run from the project folder:

```
python "Missing Hymns/add_from_cyber_hymnal.py" "<page url>"
```

Options: `--tune NAME` picks one of the page's alternate tunes (any part of its
name), `--verses 1-4,6` keeps only some stanzas, `--title TEXT` lists it under
another title, `--dry-run` shows what it would add without changing anything.

It takes the words (a refrain is written out after every verse), reuses the
app's own MIDI and score when it already has the tune, otherwise fetches the
Cyber Hymnal's MIDI (split into four parts, played once per verse) and score,
adds the hymn to both `hymns_data.json` copies, and ends with a short summary,
including whether every verse's words fit under the notes (any that don't
still show as text). Nothing is committed; to undo a run, `git checkout -- .`
and delete the "new files" the summary lists. Needs Python with `mido`
(`pip install mido`) and Node; the first run downloads the CMU Pronouncing
Dictionary to `~/.cache/lets-sing/` for counting syllables.

In Claude Code, `/add-cyber-hymnal <url>` runs the same thing on a small, cheap
model, then has one Opus reviewer compare the result with the page, fix what it
can (titles, tune names, credits, a missing slur so the words fit, using the
Cyber Hymnal's PDF), and commit it. It then asks you before pushing to the live
site. The reviewer's checks are in `.claude/skills/add-cyber-hymnal/REVIEW.md`;
`node "Sheet Music/check_words.mjs" <hymn id>` shows why a verse's words don't
fit under the notes, and `--page-text` prints the page's words to compare.

## Words that don't fit a hymn the app already has

When a hymn's words don't line up under its notes, its Cyber Hymnal page can
put them back:

```
python "Missing Hymns/refit_from_cyber_hymnal.py" <hymn id> "<page url>"
```

It takes the page's words, and the page's NoteWorthy score with the words it
sets under the melody when it has one (`Sheet Music/nwc.mjs` reads them). Many
of the Cyber Hymnal's scores are the tune alone; then only the words change,
unless `--score` asks for the score anyway (its slurs still say which notes
share a syllable). The app's MIDI is kept when the new score matches it,
otherwise the Cyber Hymnal's takes its place (`--keep-midi` stops that).
`--tune NAME` picks the page's tune, `--keep-words` keeps the app's words,
`--dry-run` writes nothing. A tune the Cyber Hymnal doesn't have can be slurred
from an older score of it that sets words, such as the Open Hymnal's own:
`node "Sheet Music/slurs_from_abc.mjs" <midi file stem> <other score.abc>`.

## From the spreadsheet

> Only the ongoing intake tool lives here now. The one-off research and MIDI
> fix-up scripts, their data, and backups were moved (2026-10-21) to
> `..\..\Let's Sing App - Archive\Missing Hymns\`, same file names.

Three files, all local — no AI calls needed after today.

- **`hymns_data.json`** — your database (also fixed a stray trailing comma
  that was making the original file invalid JSON — it's parseable now).
- **`Hymns_To_Add.xlsx`** — where you type in new hymns. Pre-loaded with the
  62 titles from `Missing_Hymns.xlsx` in the "To Add" sheet.
- **`compile_hymns.py`** — run this to merge finished rows into the JSON.

## Adding hymns

1. Open `Hymns_To_Add.xlsx`, sheet **"To Add"**.
2. For any row, fill in the yellow cells: tune, verses, Author, Composer,
   midi_url, mp3_url, credits. Look at row 3 (the grey italic EXAMPLE row)
   for the expected format.
   - **Verses**: type each verse as its own paragraph inside the cell
     (Alt+Enter for a line break, blank line between verses via Alt+Enter
     twice). Refrains get their own paragraph starting with the word
     "Refrain".
   - You don't have to finish every row in one sitting — a row is only
     picked up once it has both a title and at least one verse.
3. Run:
   ```
   python3 compile_hymns.py
   ```
   This merges every finished row into `hymns_data.json`, assigns each new
   hymn the next available id, re-sorts the whole file alphabetically by
   title, and moves finished rows out of "To Add" into "Already Added" (with
   the date and assigned id) so the sheet always shows only what's left.

Use `python3 compile_hymns.py --dry-run` any time to preview what would
happen without changing anything.

## Adding more hymns later

Just add new rows to the bottom of "To Add" (or reuse the file — it never
runs out) and run the script again whenever you have a batch ready. Nothing
about the workflow changes over time.

## Notes

- The script warns (doesn't block) if a new title looks very close to one
  already in the database — useful because a few titles in the original
  missing-hymns list are near-duplicates of hymns already in the file
  (e.g. "And Can It Be?" vs. the existing "And Can It Be", "O for a Thousand
  Tongues to Sing" vs. the existing "O for a Thousand Tongues"). Worth a
  quick look before treating those as brand new hymns.
- IDs are never reused or reassigned for existing hymns — only new entries
  get new, incrementing ids. The *file order* is what gets re-sorted
  alphabetically each run, not the ids.

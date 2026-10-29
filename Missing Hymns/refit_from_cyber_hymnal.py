#!/usr/bin/env python3
"""
refit_from_cyber_hymnal.py

Puts a hymn the app already has back under its notes, from the Cyber Hymnal
page for it: the page's words become the hymn's, and the page's NoteWorthy
score, with the words it sets under its melody, becomes its sheet music. For a
hymn whose words don't fit the score it has (a score written out from the
MIDI, or another hymnal's, sets no words or other syllables).

    python "Missing Hymns/refit_from_cyber_hymnal.py" <hymn id> <page url> [options]

    --tune NAME     use the page's tune whose name contains NAME (default: the
                    one named like the hymn's tune, else the page's main tune)
    --verses 1-4,6  only these stanzas of the page (default: all of them)
    --keep-words    keep the hymn's own words; take only the score
    --dry-run       say what it would do, write nothing
    --score         take the Cyber Hymnal's score even when it sets no words
                    (its slurs still say which notes share a syllable)
    --keep-midi     never take the Cyber Hymnal's MIDI in place of the app's
    --no-build      skip the web build at the end (when refitting several)

Many of the Cyber Hymnal's scores are the tune alone, with no words: then the
app's score stays and only the words change. A score that sets words is kept
only when every part of the hymn's MIDI follows it. The
app's own MIDI is tried first (replayed for the new number of verses if that
changed); failing that, the Cyber Hymnal's MIDI, split into four parts, takes
its place. A MIDI another hymn shares is never changed: this hymn gets its own
file. Ends with a web build and says which verses' words fit under the notes.
Nothing is committed.
"""

import argparse
import io
import json
import re
import shutil
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path
from urllib.parse import quote

import mido

sys.path.insert(0, str(Path(__file__).resolve().parent))
import add_from_cyber_hymnal as ch  # noqa: E402

ROOT, MIDI_DIR, ABC_DIR = ch.ROOT, ch.MIDI_DIR, ch.ABC_DIR


def try_score(nwc, midi, verses, out, source):
    r = subprocess.run(["node", "Sheet Music/nwc_score.mjs", str(nwc), str(midi), str(verses), str(out), source],
                       cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
    try:
        return json.loads(r.stdout.strip().splitlines()[-1])
    except (IndexError, json.JSONDecodeError):
        return {"ok": False, "error": (r.stdout + r.stderr)[-400:]}


def replayed(src_path, old_count, new_count, dest):
    """The app's MIDI with its verse played `new_count` times instead of `old_count`."""
    src = mido.MidiFile(src_path)
    chans = ch.notes_by_channel(src)
    parts = [chans.get(c, []) for c in range(4)]
    found = ch.find_verse(parts, [old_count])
    if not found:
        return False
    ch.write_midi(dest, src.ticks_per_beat, ch.meta_events(src), parts, *found, new_count)
    return True


def fetch(url):
    """As the intake script fetches, with a file name's accents ("Güldne") escaped."""
    return ch.fetch(quote(url, safe=":/%"))


def sets_words(nwc_bytes):
    """Whether a Cyber Hymnal score sets words under its notes (a hymn's own
    score does; a tune's alone doesn't)."""
    if nwc_bytes[:5] != b"[NWZ]":
        return False
    return b"|Lyric1|Text:" in zlib.decompress(nwc_bytes[6:])


def update_hymn(hymn_id, **fields):
    for path in (ch.HYMNS_JSON,):
        hymns = json.loads(path.read_text(encoding="utf-8"))
        for h in hymns:
            if h["id"] == hymn_id:
                h.update(fields)
        path.write_text(json.dumps(hymns, indent=2, ensure_ascii=False), encoding="utf-8", newline="\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[1], formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("id", type=int)
    ap.add_argument("url")
    ap.add_argument("--tune")
    ap.add_argument("--verses")
    ap.add_argument("--keep-words", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-build", action="store_true")
    ap.add_argument("--keep-midi", action="store_true")
    ap.add_argument("--score", action="store_true")
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    hymns = json.loads(ch.HYMNS_JSON.read_text(encoding="utf-8"))
    hymn = next((h for h in hymns if h["id"] == args.id), None)
    if not hymn:
        sys.exit(f"No hymn {args.id}.")
    page = ch.read_page(quote(args.url, safe=":/%"))
    if not page["tunes"]:
        sys.exit("No tune found on the page.")
    wanted = args.tune or ""
    tune = None
    if wanted:
        tune = next((t for t in page["tunes"] if ch.norm(wanted) in ch.norm(t["name"])), None)
        if not tune:
            sys.exit(f"No tune matching {wanted!r}; the page has: " + ", ".join(t["name"] for t in page["tunes"]))
    else:
        mine = {ch.norm(t) for t in re.split(r"\s+or\s+|/|\(|\)", hymn.get("tune") or "") if ch.norm(t)}
        tune = next((t for t in page["tunes"] if ch.norm(t["name"]) in mine or any(m in ch.norm(t["name"]) for m in mine)), None)
        if not tune:
            sys.exit(f"{hymn['id']} {hymn['title']}: no tune on the page is named like {hymn.get('tune')!r}; it has: "
                     + ", ".join(t["name"] for t in page["tunes"]) + " (pick one with --tune)")
    if not tune["nwc"]:
        sys.exit(f"The Cyber Hymnal has no NoteWorthy score for {tune['name']}.")

    if args.keep_words:
        verses = hymn["verses"]
    else:
        stanzas = [page["stanzas"][i] for i in ch.pick_verses(args.verses, len(page["stanzas"]))]
        verses = [f"{i + 1}. " + "\n".join(lines) for i, lines in enumerate(stanzas)]

    old_file = ch.midi_file(hymn)
    old_path = MIDI_DIR / old_file
    sharers = [h for h in hymns if ch.midi_file(h) == old_file and h["id"] != hymn["id"]]
    stem = Path(old_file).stem
    if sharers:
        stem = f"{ch.slug(hymn['title'])}-{ch.slug(tune['name'])}"
        while (MIDI_DIR / f"{stem}.mid").exists():
            stem += "_2"
    print(f"{hymn['id']} {hymn['title']}  |  tune {tune['name']}  |  {len(hymn['verses'])} -> {len(verses)} verses"
          + (f"  |  own MIDI {stem}.mid (shares {old_file} with {', '.join(str(h['id']) for h in sharers)})" if sharers else ""))

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        nwc = tmp / "score.nwc"
        nwc.write_bytes(fetch(tune["nwc"]))
        dest = MIDI_DIR / f"{stem}.mid"
        worded = sets_words(nwc.read_bytes())
        if not worded and not args.score:
            # A tune-only score: the app's score stays, with the page's words set under it
            print("  score: the app's (the Cyber Hymnal's sets no words)")
            if args.dry_run:
                print("  (dry run: nothing written)")
                return
            if len(verses) != len(hymn["verses"]) or dest != old_path:
                again = tmp / "own.mid"
                if not replayed(old_path, len(hymn["verses"]), len(verses), again):
                    sys.exit("  MIDI: its verses couldn't be found to replay for the new number of verses")
                dest.write_bytes(again.read_bytes())
                print(f"  MIDI: the app's, replayed for {len(verses)} verses")
                if dest != old_path:
                    shutil.copyfile(ABC_DIR / f"{Path(old_file).stem}.abc", ABC_DIR / f"{stem}.abc")
        else:
            source = f"Cyber Hymnal {Path(tune['nwc']).name}" + (", with the words it sets" if worded else "")
            abc_out = tmp / "score.abc"
            midi = None  # (path, where it came from)
            tried = []
            # 1. The app's own MIDI, replayed for the new number of verses if need be
            if old_path.exists():
                own = old_path
                if len(verses) != len(hymn["verses"]):
                    own = tmp / "own.mid"
                    if not replayed(old_path, len(hymn["verses"]), len(verses), own):
                        own = None
                        tried.append("app's MIDI: its verses couldn't be found to replay")
                if own:
                    r = try_score(nwc, own, len(verses), abc_out, source)
                    if r["ok"]:
                        midi = (own, "the app's" + (" (replayed)" if own != old_path else ""))
                    else:
                        tried.append(f"app's MIDI: {r['error']}")
            # 2. The Cyber Hymnal's MIDI
            if not midi and tune["midi"] and not args.keep_midi:
                src = mido.MidiFile(file=io.BytesIO(fetch(tune["midi"])))
                parts = ch.four_parts(src)
                end = max(n[1] for p in parts for n in p)
                half = src.ticks_per_beat // 2
                theirs = tmp / "theirs.mid"
                ch.write_midi(theirs, src.ticks_per_beat, ch.meta_events(src), parts, 0, -(-end // half) * half, len(verses))
                r = try_score(nwc, theirs, len(verses), abc_out, source)
                if r["ok"]:
                    midi = (theirs, "the Cyber Hymnal's")
                else:
                    tried.append(f"Cyber Hymnal MIDI: {r['error']}")
            if not midi:
                sys.exit("  no score: " + " / ".join(tried))
            print(f"  score: {source}" + (f", moved {r['transpose']:+d}" if r["transpose"] else "")
                  + f"; sets {r['verses']} verse(s)" + (f"; words dropped: {r['lyricsDropped']}" if r["lyricsDropped"] else ""))
            print(f"  MIDI: {midi[1]}")
            if args.dry_run:
                print("  (dry run: nothing written)")
                return
            if midi[0] != dest:
                dest.write_bytes(midi[0].read_bytes())
            (ABC_DIR / f"{stem}.abc").write_text(abc_out.read_text(encoding="utf-8"), encoding="utf-8", newline="\n")

    fields = {"verses": verses}
    if stem != Path(old_file).stem:
        fields["midi_url"] = f"assets/midi/{stem}.mid"
    update_hymn(hymn["id"], **fields)

    if not ch.CMUDICT.exists():
        ch.CMUDICT.parent.mkdir(parents=True, exist_ok=True)
        ch.CMUDICT.write_bytes(ch.fetch(ch.CMUDICT_URL))
    ch.run([sys.executable, "Sheet Music/build_syllables.py", str(ch.CMUDICT)])
    if args.no_build:
        return
    unfit, left_out = ch.web_build(stem)
    if left_out:
        print("  words under the notes: score left out by the build")
    elif unfit:
        print(f"  words under the notes: verses {', '.join(map(str, unfit))} don't fit")
    else:
        print("  words under the notes: every verse")


if __name__ == "__main__":
    main()

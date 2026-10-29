#!/usr/bin/env python3
"""
psalm_from_svrbc.py

Sets a psalm the app already has to the svrbc psalter's words and one of its
tunes (gitlab.com/svrbc/psalter.svrbc.org, used with its developer's
permission): the 1650 Scottish Psalter as kept in its modernized/ folder, and a
four-part tune from its tunes/ library, which becomes both the sheet music and
the MIDI (played once per stanza), so the two agree by construction.

    python Psalms/psalm_from_svrbc.py <psalter checkout> <psalm> <tune file> [--second] [--dry-run]

    <psalter checkout>  a clone of gitlab.com/svrbc/psalter.svrbc.org
    <psalm>             1-150; the app's entry with that psalm_number changes
    <tune file>         a name in its tunes/ folder, e.g. evan (or evan.abc)
    --second            the psalter's second setting (psalm-NNNb.txt)

Writes midi/psalm_NNN_<tune>.mid
and "Sheet Music/abc/psalm_NNN_<tune>.abc", and updates the psalm's entry in
hymns_data.json (title from its first line, words, tune, meter,
credits), keeping its id. The old MIDI and score are deleted when no other hymn
plays them. Then run the web build (npm --prefix web run prepare-content) to see
whether every stanza's words fit under the notes. Nothing is committed.
"""

import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import mido

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "Missing Hymns"))
import add_from_cyber_hymnal as ch  # noqa: E402

MIDI_DIR, ABC_DIR = ch.MIDI_DIR, ch.ABC_DIR
SMALL = {"a", "an", "and", "as", "at", "but", "by", "for", "in", "nor", "of", "on", "or", "the", "to", "unto", "with"}
# abcjs writes the tune as MIDI: one track a voice, in score order (S, A, T, B)
TO_MIDI = """
const A = require(process.argv[1]), fs = require("fs");
const [tune] = A.parseOnly(fs.readFileSync(process.argv[2], "utf8"));
fs.writeFileSync(process.argv[3], Buffer.from(A.synth.getMidiFile(tune, { midiOutputType: "binary", chordsOff: true })));
"""


def read_psalm(path):
    """(header fields, stanzas as lists of lines) of a psalter file, {n} verse marks
    taken out. Its "furnish-ed" (the -ed sung as a syllable) is written as the
    app's hymns write it, "furnishèd", which underlay.mjs reads the same way."""
    text = path.read_text(encoding="utf-8")
    _, head, body = text.split("---", 2)
    fields = dict(l.split(":", 1) for l in head.strip().splitlines() if ":" in l)
    fields = {k.strip(): v.strip() for k, v in fields.items()}
    stanzas = []
    for block in re.split(r"\n\s*\n", body.strip()):
        lines = [re.sub(r"(?<=[a-z])-ed\b", "èd", re.sub(r"\{\d+\}\s*", "", l)).strip() for l in block.splitlines() if l.strip()]
        if lines:
            stanzas.append(lines)
    # A stanza the file breaks in two at a verse (Psalm 12's "God shall cut off
    # all flatt'ring lips") is sung as one: halves are joined up to the tune's lines
    per = len(fields.get("pattern", "").split(".")) or 4
    whole = []
    for lines in stanzas:
        if whole and len(whole[-1]) < per:
            whole[-1] = whole[-1] + lines
        else:
            whole.append(lines)
    return fields, whole


def title_of(line):
    """A first line as a title, up to a semicolon or colon: "Sing loud to God our
    strength; with joy" -> "Sing Loud to God Our Strength"."""
    words = re.sub(r"[,;:.]+$", "", re.split(r"[;:]", line)[0]).replace("'", "’").split()
    out = []
    for i, w in enumerate(words):
        bare = re.sub(r"\W", "", w).lower()
        out.append(w if i and bare in SMALL else w[:1].upper() + w[1:])
    return " ".join(out).replace("’", "'")


def tune_info(abc):
    field = lambda k: (re.search(rf"^{k}:(.*)$", abc, re.M) or [None, ""])[1].strip()
    return field("T"), field("C"), field("S"), (re.search(r"^%%psalter-meter (.*)$", abc, re.M) or [None, ""])[1].strip()


def write(path, hymns):
    path.write_text(json.dumps(hymns, indent=2, ensure_ascii=False), encoding="utf-8", newline="\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[1], formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("psalter", type=Path)
    ap.add_argument("psalm", type=int)
    ap.add_argument("tune")
    ap.add_argument("--second", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    text_file = args.psalter / "modernized" / f"psalm-{args.psalm:03d}{'b' if args.second else ''}.txt"
    tune_file = args.psalter / "tunes" / (args.tune if args.tune.endswith(".abc") else args.tune + ".abc")
    fields, stanzas = read_psalm(text_file)
    tune_abc = tune_file.read_text(encoding="utf-8")
    tune_name, composer, source, tune_meter = tune_info(tune_abc)
    if tune_meter != fields["meter"]:
        sys.exit(f"{tune_file.name} is {tune_meter}; psalm {args.psalm}{'b' if args.second else ''} is {fields['meter']}.")

    hymns = json.loads(ch.HYMNS_JSON.read_text(encoding="utf-8"))
    entry = [h for h in hymns if h.get("psalm_number") == args.psalm]
    if len(entry) != 1:
        sys.exit(f"{len(entry)} entries have psalm_number {args.psalm}; expected one.")
    entry = entry[0]
    stem = f"psalm_{args.psalm:03d}_{tune_file.stem.replace('-', '_')}"
    verses = [f"{i + 1} " + "\n".join(lines) for i, lines in enumerate(stanzas)]
    title = f"{title_of(stanzas[0][0])} (Psalm {args.psalm})"
    setting = " (second setting)" if args.second else ""
    changes = {
        "title": title,
        "tune": tune_name,
        "meter": fields["meter"],
        "text_source": f"The Scottish Psalter, 1650{setting}, as kept by the svrbc psalter",
        "verses": verses,
        "composer_arranger": composer,
        "midi_url": f"assets/midi/{stem}.mid",
        "mp3_url": "",
        "credits": f"Words: Psalm {args.psalm}, The Scottish Psalter, 1650{setting} (public domain), as kept by the "
                   f"svrbc psalter (psalter.svrbc.org). Tune: '{tune_name}' ({fields['meter']}), {composer}. "
                   f"Music and score from the svrbc psalter's tune library ({source}).",
    }
    print(f"Psalm {args.psalm}: {entry['title']} ({entry.get('tune')}) -> {title} ({tune_name}), {len(verses)} stanzas")
    if args.dry_run:
        print("  stanza 1:\n    " + verses[0].replace("\n", "\n    ") + "\n  (dry run: nothing written)")
        return

    # Score: the tune without its guitar chords
    score = re.sub(r'"[^"]*"', "", tune_abc)
    (ABC_DIR / f"{stem}.abc").write_text(f"% Source: svrbc psalter tunes/{tune_file.name}\n" + score, encoding="utf-8", newline="\n")

    # MIDI: the tune once per stanza
    with tempfile.TemporaryDirectory() as tmp:
        once = Path(tmp) / "once.mid"
        abcjs = ROOT / "web/node_modules/abcjs"
        subprocess.run(["node", "-e", TO_MIDI, str(abcjs), str(ABC_DIR / f"{stem}.abc"), str(once)], check=True)
        src = mido.MidiFile(once)
        voices = []
        for track in src.tracks:
            t, open_, notes = 0, {}, []
            for msg in track:
                t += msg.time
                if msg.type == "note_on" and msg.velocity:
                    open_[msg.note] = (t, msg.velocity)
                elif msg.type in ("note_on", "note_off") and msg.note in open_:
                    s, v = open_.pop(msg.note)
                    notes.append((s, t, msg.note, v))
            if notes:
                voices.append(sorted(notes))
        if len(voices) != 4:
            sys.exit(f"abcjs wrote {len(voices)} voices, not 4.")
        beat = src.ticks_per_beat
        length = -(-max(n[1] for v in voices for n in v) // beat) * beat
        seconds = ch.write_midi(MIDI_DIR / f"{stem}.mid", beat, ch.meta_events(src), voices, 0, length, len(verses))
    print(f"  MIDI: {stem}.mid ({seconds / 60:.1f} min); score: {stem}.abc")

    # The entry, moved to its place by the new title
    old_file = ch.midi_file(entry)
    for path in (ch.HYMNS_JSON,):
        hs = json.loads(path.read_text(encoding="utf-8"))
        h = next(x for x in hs if x["id"] == entry["id"])
        hs.remove(h)
        h.update(changes)
        at = next((i for i, x in enumerate(hs) if x["title"].lower() > h["title"].lower()), len(hs))
        hs.insert(at, h)
        write(path, hs)

    # The old MIDI and score, when nothing else plays them
    if old_file and not any(ch.midi_file(h) == old_file for h in hymns if h["id"] != entry["id"]):
        for old in (MIDI_DIR / old_file, ABC_DIR / (Path(old_file).stem + ".abc")):
            if old.exists() and old.stem != stem:
                old.unlink()
                print(f"  removed {old.relative_to(ROOT).as_posix()}")


if __name__ == "__main__":
    main()

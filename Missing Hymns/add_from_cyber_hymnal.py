#!/usr/bin/env python3
"""
add_from_cyber_hymnal.py

Adds a hymn from a Cyber Hymnal page (hymntime.com/tch/htm/...) to the app in
one go: its words, a four-part MIDI that plays every verse, and sheet music
with the words under the notes. Works for a new hymn and for another tune to a
hymn the app already has (an alternate tune).

    python "Missing Hymns/add_from_cyber_hymnal.py" <page url> [options]

    --tune NAME     use the page's alternate tune whose name contains NAME
                    (default: the page's main "Music:" tune)
    --verses 1-4,6  only these stanzas (default: all the page gives)
    --title TEXT    the title to list it under (default: the page's title)
    --dry-run       show what would be added, write nothing
    --page-text     print the page's words and tune lines as the page has
                    them (for checking what was added against), write nothing

What it does:
  1. Reads the page: title, words (a refrain is written out after every
     verse, as it is sung), author, and the tune's MIDI and NoteWorthy score.
  2. MIDI: if the app already has this tune, reuses that file: its intro and
     first verse, played once per verse of this hymn. Otherwise takes the
     Cyber Hymnal's MIDI, splits its two-part staves (Soprano+Alto,
     Tenor+Bass) into four parts, and plays it once per verse.
  3. Sheet music: reuses the tune's score, else converts the Cyber Hymnal's
     NoteWorthy score (Sheet Music/import_scores.mjs, kept only when every
     part matches the MIDI), else writes one out from the MIDI
     (Sheet Music/transcribe_midi.py).
  4. Adds the hymn to both hymns_data.json copies (root and Android assets),
     rebuilds Sheet Music/syllables.tsv, runs the web content build, and says
     whether every verse's words fit under the notes.

Nothing is committed. To undo a run: git checkout -- . and delete the new
files it lists.
"""

import argparse
import html
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
import urllib.request
from pathlib import Path
from urllib.parse import urljoin

import mido

ROOT = Path(__file__).resolve().parent.parent
HYMNS_JSON = ROOT / "hymns_data.json"
ANDROID_HYMNS_JSON = ROOT / "LetsSing_Android_Project/app/src/main/assets/hymns_data.json"
MIDI_DIR = ROOT / "LetsSing_Android_Project/app/src/main/assets/midi"
ABC_DIR = ROOT / "Sheet Music/abc"
CMUDICT = Path.home() / ".cache/lets-sing/cmudict.dict"
CMUDICT_URL = "https://raw.githubusercontent.com/cmusphinx/cmudict/master/cmudict.dict"

LEGATO = 1 / 8  # of a beat: how far a slurred note may run into the next


# --- Reading the page ---------------------------------------------------------

def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def text(fragment):
    """Plain text of an HTML fragment, line breaks kept, soft hyphens gone."""
    s = re.sub(r"(?i)<br\s*/?>\s*", "\n", fragment)
    s = html.unescape(re.sub(r"<[^>]+>", "", s)).replace("­", "")
    return "\n".join(re.sub(r"[ \t]+", " ", l).strip() for l in s.splitlines()).strip()


def tune_of(fragment, url):
    """A tune's name, composer and files from its "Music:" line or alternate-tune item."""
    links = {kind: urljoin(url, href) for href, kind in re.findall(r'href="([^"]+\.(mid|nwc))"', fragment)}
    name = re.search(r'<span class="music[^"]*">(.*?)</span>', fragment) or re.search(r"<li><span>(.*?)</span>", fragment)
    name = text(name.group(1)) if name else Path(links.get("mid", "tune")).stem.replace("_", " ").title()
    composer = re.search(r'<a href="[^"]*/bio/[^"]+">(.*?)</a>', fragment)
    year = re.search(r"\b(1[0-9]{3}|20[0-9]{2})\b", text(fragment))
    return {"name": name, "composer": text(composer.group(1)) if composer else "",
            "year": year.group(1) if year else "", "midi": links.get("mid"), "nwc": links.get("nwc")}


def read_page(url):
    page = fetch(url).decode("utf-8", errors="replace")
    title = text(re.search(r"<title>(.*?)</title>", page, re.S).group(1))
    words = re.search(r'<span class="lead">Words:</span>(.*?)</p>', page, re.S)
    author = re.search(r'<a href="[^"]*/bio/[^"]+">(.*?)</a>', words.group(1)) if words else None
    words_line = text(words.group(1)) if words else ""
    # Just the source, up to the sentence with its year: some pages run on into a story
    year = re.search(r"\b(1[0-9]{3}|20[0-9]{2})\b[^.]*", words_line)
    words_line = words_line[:year.end()] if year else words_line.split(". ")[0]
    music = re.search(r'<span class="lead">Music:</span>(.*?)</p>', page, re.S)
    tunes = [tune_of(music.group(1), url)] if music else []
    alt = re.search(r'<div class="alt-tune">(.*?)</div>', page, re.S)
    if alt:
        tunes += [tune_of(li, url) for li in re.findall(r"<li>(.*?)</li>", alt.group(1), re.S)]

    lyrics = re.search(r'<div class="lyrics-text[^"]*">(.*?)</div>', page, re.S)
    if not lyrics:
        sys.exit("No words found on the page (no lyrics-text section).")
    stanzas, refrain = [], None
    for cls, body in re.findall(r'<p(?: class="([^"]*)")?>(.*?)</p>', lyrics.group(1), re.S):
        if text(body).startswith("*"):
            continue  # a footnote
        lines = [l.replace("*", "").strip() for l in text(body).split("\n") if l.strip()]
        if not lines:
            continue
        if "chorus" in (cls or ""):
            if re.fullmatch(r"(Refrain|Chorus):?", lines[0]) and len(lines) == 1:
                if stanzas and refrain:
                    stanzas[-1] = stanzas[-1] + refrain
                continue
            refrain = lines
            if stanzas:
                stanzas[-1] = stanzas[-1] + refrain
            continue
        stanzas.append(lines)
    return {"title": title, "author": text(author.group(1)) if author else "", "words": words_line,
            "tunes": tunes, "stanzas": stanzas}


# --- MIDI ---------------------------------------------------------------------

def notes_by_channel(mid):
    """{channel: [(start, end, pitch, velocity)]} across all tracks, absolute ticks."""
    out = {}
    for track in mid.tracks:
        t, open_ = 0, {}
        for msg in track:
            t += msg.time
            if msg.type == "note_on" and msg.velocity:
                open_.setdefault((msg.channel, msg.note), []).append((t, msg.velocity))
            elif msg.type in ("note_off", "note_on"):
                stack = open_.get((msg.channel, msg.note))
                if stack:
                    s, v = stack.pop(0)
                    out.setdefault(msg.channel, []).append((s, t, msg.note, v))
    return {ch: sorted(ns, key=lambda n: (n[0], -n[2])) for ch, ns in out.items() if ch != 9}


def meta_events(mid):
    """Tempo, key and time signature events from every track, absolute ticks."""
    events = []
    for track in mid.tracks:
        t = 0
        for msg in track:
            t += msg.time
            if msg.type in ("set_tempo", "key_signature", "time_signature", "track_name", "copyright", "text") \
                    and (msg.type != "text" or track is mid.tracks[0]):
                events.append((t, msg))
    return events


def split_voices(notes, legato):
    """One staff's notes split into its upper and lower voice, following each
    voice: notes struck together go top to the upper voice, bottom to the
    lower; a note struck alone goes to the voice that is free, or to both when
    both are (a unison). A unison written twice gives one copy to each voice,
    the shorter to the one that moves on first; a unison written twice while
    one voice still holds that note is sung by the other only."""
    onsets = {}
    for n in notes:
        onsets.setdefault(n[0], []).append(n)
    upper, lower = [], []
    busy = lambda v, t: v and v[-1][1] > t + legato
    times = sorted(onsets)
    for k, t in enumerate(times):
        struck = sorted(onsets[t], key=lambda n: n[2])
        if len(struck) == 2 and struck[0][2] == struck[1][2]:
            if busy(upper, t) or busy(lower, t):
                (lower if busy(upper, t) else upper).append(struck[0])
                continue
            if struck[0][1] != struck[1][1]:
                short, long_ = sorted(struck, key=lambda n: n[1])
                after = [n for t2 in times[k + 1:] for n in onsets[t2] if t2 >= short[1]][:1]
                up = not after or after[0][2] >= short[2]
                upper.append(short if up else long_)
                lower.append(long_ if up else short)
                continue
        if len(struck) >= 2:
            upper.append(struck[-1])
            lower.append(struck[0])
        elif busy(upper, t) and not busy(lower, t):
            lower.append(struck[0])
        elif busy(lower, t) and not busy(upper, t):
            upper.append(struck[0])
        else:
            upper.append(struck[0])
            lower.append(struck[0])
    return upper, lower


def four_parts(mid):
    """Soprano, alto, tenor and bass notes of a Cyber Hymnal MIDI."""
    chans = notes_by_channel(mid)
    seen, parts = set(), []
    for ch in sorted(chans):
        key = tuple((s, p) for s, e, p, v in chans[ch])
        if key and key not in seen:  # a channel copying another is dropped
            seen.add(key)
            parts.append(chans[ch])
    parts.sort(key=lambda ns: -sum(n[2] for n in ns) / len(ns))
    legato = mid.ticks_per_beat * LEGATO
    if len(parts) == 4:
        return parts
    if len(parts) == 2:
        return [*split_voices(parts[0], legato), *split_voices(parts[1], legato)]
    raise SystemExit(f"The Cyber Hymnal MIDI has {len(parts)} parts; this script handles 2 (S+A, T+B) or 4.")


def find_verse(parts, verse_counts):
    """(intro end, verse length) of a MIDI that plays its tune several times:
    the first point after which the next stretch repeats, note for note in
    every part, as many times as one of `verse_counts`."""
    pattern = lambda a, b: sorted((s - a, p, i) for i, ns in enumerate(parts) for s, e, p, v in ns if a <= s < b)
    sop = parts[0]
    for count in sorted(set(verse_counts), reverse=True):
        if count == 1:
            continue
        for s, _, pitch, _ in sop[:60]:
            for o, _, p2, _ in sop:
                if o <= s or p2 != pitch or (o - s) * (count - 1) > sop[-1][0] - s + 1:
                    continue
                length = o - s
                first = pattern(s, s + length)
                if first and all(pattern(s + k * length, s + (k + 1) * length) == first for k in range(1, count)):
                    return s, length
    return None


def write_midi(path, tpb, metas, parts, start, length, verses):
    """Intro and first verse of `parts`, the verse played `verses` times."""
    track0, events = mido.MidiTrack(), []
    for t, m in metas:
        if t < start + length:
            events.append((t, m))
            if t >= start and m.type == "set_tempo":
                events += [(t + k * length, m) for k in range(1, verses)]
    last = 0
    for t, m in sorted(events, key=lambda e: e[0]):
        track0.append(m.copy(time=t - last))
        last = t
    track0.append(mido.MetaMessage("end_of_track", time=0))
    out = mido.MidiFile(type=1, ticks_per_beat=tpb)
    out.tracks.append(track0)
    for ch, notes in enumerate(parts):
        verse = [n for n in notes if start <= n[0] < start + length]
        played = [n for n in notes if n[0] < start] + verse
        for k in range(1, verses):
            played += [(s + k * length, e + k * length, p, v) for s, e, p, v in verse]
        timed = [(0, 0, mido.Message("program_change", channel=ch, program=0))]
        for s, e, p, v in played:
            timed += [(s, 2, mido.Message("note_on", channel=ch, note=p, velocity=v)),
                      (e, 1, mido.Message("note_off", channel=ch, note=p, velocity=0))]
        track, last = mido.MidiTrack(), 0
        for t, _, m in sorted(timed, key=lambda e: (e[0], e[1])):
            track.append(m.copy(time=t - last))
            last = t
        track.append(mido.MetaMessage("end_of_track", time=0))
        out.tracks.append(track)
    out.save(path)
    return out.length


# --- Helpers ------------------------------------------------------------------

norm = lambda s: re.sub(r"[^a-z0-9]", "", unicodedata.normalize("NFD", s.lower()))


def slug(s):
    s = unicodedata.normalize("NFD", re.sub(r"\(.*?\)", "", s)).encode("ascii", "ignore").decode()
    return "_".join(re.sub(r"[^A-Za-z0-9 ]", "", s.replace("-", " ")).split())


def midi_file(h):
    return (h.get("midi_url") or "").split("/")[-1]


def pick_verses(spec, n):
    if not spec:
        return list(range(n))
    out = []
    for part in spec.split(","):
        a, _, b = part.partition("-")
        out += range(int(a) - 1, int(b or a))
    if not out or max(out) >= n or min(out) < 0:
        sys.exit(f"--verses {spec}: the page has {n} stanzas.")
    return out


def run(cmd, cwd=ROOT):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.returncode, r.stdout + r.stderr


def set_meter(hymn_id, verses):
    """Records the hymn's meter (syllables in each line, as most verses have
    them: "8.8.8.8.8.8.8.8"), which transcribe_midi.py slurs the melody to.
    Syllables are counted as Sheet Music/syllables.tsv first splits each word."""
    table = {}
    for line in (ROOT / "Sheet Music/syllables.tsv").read_text(encoding="utf-8").splitlines():
        word, *splits = line.split("\t")
        if splits:
            table[word] = splits[0].count("-") + 1
    count = lambda w: table.get(w) or max(1, len(re.findall(r"[aeiouy]+", re.sub(r"e$", "", w))))
    per_verse = []
    for verse in verses:
        lines = re.sub(r"^\s*\d+\.\s*", "", verse).split("\n")
        per_verse.append([sum(count(k) for w in re.split(r"\s+|(?<=[a-zA-Z][—–])(?=[a-zA-Z])", l)
                              if (k := re.sub(r"[^a-z]", "", unicodedata.normalize("NFD", w.lower()))))
                          for l in lines])
    n = max(set(map(len, per_verse)), key=lambda k: sum(len(c) == k for c in per_verse))
    rows = [c for c in per_verse if len(c) == n]
    meter = ".".join(str(max(set(col), key=col.count)) for col in zip(*rows))
    for path in (HYMNS_JSON, ANDROID_HYMNS_JSON):
        hymns = json.loads(path.read_text(encoding="utf-8"))
        for h in hymns:
            if h["id"] == hymn_id:
                h["meter"] = meter
        path.write_text(json.dumps(hymns, indent=2, ensure_ascii=False), encoding="utf-8", newline="\n")


def insert_hymn(hymn):
    for path in (HYMNS_JSON, ANDROID_HYMNS_JSON):
        hymns = json.loads(path.read_text(encoding="utf-8"))
        at = next((i for i, h in enumerate(hymns) if h["title"].lower() > hymn["title"].lower()), len(hymns))
        hymns.insert(at, hymn)
        path.write_text(json.dumps(hymns, indent=2, ensure_ascii=False), encoding="utf-8", newline="\n")


# --- Main ---------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[1], formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("url")
    ap.add_argument("--tune")
    ap.add_argument("--verses")
    ap.add_argument("--title")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--page-text", action="store_true")
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    if args.page_text:
        page = fetch(args.url).decode("utf-8", errors="replace")
        for lead in ("Words", "Music"):
            m = re.search(rf'<span class="lead">{lead}:</span>(.*?)</p>', page, re.S)
            print(f"{lead}: {text(m.group(1)) if m else '-'}")
        alt = re.search(r'<div class="alt-tune">(.*?)</div>', page, re.S)
        if alt:
            print("Alternate tunes: " + "; ".join(text(li) for li in re.findall(r"<li>(.*?)</li>", alt.group(1), re.S)))
        lyrics = re.search(r'<div class="lyrics-text[^"]*">(.*?)</div>', page, re.S)
        for cls, body in re.findall(r'<p(?: class="([^"]*)")?>(.*?)</p>', lyrics.group(1) if lyrics else "", re.S):
            print(("[" + cls + "] " if cls else "") + text(body) + "\n")
        return

    page = read_page(args.url)
    if not page["tunes"]:
        sys.exit("No tune found on the page.")
    tune = page["tunes"][0]
    if args.tune:
        found = [t for t in page["tunes"] if norm(args.tune) in norm(t["name"])]
        if not found:
            sys.exit(f"No tune matching {args.tune!r}; the page has: " + ", ".join(t["name"] for t in page["tunes"]))
        tune = found[0]
    if not tune["midi"]:
        sys.exit(f"The Cyber Hymnal has no MIDI for {tune['name']}.")
    stanzas = [page["stanzas"][i] for i in pick_verses(args.verses, len(page["stanzas"]))]
    verses = [f"{i + 1}. " + "\n".join(lines) for i, lines in enumerate(stanzas)]
    title = args.title or page["title"]

    hymns = json.loads(HYMNS_JSON.read_text(encoding="utf-8"))
    tune_names = lambda h: {norm(t) for t in re.split(r"\s+or\s+|/", h.get("tune") or "")} | {norm(Path(midi_file(h)).stem)}
    wanted = {norm(tune["name"]), norm(Path(tune["midi"]).stem)}
    first_line = lambda vs: norm(re.sub(r"^\s*\d+\.\s*", "", (vs or [""])[0]).split("\n")[0])
    for h in hymns:
        same_hymn = norm(h["title"]) == norm(title) or first_line(h.get("verses")) == first_line(verses)
        if same_hymn and tune_names(h) & wanted:
            sys.exit(f"Already in the app: {h['id']} {h['title']} ({h.get('tune')}).")
    # The app's own copy of this tune: a hymn set to it whose MIDI and score are here
    reuse = [h for h in hymns if tune_names(h) & wanted and (MIDI_DIR / midi_file(h)).exists()]
    reuse.sort(key=lambda h: not (ABC_DIR / (Path(midi_file(h)).stem + ".abc")).exists())

    same_title = [h for h in hymns if norm(h["title"]) == norm(title)]
    stem = f"{slug(title)}-{slug(tune['name'])}"
    while (MIDI_DIR / f"{stem}.mid").exists():
        stem += "_2"
    new_id = max(h["id"] for h in hymns) + 1
    hymn = {
        "id": new_id, "title": title, "tune": tune["name"],
        "Author": page["author"], "Composer": tune["composer"],
        "midi_url": f"assets/midi/{stem}.mid", "mp3_url": "", "verses": verses,
        "credits": f"Words: {page['words'].rstrip('.')}. Music: '{tune['name'].upper()}' {tune['composer']}"
                   + (f", {tune['year']}" if tune["year"] and tune["year"] not in tune["composer"] else "")
                   + f". Text and tune as given in the Cyber Hymnal ({args.url.split('://')[-1]}). copyright: public domain.",
    }

    print(f"{title}  |  tune {tune['name']}  |  {len(verses)} verses  |  id {new_id}")
    if same_title:
        print("  already in the app with another tune: " + ", ".join(f"{h['id']} ({h.get('tune')})" for h in same_title))
    print("  MIDI: " + (f"reuse {midi_file(reuse[0])}" if reuse else f"Cyber Hymnal {Path(tune['midi']).name}"))
    if args.dry_run:
        print("  tunes on the page: " + ", ".join(t["name"] for t in page["tunes"]))
        print("  verse 1:\n    " + verses[0].replace("\n", "\n    "))
        print("  (dry run: nothing written)")
        return

    # MIDI
    dest = MIDI_DIR / f"{stem}.mid"
    score_from = None
    shared = None
    if reuse:
        src_file = midi_file(reuse[0])
        src = mido.MidiFile(MIDI_DIR / src_file)
        chans = notes_by_channel(src)
        parts = [chans.get(ch, []) for ch in range(4)]
        users = [len(h["verses"]) for h in hymns if midi_file(h) == src_file]
        found = find_verse(parts, users)
        if found:
            seconds = write_midi(dest, src.ticks_per_beat, meta_events(src), parts, *found, len(verses))
            print(f"  MIDI: {dest.name} from {src_file} ({seconds / 60:.1f} min)")
            score_from = ABC_DIR / (Path(src_file).stem + ".abc")
        else:
            # Its verses can't be told apart: share the file (the score then shows notes only)
            shared = src_file
            hymn["midi_url"] = f"assets/midi/{src_file}"
            print(f"  MIDI: shares {src_file} (its verses couldn't be found to replay); words show as text only")
    else:
        src = mido.MidiFile(file=__import__("io").BytesIO(fetch(tune["midi"])))
        parts = four_parts(src)
        end = max(n[1] for p in parts for n in p)
        half = src.ticks_per_beat // 2  # notes are cut short a little: round the verse up to a half beat
        length = -(-end // half) * half
        seconds = write_midi(dest, src.ticks_per_beat, meta_events(src), parts, 0, length, len(verses))
        print(f"  MIDI: {dest.name} from the Cyber Hymnal ({seconds / 60:.1f} min)")

    insert_hymn(hymn)

    # Sheet music
    if shared:
        pass
    elif score_from and score_from.exists():
        shutil.copyfile(score_from, ABC_DIR / f"{stem}.abc")
        print(f"  score: reused {score_from.name}")
    else:
        got = False
        if tune["nwc"]:
            with tempfile.TemporaryDirectory() as tmp:
                (Path(tmp) / f"{stem}.nwc").write_bytes(fetch(tune["nwc"]))
                code, out = run(["node", "Sheet Music/import_scores.mjs", "--nwc", tmp])
            got = (ABC_DIR / f"{stem}.abc").exists()
            if not got:
                why = [l.strip() for l in out.splitlines() if stem in l]
                print("  score: the Cyber Hymnal's didn't match the MIDI" + (f" ({why[0].split(': ', 1)[-1]})" if why else ""))
        if got:
            abc = ABC_DIR / f"{stem}.abc"
            abc.write_text(re.sub(r"^% Source: .*", f"% Source: Cyber Hymnal {Path(tune['nwc']).name}",
                                  abc.read_text(encoding="utf-8"), count=1), encoding="utf-8")
            print("  score: the Cyber Hymnal's, converted")
        else:
            code, out = run([sys.executable, "Sheet Music/transcribe_midi.py", str(new_id)])
            print("  score: written out from the MIDI" if (ABC_DIR / f"{stem}.abc").exists() else "  score: none\n" + out[-800:])

    # Syllables for any new words, then the web build
    if not CMUDICT.exists():
        CMUDICT.parent.mkdir(parents=True, exist_ok=True)
        CMUDICT.write_bytes(fetch(CMUDICT_URL))
    run([sys.executable, "Sheet Music/build_syllables.py", str(CMUDICT)])
    built = Path(midi_file(hymn)).stem
    abc = ABC_DIR / f"{built}.abc"
    unfit, left_out = web_build(built)
    if not shared and abc.exists() and (unfit or left_out):
        # Try a score written out from the MIDI, which slurs the melody to the
        # verses' syllables, and keep whichever sets more verses
        kept = abc.read_text(encoding="utf-8")
        set_meter(new_id, verses)
        run([sys.executable, "Sheet Music/transcribe_midi.py", str(new_id), "--force"])
        unfit2, left_out2 = web_build(built)
        if not left_out2 and (left_out or len(unfit2) < len(unfit)):
            print("  score: written out from the MIDI instead, so more verses' words fit")
            unfit, left_out = unfit2, left_out2
        else:
            abc.write_text(kept, encoding="utf-8")
            web_build(built)
    if shared:
        print("  words under the notes: no (shared MIDI)")
    elif left_out or not abc.exists():
        print("  words under the notes: no score")
    elif unfit:
        rest = len(verses) - len(unfit)
        print(f"  words under the notes: verses {', '.join(map(str, unfit))} don't fit"
              + (f" ({rest} others do)" if rest else " (none do)") + "; their words still show as text")
    else:
        print("  words under the notes: every verse")
    new = [f.relative_to(ROOT).as_posix() for f in (dest, ABC_DIR / f"{stem}.abc") if f.exists()]
    if new:
        print("  new files: " + ", ".join(new))
    print("Done. Check it with: npm --prefix web run dev   (nothing committed)")


def web_build(stem):
    """Runs the web content build; returns (verse numbers whose words don't fit
    under the notes, whether the score was left out) for this MIDI's score."""
    code, out = run(["node", "scripts/prepare-content.mjs"], cwd=ROOT / "web")
    if code:
        sys.exit("  web build failed:\n" + out[-1500:])
    # The build lists, under a heading each, scores with verses that don't fit and scores left out
    report, section = {}, None
    for line in out.splitlines():
        if "wouldn't fit" in line or "left out" in line:
            section = "unfit" if "wouldn't fit" in line else "left_out"
        elif section and line.startswith("  ") and line.strip().startswith(stem + ":"):
            report[section] = line.split(":", 1)[1].strip()
    unfit = [int(v) for v in re.findall(r"\d+", report.get("unfit", ""))]
    return unfit, "left_out" in report


if __name__ == "__main__":
    main()

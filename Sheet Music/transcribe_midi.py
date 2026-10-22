"""Sheet music for hymns no score source covers: transcribe the app's own MIDI.

Writes "Sheet Music/abc/<midi stem>.abc" for each hymn id given, from the first
verse of its bundled MIDI file (channels 0-3 = S/A/T/B). Because the score is
read off the very file the app plays, build-scores.mjs always finds them in step.

The method follows the svrbc psalter's tools/midi_to_abc.py
(gitlab.com/svrbc/psalter.svrbc.org), used with its developer's permission:
quantize each voice, spell pitches in the key, and slur the melody's extra
notes into melismas until there is one note per syllable of the hymn's meter
(underlay.mjs then puts every verse's words under the notes). Unlike svrbc's
MIDI, ours are already one voice per channel, and they carry a time signature,
so the score keeps real bars.

    python "Sheet Music/transcribe_midi.py" 352 356 ...   [--force]

Leaves an existing .abc alone unless --force.
"""

from __future__ import annotations

import json
import re
import sys
from fractions import Fraction
from pathlib import Path

import mido

ROOT = Path(__file__).resolve().parent.parent
MIDI_DIR = ROOT / "LetsSing_Android_Project/app/src/main/assets/midi"
ABC_DIR = ROOT / "Sheet Music/abc"
GRID = 4  # quantize to a sixteenth (quarter-note beats)

SHARPS = "FCGDAEB"
FLATS = "BEADGCF"
# mido key name -> sharps (+) / flats (-)
KEY_COUNT = {"C": 0, "G": 1, "D": 2, "A": 3, "E": 4, "B": 5, "F#": 6,
             "F": -1, "Bb": -2, "Eb": -3, "Ab": -4, "Db": -5, "Gb": -6}
MINOR_OF = {"Am": "C", "Em": "G", "Bm": "D", "F#m": "A", "C#m": "E", "Dm": "F",
            "Gm": "Bb", "Cm": "Eb", "Fm": "Ab", "Bbm": "Db"}
LETTERS_SHARP = ["C", "C", "D", "D", "E", "F", "F", "G", "G", "A", "A", "B"]
LETTERS_FLAT = ["C", "D", "D", "E", "E", "F", "G", "G", "A", "A", "B", "B"]
NATURAL = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
# note lengths a single ABC note can show, in quarter notes, longest first
SHOWABLE = [Fraction(x) for x in ("4", "3", "2", "3/2", "1", "3/4", "1/2", "3/8", "1/4")]


def read_voices(path: Path):
    """Notes per channel 0-3 as (start, end, pitch) ticks, plus meta events."""
    mid = mido.MidiFile(path)
    voices = {c: [] for c in range(4)}
    keys, times = [], []
    for track in mid.tracks:
        t, held = 0, {}  # (channel, pitch) -> [start, how many note-ons]
        for msg in track:
            t += msg.time
            if msg.type == "key_signature":
                keys.append((t, msg.key))
            elif msg.type == "time_signature":
                times.append((t, msg.numerator, msg.denominator))
            elif getattr(msg, "channel", 9) >= 4 or msg.type not in ("note_on", "note_off"):
                continue
            elif msg.type == "note_on" and msg.velocity:
                key = (msg.channel, msg.note)
                if key in held and held[key][0] == t:  # doubled: ends at its last note-off
                    held[key][1] += 1
                    continue
                if key in held and t > held[key][0]:  # struck again while still held
                    voices[msg.channel].append((held[key][0], t, msg.note))
                held[key] = [t, 1]
            else:
                key = (msg.channel, msg.note)
                if key in held:
                    held[key][1] -= 1
                    if held[key][1] == 0:
                        start = held.pop(key)[0]
                        if t > start:
                            voices[msg.channel].append((start, t, msg.note))
    for v in voices.values():
        v.sort()
    return mid.ticks_per_beat, voices, sorted(keys), sorted(times)


def beat_map(voices, tpb, origin):
    """Ticks -> quarter notes from origin. Some files (piano reductions played
    in) take a little breath at the end of each line, which would put every
    later note off the beat; so each step from one chord to the next is
    rounded on its own, to the nearest eighth unless it's plainly a sixteenth
    off one, and times in between are spaced proportionally."""
    onsets = sorted({s for v in voices.values() for s, _, _ in v if s >= origin} | {origin})
    anchors = [(origin, Fraction(0))]
    for t in onsets[1:]:
        if t - anchors[-1][0] < tpb / 8:  # the same chord, a little ragged
            continue
        step = Fraction(t - anchors[-1][0], tpb)
        best = min((Fraction(k, GRID) for k in range(1, int(step * GRID) + 2)),
                   key=lambda c: abs(step - c) + (Fraction(1, 12) if c * 2 % 1 else 0))
        anchors.append((t, anchors[-1][1] + best))

    def at(ticks):
        i = max(0, next((j for j, (t, _) in enumerate(anchors) if t > ticks), len(anchors)) - 1)
        t0, b0 = anchors[i]
        if i + 1 < len(anchors):
            t1, b1 = anchors[i + 1]
            beats = b0 + (b1 - b0) * Fraction(ticks - t0, t1 - t0)
        else:
            beats = b0 + Fraction(ticks - t0, tpb)
        return Fraction(round(beats * GRID), GRID)
    return at


def quantize(notes, q):
    """(start, length, [pitches]) in quarter notes (`q`: ticks -> beats);
    chords merged, small gaps (early note-offs) closed, overlaps cut."""
    out = []
    for s, e, p in notes:
        s, e = q(s), q(e)
        if out and out[-1][0] == s:
            out[-1] = (s, max(out[-1][1], e - s), out[-1][2] + [p])
            continue
        out.append((s, max(e - s, Fraction(1, GRID)), [p]))
    fixed = []
    for i, (s, d, ps) in enumerate(out):
        if i + 1 < len(out):
            nxt = out[i + 1][0]
            if s + d > nxt or nxt - (s + d) <= Fraction(1, 4):
                d = nxt - s
            else:  # a real rest follows: let go on the half beat, not just before it
                held = -(-(s + d) * 2 // 1) / 2
                if held - (s + d) <= Fraction(1, 4):
                    d = Fraction(held) - s
        fixed.append((s, d, sorted(set(ps), reverse=True)))
    return fixed


def key_name(k: str) -> str:
    return MINOR_OF.get(k, k)


class Speller:
    """Pitch -> ABC in a key, with accidentals carried to the end of the bar."""

    def __init__(self, key: str, minor=False):
        n = KEY_COUNT[key]
        self.flat = n < 0 and not minor  # minor keys raise their 6th and 7th with sharps
        self.sig = {l: (1 if n > 0 else -1) for l in (SHARPS[:n] if n > 0 else FLATS[:-n])}
        self.bar = {}

    def new_bar(self):
        self.bar = {}

    def __call__(self, pitch: int) -> str:
        pc = pitch % 12
        letter = (LETTERS_FLAT if self.flat else LETTERS_SHARP)[pc]
        # a pitch the key spells with its own accidental takes that spelling
        for l, acc in self.sig.items():
            if (NATURAL[l] + acc) % 12 == pc:
                letter = l
        off = (pc - NATURAL[letter] + 6) % 12 - 6
        octave = (pitch - off) // 12 - 1
        slot = f"{letter}{octave}"
        mark = ""
        if self.bar.get(slot, self.sig.get(letter, 0)) != off:
            mark = {1: "^", -1: "_", 0: "="}[off]
            self.bar[slot] = off
        base = letter.lower() + "'" * (octave - 5) if octave >= 5 else letter + "," * (4 - octave)
        return mark + base


def pieces(length: Fraction):
    """A length as tied note values a single ABC note can show."""
    out = []
    while length > 0:
        part = next((v for v in SHOWABLE if v <= length), Fraction(1, GRID))
        out.append(part)
        length -= part
    return out


def dur(d: Fraction) -> str:
    if d == 1:
        return ""
    if d.denominator == 1:
        return str(d.numerator)
    return "/" if d == Fraction(1, 2) else f"{d.numerator}/{d.denominator}"


def melismas(melody, counts, others: set):
    """Indices i where melody note i is slurred to note i+1, so each line of
    the tune has one note per syllable of that line (`counts`). As svrbc's
    phrase_positions: lines end on the tune's long notes, and within a line
    with notes to spare, neighbouring notes are merged, never a repeated pitch
    (that's two syllables). A note none of the other voices moves with
    (`others`: their onsets) is almost always one more note on the same
    syllable, so those go first, then the shortest pairs.
    Returns (slurs, notes left to take a syllable)."""
    n = len(melody)

    def merge(lo, hi, want):
        groups = [[i] for i in range(lo, hi)]
        while len(groups) > want:
            best = None
            for g in range(len(groups) - 1):
                a, b = groups[g], groups[g + 1]
                last, first = melody[a[-1]], melody[b[0]]
                if last[2] == first[2] or last[0] + last[1] < first[0]:
                    continue  # a repeated pitch, or a rest between
                total = sum(melody[i][1] for i in a + b)
                alone = melody[b[0]][0] not in others
                if not alone and not (total <= 1 and len(a + b) == 2):
                    continue  # not plainly one syllable: better no words than wrong ones
                cand = (not alone, total, g)
                if best is None or cand < best:
                    best = cand
            if best is None:
                return None
            g = best[-1]
            groups[g:g + 2] = [groups[g] + groups[g + 1]]
        return groups

    # line ends: the split that puts the longest notes last in each line
    best = {(0, 0): (0, [])}
    for line, c in enumerate(counts):
        nxt = {}
        for (ln, start), (score, cuts) in best.items():
            for size in range(c, c + 4):
                end = start + size
                if end > n or (line == len(counts) - 1 and end != n):
                    continue
                cand = (score + melody[end - 1][1], cuts + [end])
                if (line + 1, end) not in nxt or cand[0] > nxt[(line + 1, end)][0]:
                    nxt[(line + 1, end)] = cand
        best = nxt
    slurs, start = set(), 0
    for c, end in zip(counts, best.get((len(counts), n), (0, []))[1] or [None]):
        groups = end and merge(start, end, c)
        if not groups:
            break
        slurs |= {i for grp in groups for i in grp[:-1]}
        start = end
    else:
        return slurs, sum(counts)
    # no line split works: the same rule over the whole tune at once
    groups = merge(0, n, sum(counts))
    if groups:
        return {i for grp in groups for i in grp[:-1]}, sum(counts)
    return set(), n


def syllables_per_line(hymn) -> list:
    """The meter's pattern, cycled over however many lines verse 1 has (a
    doubled tune, a repeated last line)."""
    m = (hymn.get("meter") or "").strip()
    named = {"CM": [8, 6, 8, 6], "LM": [8, 8, 8, 8], "SM": [6, 6, 8, 6]}
    nums = next((pat for name, pat in named.items() if m.startswith(name)), None)
    nums = nums or [int(x) for x in re.findall(r"\d+", m)]
    lines = len(hymn["verses"][0].strip().split("\n"))
    return [nums[i % len(nums)] for i in range(lines)] if nums else []


def render(notes, speller, bar_len, pickup, slurs=frozenset(), key_changes=(), clef="treble"):
    """One voice as ABC with bars every bar_len, starting `pickup` before bar 1."""
    out, barpos = [], (bar_len - pickup) % bar_len
    kc = list(key_changes)
    open_slur = False
    t_at = Fraction(0)
    for i, (s, d, ps) in enumerate(notes):
        if s > t_at:  # a rest
            for r in split_by_bar(s - t_at, barpos, bar_len):
                out.append(("z" + dur(r[0])))
                barpos = advance(out, barpos, r[0], bar_len, speller)
        while kc and kc[0][0] <= s:
            speller.__init__(kc.pop(0)[1])
            out.append(f"[K:{speller_key(speller)} clef={clef}]")  # a bare K: resets the clef
        parts = split_by_bar(d, barpos, bar_len)
        for j, (length, _) in enumerate(parts):
            ln = pieces(length)
            for k, piece in enumerate(ln):
                txt = "".join(speller(p) for p in ps)
                txt = (f"[{txt}]" if len(ps) > 1 else txt) + dur(piece)
                if j == 0 and k == 0 and i in slurs and not open_slur:
                    txt = "(" + txt
                    open_slur = True
                last_piece = j == len(parts) - 1 and k == len(ln) - 1
                if not last_piece:
                    txt += "-"
                elif open_slur and i not in slurs:
                    txt += ")"
                    open_slur = False
                out.append(txt)
                barpos = advance(out, barpos, piece, bar_len, speller)
        t_at = s + d
    if out and out[-1] == "|":
        out[-1] = "|]"
    else:
        out.append("|]")
    return " ".join(out)


def speller_key(sp: Speller) -> str:
    n = sum(sp.sig.values())
    return next(k for k, v in KEY_COUNT.items() if v == n)


def split_by_bar(length, barpos, bar_len):
    out = []
    while length > 0:
        room = bar_len - barpos
        part = min(room, length)
        out.append((part, None))
        length -= part
        barpos = (barpos + part) % bar_len
    return out


def advance(out, barpos, length, bar_len, speller):
    barpos += length
    if barpos >= bar_len:
        barpos -= bar_len
        out.append("|")
        speller.new_bar()
    return barpos


def drop_holds(q, num, bar_len):
    """Pickup, and the pauses taken out. The MIDI holds the end of a line past
    its written length (a fermata), which would push every later barline off
    the beat. After each melody note of a bar or longer, the next phrase is
    re-fitted to the bar, and the beats it was pushed by come off the held
    notes."""
    holds = [s + d for s, d, _ in q[0][:-1] if d >= bar_len]
    def shift(q, at, by):
        out = {}
        for c, v in q.items():
            out[c] = [(s - by if s >= at else s, d - by if s < at < s + d + Fraction(1, GRID) else d, ps)
                      for s, d, ps in v]
        return out
    def weight(q, p, lo, hi):
        w = 0
        for v in q.values():
            for s, d, _ in v:
                if lo <= s < hi:
                    pos = (s - p) % bar_len
                    w += 2 * d if pos == 0 else d if num in (2, 4, 6) and pos == bar_len / 2 else 0
        return w
    first = holds[0] if holds else bar_len * 1000
    pickup = max(range(int(bar_len)), key=lambda p: (weight(q, p, 0, first), -p))
    for i in range(len(holds)):
        at = holds[i]
        nxt = holds[i + 1] if i + 1 < len(holds) else bar_len * 1000
        held = next(d for s, d, _ in q[0] if s + d == at)
        best = max((Fraction(k) for k in range(int(min(bar_len, held)))),
                   key=lambda by: (weight(shift(q, at, by), pickup, at - by, nxt - by), -by))
        if best:
            q = shift(q, at, best)
            holds = [h - best if j > i else h for j, h in enumerate(holds)]
    return q, pickup


def best_pickup(q, num, bar_len):
    """The pickup (whole beats before bar 1) that puts the most sound on the
    downbeats (and, in 2, 4 and 6 time, the half bar)."""
    def weight(p):
        w = 0
        for v in q.values():
            for s, d, _ in v:
                pos = (s - p) % bar_len
                w += 2 * d if pos == 0 else d if num in (2, 4, 6) and pos == bar_len / 2 else 0
        return w
    return max(range(int(bar_len)), key=lambda p: (weight(p), -p))


def fit_key(q, given=None):
    """The signature that leaves the fewest note-lengths needing an
    accidental; or the file's own (`given`) unless that leaves far more (a
    few are wrong; a tune that wanders out of its key is not)."""
    used = {}
    for v in q.values():
        for _, d, ps in v:
            for p in ps:
                used[p % 12] = used.get(p % 12, 0) + d
    def outside(name):
        n = KEY_COUNT[name]
        tonic = (7 * n) % 12
        scale = {(tonic + i) % 12 for i in (0, 2, 4, 5, 7, 9, 11)}
        return sum(d for pc, d in used.items() if pc not in scale), abs(n)
    best = min(KEY_COUNT, key=outside)
    if given and outside(given)[0] <= outside(best)[0] * 2 + sum(used.values()) / 40:
        return given
    return best


def key_label(key, final_bass_pc):
    """K: field: the minor name when the tune ends on the relative minor."""
    tonic = (7 * KEY_COUNT[key]) % 12
    if final_bass_pc == (tonic + 9) % 12:
        return next((m for m, maj in MINOR_OF.items() if maj == key), key)
    return key


def plays(sop):
    """(start, end) ticks of each play of the tune. Where the melody repeats
    (each verse, or each play of a file that plays fewer times than there are
    verses), that's its shortest period that holds across the whole file,
    starting where it first repeats (after any intro). Otherwise the file
    plays the tune once."""
    # failing that, with notes repeated on the same pitch left out: some
    # verses split a note in two for an extra syllable
    for at in (range(len(sop)), [i for i, n in enumerate(sop) if i == 0 or n[2] != sop[i - 1][2]]):
        pitches = [sop[i][2] for i in at]
        n = len(pitches)
        for k in range(8, n // 2 + 1):
            if sum(pitches[j] == pitches[j + k] for j in range(n - k)) >= 0.9 * (n - k):
                # the earliest start whose next play matches it note for note
                start = max(range(min(k, n - 2 * k + 1)),
                            key=lambda o: (sum(pitches[o + j] == pitches[o + k + j] for j in range(k)), -o))
                cuts = [sop[at[j]][0] for j in range(start, n, k)] + [sop[-1][1] + 1]
                return list(zip(cuts, cuts[1:]))
    return [(sop[0][0], sop[-1][1] + 1)]


def verse_span(voices, tpb):
    """The play of the tune most of the others agree with in every part: not
    an intro with the lower parts left out, nor a last verse's Amen."""
    spans = plays(voices[0])
    early = tpb // 8  # a chord a little ragged
    sig = [tuple(tuple(p for s, _, p in v if lo - early <= s < hi - early) for v in voices.values())
           for lo, hi in spans]
    return spans[max(range(len(spans)), key=lambda i: (sig.count(sig[i]), -i))]


def time_signature(times, start, end):
    """The time signature in force over most of the verse."""
    if not times:
        return 4, 4
    spans = {}
    for i, (t, num, den) in enumerate(times):
        hi = times[i + 1][0] if i + 1 < len(times) else end
        spans[(num, den)] = spans.get((num, den), 0) + max(min(hi, end) - max(t, start), 0)
    return max(spans, key=spans.get)


def transcribe(hymn, force=False):
    stem = Path(hymn["midi_url"]).stem
    src = MIDI_DIR / f"{stem}.mid"
    dest = ABC_DIR / f"{stem}.abc"
    if dest.exists() and not force:
        return f"{hymn['id']}: {dest.name} exists, skipped"
    tpb, voices, keys, times = read_voices(src)
    origin, end = verse_span(voices, tpb)
    # the lower voices may come in just before the melody
    origin = min([origin] + [n[0] for v in voices.values() for n in v if origin - tpb // 8 <= n[0] < origin])
    cut = {c: [n for n in v if origin <= n[0] < end] for c, v in voices.items()}
    beats = beat_map(cut, tpb, origin)
    q = {c: quantize(v, beats) for c, v in cut.items()}

    num, den = time_signature(times, origin, end)
    bar_len = Fraction(num * 4, den)
    q, pickup = drop_holds(q, num, bar_len)
    s, d, ps = q[0][-1]  # the last note fills its bar, not the pause before verse 2
    room = bar_len - (s - pickup) % bar_len
    for c, v in q.items():
        if v and v[-1][0] + v[-1][1] >= s:
            v[-1] = (v[-1][0], s + room - v[-1][0], v[-1][2])
    # the file's key signatures, unless the notes say otherwise (a few are wrong)
    marks = [(beats(max(t, origin)), key_name(k)) for t, k in keys if t < end]
    bounds = [m[0] for m in marks[1:]] + [Fraction(10 ** 6)]
    fits = marks and all(
        fit_key({c: [n for n in v if lo <= n[0] < hi] for c, v in q.items()}, k) == k
        for (lo, k), hi in zip(marks, bounds))
    key = marks[0][1] if fits else fit_key(q)
    # A later key signature is written as accidentals: abcjs plays an inline
    # [K:] in the lower staves as if it held from the start of the line.
    changes = []
    label = key_label(key, q[3][-1][2][-1] % 12)

    counts = syllables_per_line(hymn)
    target = sum(counts)
    slurs, slots = melismas(q[0], counts, {n[0] for c in (1, 2, 3) for n in q[c]}) if counts else (set(), len(q[0]))

    title = hymn["tune"].upper()
    composer = hymn.get("composer_arranger") or hymn.get("Composer") or ""
    head = [
        f"% Source: transcribed from the app's own MIDI ({src.name}) by Sheet Music/transcribe_midi.py",
        "X:1",
        f"T:{title}",
        *([f"C:{composer}"] if composer else []),
        f"M:{num}/{den}",
        "L:1/4",
        "Q:1/4=100",
        "%%score (S A) (T B)",
        'V:S clef=treble name=""',
        "V:A clef=treble",
        "V:T clef=bass",
        "V:B clef=bass",
        f"K:{label}",
    ]
    body = []
    for c, name in enumerate("SATB"):
        body.append(f"[V:{name}] " + render(q[c], Speller(key, label.endswith("m")), bar_len, pickup,
                                              slurs if c == 0 else frozenset(), changes,
                                              "bass" if c > 1 else "treble"))
    dest.write_text("\n".join(head + body) + "\n", encoding="utf-8")
    return (f"{hymn['id']}: wrote {dest.name} (key {key}, {num}/{den}, pickup {pickup}, "
            f"{len(q[0])} melody notes, {len(slurs)} slurred for {target} syllables"
            + ("" if slots == target else f" - {slots - target:+d} notes, the words won't fit") + ")")


def main(argv):
    force = "--force" in argv
    ids = [int(a) for a in argv if a.isdigit()]
    hymns = {h["id"]: h for h in json.loads((ROOT / "hymns_data.json").read_text(encoding="utf-8"))}
    for i in ids:
        print(transcribe(hymns[i], force))


if __name__ == "__main__":
    main(sys.argv[1:])

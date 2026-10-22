"""Writes Sheet Music/syllables.tsv: how every word in the hymns can be sung.

The web build sets each verse's words under the notes (web/scripts/underlay.mjs).
Words the scores themselves already set are split the way the hymnal splits
them; this file covers the rest. Each line is a word (letters only, lower case)
and then its splits, best first, syllables joined by "-":

    heaven	heav-en	heaven
    glorious	glo-ri-ous	glo-rious

How many syllables comes from the CMU Pronouncing Dictionary (cmudict.dict from
github.com/cmusphinx/cmudict, BSD licence) - every pronunciation it gives, so
"every" is both ev-ery and ev-er-y. Hymns also sing some words a syllable short
("heav'n", "pow'r") or an -ed in full ("bless-ed"), so those are offered as
well, after the dictionary's. Archaic verb forms the dictionary lacks
("givest", "maketh") are counted from the verb. Where the letters are cut is
a reading aid only - a verse is only set when every line comes out to the right
number of syllables, whatever the cut.

    python "Sheet Music/build_syllables.py" path/to/cmudict.dict
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "Sheet Music" / "syllables.tsv"

VOWELS = "aeiouy"
# Consonant pairs that begin a syllable together (so "a-bove" but "sil-ver")
ONSETS = {"bl", "br", "ch", "cl", "cr", "dr", "dw", "fl", "fr", "gl", "gr", "gu", "kn", "ph", "pl", "pr",
          "qu", "sc", "sh", "sk", "sl", "sm", "sn", "sp", "st", "sw", "th", "tr", "tw", "wh", "wr"}
# Letter pairs that stay with the syllable before
KEEP_BEFORE = {"ck", "gh", "ng"}
# Vowel pairs usually sung as two syllables
SPLIT_VOWELS = ("ia", "io", "iu", "ie", "eo", "ea", "ua", "ue", "uo", "ui", "oe", "oa", "ya", "yo")


def load_cmu(path):
    counts = {}
    for line in Path(path).read_text(encoding="utf-8", errors="replace").splitlines():
        if not line or line.startswith(";;;"):
            continue
        word, *phones = line.split("#")[0].split()
        word = re.sub(r"\(\d+\)$", "", word)
        n = sum(1 for p in phones if p[-1].isdigit())
        counts.setdefault(word, set()).add(n)
    return counts


def vowel_groups(word):
    """Start and end of each run of vowels, a final silent e dropped."""
    groups = []
    # y is a vowel before a consonant ("my-stery") and before -ing ("sup-ply-ing")
    for m in re.finditer(r"[aeiou]+|y(?![aeiou])|(?<=[^aeiou])y(?=ing)", word):
        if m.start() == 0 and m.group() == "y":
            continue
        groups.append([m.start(), m.end()])
    # Silent final e ("love", "grace"), but not "the", "be", or "-le" ("ta-ble")
    if len(groups) > 1 and word.endswith("e") and groups[-1] == [len(word) - 1, len(word)] \
            and not re.search(r"[^aeiou]le$", word):
        groups.pop()
    # Silent -es / -ed after most consonants ("graces" keeps its e, "loved" doesn't)
    if len(groups) > 1 and re.search(r"[^aeiou](es|ed)$", word) and groups[-1][0] == len(word) - 2:
        before = word[-3]
        if (word.endswith("ed") and before not in "td") or (word.endswith("es") and before not in "scxzgh"):
            groups.pop()
    return groups


def split_word(word, n):
    """`word` cut into `n` syllables, or None."""
    if n <= 1:
        return [word]
    groups = vowel_groups(word)
    # Too few vowel runs: split those usually sung as two ("glo-ri-ous")
    # then any run of two vowels ("ho-ur"), then a final e ("fi-re")
    while len(groups) < n:
        for g in groups:
            run = word[g[0]:g[1]]
            cut = next((i for i in range(len(run) - 1) if run[i:i + 2] in SPLIT_VOWELS), None)
            if cut is not None and g[1] - g[0] >= 2:
                groups.insert(groups.index(g) + 1, [g[0] + cut + 1, g[1]])
                g[1] = g[0] + cut + 1
                break
        else:
            long_run = next((g for g in groups if g[1] - g[0] >= 2), None)
            if long_run:
                groups.insert(groups.index(long_run) + 1, [long_run[0] + 1, long_run[1]])
                long_run[1] = long_run[0] + 1
            elif word.endswith("e") and groups[-1][1] < len(word) - 1:
                groups.append([len(word) - 1, len(word)])
            else:
                return None
    # Too many: sing the last ones together ("heav'n" = "heaven" as one)
    while len(groups) > n:
        groups[-2][1] = groups[-1][1]
        groups.pop()
    cuts = []
    for a, b in zip(groups, groups[1:]):
        between = word[a[1]:b[0]]
        if len(between) <= 1:
            cuts.append(a[1])  # one consonant goes with the vowel after it: "a-bove"
        elif between[:2] in KEEP_BEFORE:
            cuts.append(a[1] + 2)  # "sing-ing", "rock-ing"
        elif between[-2:] in ONSETS:
            cuts.append(b[0] - 2)  # "Fa-ther", "hun-dred"
        else:
            cuts.append(b[0] - 1)  # "sil-ver", "mer-cy"
    parts, last = [], 0
    for c in cuts:
        parts.append(word[last:c])
        last = c
    parts.append(word[last:])
    return parts if all(parts) and len(parts) == n else None


def counts_for(word, cmu):
    """Syllable counts the dictionary gives, best first; None if it doesn't know the word."""
    if word in cmu:
        return sorted(cmu[word])
    for end, extra in (("'s", 0), ("s'", 0), ("'", 0), ("'st", 0), ("est", 1), ("eth", 1), ("st", 0), ("th", 0)):
        if word.endswith(end):
            base = word[: -len(end)]
            for b in (base, base + "e", base[:-1] if len(base) > 2 and base[-1] == base[-2] else None):
                if b and b in cmu:
                    return sorted(c + extra for c in cmu[b])
    return None


def guess(word):
    return max(1, len(vowel_groups(word)))


def splits(surface, cmu):
    word = surface.lower().replace("’", "'")
    letters = re.sub(r"[^a-z]", "", word)
    if not letters:
        return []
    if "-" in word.strip("-"):
        # A hyphenated word: each part on its own
        parts = [p for p in word.split("-") if re.sub(r"[^a-z]", "", p)]
        each = [splits(p, cmu) for p in parts]
        if not all(each):
            return []
        return ["-".join(e[0] for e in each)]
    counts = counts_for(word, cmu) or counts_for(word.replace("'", ""), cmu)
    known = counts is not None
    counts = list(counts or [guess(letters)])
    # Hymns' own habits, offered after the dictionary
    extra = []
    top = max(counts)
    if top >= 2 and re.search(r"(ven|ver|wer|wer|our|ire|ier|ial|ian|ious|eous|iest|ery|ering|ary|ory|ing)s?$|ev(e|')", letters):
        extra.append(top - 1)
    if re.search(r"[^aeioutd]ed$", letters) and len(letters) > 4:
        extra.append(max(counts) + 1)  # "bless-ed", "a-maz-ed"
    if not known:
        extra += [c for c in (guess(letters) - 1, guess(letters) + 1) if c >= 1]
    out = []
    for n in counts + extra:
        s = split_word(letters, n)
        if s:
            out.append("-".join(s))
    return list(dict.fromkeys(out))


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    cmu = load_cmu(sys.argv[1])
    hymns = json.loads((ROOT / "hymns_data.json").read_text(encoding="utf-8"))
    words = {}
    for h in hymns:
        for verse in h.get("verses") or []:
            # Words parted by spaces or by a dash between them, as underlay.mjs reads them
            for w in re.split(r"\s+|(?<=[a-zA-Z][—–])(?=[a-zA-Z])", re.sub(r"^\s*\d+\.\s*", "", verse)):
                w = w.strip(".,;:!?\"()[]“”‘—–")
                key = re.sub(r"[^a-z]", "", w.lower())
                if key and key not in words:
                    words[key] = splits(w, cmu)
    lines = [f"{k}\t" + "\t".join(v) for k, v in sorted(words.items()) if v]
    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"{len(words)} words, {len(lines)} written -> {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()

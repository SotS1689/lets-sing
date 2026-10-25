// Words under the notes for every verse a hymn has, not just the verses its
// score happens to set. Open Hymnal scores put the first five verses under the
// notes and print the rest as plain text, and the Cyber Hymnal scores and the
// psalter's tunes set no words at all; this sets the hymn's own words under them.
// Where a score sets other words than the hymn's (another translation, an older
// wording), those verses are set again with the hymn's words.
//
// A new verse follows a verse the score already sets where there is one: the
// same notes take a fresh syllable, the same notes carry a syllable on. Where
// the score sets none, every note takes a syllable except one a slur or tie
// carries on from the note before. The words are split into syllables the way
// the hymnal itself splits them in the scores' own verses, then as
// "Sheet Music/syllables.tsv" has them (see build_syllables.py), and each line
// of the verse has to come out to exactly as many syllables as that line of the
// tune has notes for: a word sung two ways ("heav-en", "heav'n") takes whichever
// fits. A verse that can't be made to fit gets no words rather than words under
// the wrong notes.
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";

const ABCJS = createRequire(import.meta.url)("abcjs");

/** A word reduced to the letters that identify it: "Heav'n's," -> "heavns". */
const key = (word) => word.toLowerCase().normalize("NFD").replace(/[^a-z]/g, "");

/** The sung notes of each voice, in order: start (character offset in the ABC),
 *  each verse's syllable (abcjs's lyric array), and whether a slur or tie
 *  carries the note before on through it. */
function lyricNotes(abc) {
    const [tune] = ABCJS.parseOnly(abc);
    const voices = {};
    const slurs = {};
    for (const line of tune.lines) {
        (line.staff || []).forEach((staff, s) =>
            (staff?.voices || []).forEach((elements, v) => {
                const id = `${s}.${v}`;
                const list = (voices[id] ??= []);
                for (const el of elements) {
                    if (el.el_type !== "note" || el.rest || !el.pitches?.length) continue;
                    const open = slurs[id] || 0;
                    const tied = el.pitches.some((p) => p.endTie);
                    list.push({ start: el.startChar, lyric: el.lyric || [], carried: open > 0 || tied });
                    const starts = el.pitches.reduce((n, p) => n + (p.startSlur?.length || 0), 0) + (el.startSlur?.length || 0);
                    const ends = el.pitches.reduce((n, p) => n + (p.endSlur?.length || 0), 0) + (el.endSlur?.length || 0);
                    slurs[id] = Math.max(0, open + starts - ends);
                }
            })
        );
    }
    return voices;
}

const rowsOf = (notes) => Math.max(0, ...notes.map((n) => n.lyric.length));

/** One verse as set under the notes: its syllables in order, grouped into words. */
function setWords(notes, row) {
    const words = [];
    let open = false;
    for (const n of notes) {
        const l = n.lyric[row];
        if (!l?.syllable) continue;
        // The verse number is written onto the first syllable ("1. A")
        const text = l.syllable.replace(/^\d+\.\s*/, "");
        if (open) words[words.length - 1].push(text);
        else words.push([text]);
        open = l.divider === "-";
    }
    return words;
}

/**
 * How each word can be split into syllables, best first: key -> list of splits
 * ("heav-en"). First the ways the scores' own verses split it (commonest
 * first), then the ways syllables.tsv gives.
 */
export function syllableDictionary(abcs, tsvPath) {
    const seen = new Map();
    for (const abc of abcs) {
        let voices;
        try {
            voices = lyricNotes(abc);
        } catch {
            continue;
        }
        for (const notes of Object.values(voices)) {
            for (let r = 0; r < rowsOf(notes); r++) {
                for (const word of setWords(notes, r)) {
                    // Two words sung on one note ("the~e-") aren't one word's split
                    if (word.some((s) => /\s/.test(s.trim()))) continue;
                    const k = key(word.join(""));
                    if (!k) continue;
                    const split = word.map((s) => key(s)).join("-");
                    if (!seen.has(k)) seen.set(k, new Map());
                    seen.get(k).set(split, (seen.get(k).get(split) || 0) + 1);
                }
            }
        }
    }
    const dict = new Map();
    for (const [k, counts] of seen) dict.set(k, [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s));
    if (tsvPath && existsSync(tsvPath)) {
        for (const line of readFileSync(tsvPath, "utf8").split(/\r?\n/)) {
            const [k, ...splits] = line.split("\t");
            if (!k) continue;
            const list = dict.get(k) || [];
            for (const s of splits) if (s && !list.includes(s)) list.push(s);
            dict.set(k, list);
        }
    }
    return dict;
}

/** A verse's lines as lists of words, its verse number taken off. */
const verseLines = (verse) =>
    verse
        .replace(/^\s*\d+\.\s*/, "")
        .split("\n")
        // A dash between words ("cross—the grave") parts them as a space would
        .map((line) => line.split(/\s+|(?<=[a-z][—–])(?=[a-z])/i).filter((w) => key(w)))
        .filter((line) => line.length);

const isLetter = (c) => /[a-z]/i.test(c.normalize("NFD")[0]);

/** The ways a word can be sung: each a list of its syllables as written (its
 *  capitals and punctuation kept), cut where the dictionary cuts it. */
function ways(word, dict) {
    const k = key(word);
    const splits = (dict.get(k) || []).map((s) => s.split("-"));
    if (!splits.length && oneSyllable(k)) splits.push([k]);
    return splits.map((parts) => {
        const out = [];
        let i = 0;
        parts.forEach((part, p) => {
            let taken = "";
            for (let need = part.length; i < word.length && need > 0; i++) {
                taken += word[i];
                if (isLetter(word[i])) need--;
            }
            // Apostrophes and punctuation stay with the syllable before; the last takes the rest
            while (i < word.length && (p === parts.length - 1 || !isLetter(word[i]))) taken += word[i++];
            out.push(taken);
        });
        return out;
    });
}

/** A word with a single vowel sound: one run of vowels, or a silent final e. */
function oneSyllable(k) {
    const groups = k.replace(/e$/, "").match(/[aeiouy]+/g) || [];
    return groups.length <= 1 && k.length > 0;
}

/** Words of one line split so the syllables total `target`, keeping as near each
 *  word's first way as can be; null when no choice of ways does. */
function fitLine(words, target, dict) {
    const options = words.map((w) => ways(w, dict));
    if (options.some((o) => !o.length)) return null;
    let states = new Map([[0, { cost: 0, picks: [] }]]);
    for (const opts of options) {
        const next = new Map();
        for (const [count, st] of states) {
            opts.forEach((split, rank) => {
                const c = count + split.length;
                if (c > target) return;
                const cost = st.cost + rank;
                if (!next.has(c) || next.get(c).cost > cost) next.set(c, { cost, picks: [...st.picks, split] });
            });
        }
        states = next;
    }
    return states.get(target)?.picks ?? null;
}

/** Each line's syllables as its words are first split: what the verse "wants". */
const naturalCounts = (lines, dict) => lines.map((line) => line.reduce((n, w) => n + (ways(w, dict)[0]?.length ?? 1), 0));

/** The commonest value in a list. */
function mode(values) {
    const c = new Map();
    for (const v of values) c.set(v, (c.get(v) || 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
}

/** One word spelled two ways: "pow'rs" and "powers", "bless'd" and "blessed". */
const sameWord = (a, b) => a === b || a.replace(/[aeiouy]/g, "") === b.replace(/[aeiouy]/g, "");

/** How a row of the score's words compares with a verse: "same", "near" (but for
 *  a word or few), "part" (one holds the other, as when a refrain is set only
 *  under the first verse, or a row sets two verses or alleluias the verse leaves
 *  out) or "other" words. */
function likeness(words, lines) {
    const own = lines.flat().map(key), set = words.map((w) => key(w.join("")));
    if (own.length === set.length) {
        const same = own.filter((w, i) => sameWord(w, set[i])).length;
        if (same === own.length) return "same";
        if (same >= 0.85 * own.length) return "near";
    }
    // How many words the row and the verse have in common, in order
    let prev = new Array(own.length + 1).fill(0);
    for (const s of set) {
        const row = [0];
        for (let j = 0; j < own.length; j++) row.push(sameWord(s, own[j]) ? prev[j] + 1 : Math.max(prev[j + 1], row[j]));
        prev = row;
    }
    const shorter = Math.min(set.length, own.length), longer = Math.max(set.length, own.length);
    const common = prev[own.length];
    // A word or two more or fewer, and a word or two changed: an older wording
    if (longer - shorter <= 2 && common < shorter && common >= 0.85 * longer) return "near";
    return shorter && set.length !== own.length && common >= Math.max(0.9 * shorter, shorter - 2) ? "part" : "other";
}

/** Syllables for each line of most of a hymn's verses (as their words are first
 *  split): the tune's lines, for verses whose own count is off by a "heav'n". */
function meterOf(verses, dict) {
    const all = verses.map(verseLines);
    const lineCount = mode(all.map((l) => l.length));
    const wants = all.filter((l) => l.length === lineCount).map((l) => naturalCounts(l, dict));
    return Array.from({ length: lineCount }, (_, i) => mode(wants.map((w) => w[i])));
}

/** Ways to share `total` syllables among a verse's lines when the score doesn't
 *  say: as its words are first split, else as the hymn's meter has them. Only
 *  whole lines, never a syllable moved across a line. */
function lineCounts(lines, total, dict, meter) {
    const sum = (c) => c.reduce((a, b) => a + b, 0);
    return [naturalCounts(lines, dict), meter].filter((c) => c.length === lines.length && sum(c) === total);
}

/**
 * Sets the hymn's own words under the notes: adds `w:` lines for every verse of
 * `verses` the score doesn't already set, and sets afresh any verse the score
 * sets other words for (another translation, an older wording), keeping that
 * verse's own rhythm, which notes take a syllable. Returns { abc, added, missed }:
 * the verse numbers set, and those that wouldn't fit (a verse whose words the
 * score had wrong is then left without words rather than with the wrong ones).
 */
export function fillVerses(abc, verses, dict) {
    const voices = lyricNotes(abc);
    const unchanged = { abc, added: [], missed: [] };
    // The words go under the voice that already has them, else the top line
    const most = Object.values(voices).sort((a, b) => rowsOf(b) - rowsOf(a))[0];
    const notes = most && rowsOf(most) ? most : voices["0.0"];
    if (!notes?.length) return unchanged;
    const rows = rowsOf(notes);

    // Patterns a verse can follow: which notes take a fresh syllable, and how
    // many syllables each line of the verse has. Each verse the score sets with
    // (nearly) this hymn's words gives one; a verse set with other words is set again.
    const patterns = [];
    const addPattern = (p) => {
        if (!patterns.some((q) => q.perLine.join() === p.perLine.join() && q.slots.join() === p.slots.join())) patterns.push(p);
    };
    const redo = [];
    // A score whose first verse holds more or less than the hymn's (two verses to
    // a row, alleluias the hymn leaves out) sets its verses its own way: it is
    // added to only when its first verse is this hymn's or is set again
    let extend = true;
    for (let r = 0; r < Math.min(rows, verses.length); r++) {
        const words = setWords(notes, r);
        const lines = verseLines(verses[r]);
        const slots = notes.map((n) => !!n.lyric[r]?.syllable);
        const like = likeness(words, lines);
        if (like === "same" || (like === "near" && words.length === lines.flat().length)) {
            let w = 0;
            addPattern({ perLine: lines.map((line) => line.reduce((sum) => sum + words[w++].length, 0)), slots });
        }
        // Words of another of this hymn's verses (the score numbers them differently) stay
        const elsewhere = like === "other" && verses.some((v, i) => i !== r && likeness(words, verseLines(v)) !== "other");
        if (like === "near" || (like === "other" && !elsewhere)) redo.push({ r, slots, near: like === "near" });
        // A refrain set only under the first verse: this verse's words take the
        // notes it leaves bare, as the first verse's do (kept as set if they don't fit)
        else if (r > 0 && like === "part" && lines.flat().length > words.length) {
            const refrain = notes.map((n, j) => slots[j] || (!!n.lyric[0]?.syllable && !n.lyric[r]?.syllable));
            if (refrain.some((s, j) => s !== slots[j])) redo.push({ r, slots: refrain, near: true, refrain: true });
        }
        if (r === 0 && (like === "part" || elsewhere)) extend = false;
    }
    // Syllables in each line of most verses: the tune's lines
    const meter = meterOf(verses, dict);
    if (!rows) {
        // No words in the score: a syllable on every note a slur or tie doesn't carry
        // on, and each line of the tune as long as most verses' lines want
        const slots = notes.map((n) => !n.carried);
        const total = slots.filter(Boolean).length;
        const perLine = meter;
        if (perLine.reduce((a, b) => a + b, 0) !== total) return { abc, added: [], missed: verses.map((_, v) => v + 1) };
        patterns.push({ perLine, slots });
    }

    /** Verse v fitted to the first pattern it fits (one without line lengths
     *  takes those its words fit best), as one token per note: a syllable ("-"
     *  joins it to the rest of its word, the verse number goes on the first),
     *  or "_" carrying the one before on. */
    const setVerse = (v, first = []) => {
        const lines = verseLines(verses[v]);
        const tries = [...first, ...patterns].flatMap((p) =>
            (p.perLine ? [p.perLine] : lineCounts(lines, p.slots.filter(Boolean).length, dict, meter)).map((perLine) => ({ perLine, slots: p.slots }))
        );
        for (const { perLine, slots } of tries) {
            if (perLine.length !== lines.length) continue;
            const fitted = lines.map((line, i) => fitLine(line, perLine[i], dict));
            if (!fitted.every(Boolean)) continue;
            addPattern({ perLine, slots });
            const sung = fitted.flat().flatMap((word) => word.map((syl, i) => escapeWord(syl) + (i < word.length - 1 ? "-" : "")));
            sung[0] = `${v + 1}.~${sung[0]}`;
            let s = 0;
            return { tokens: notes.map((n, j) => (slots[j] ? sung[s++] : "_")), count: sung.length };
        }
        return null;
    };

    /** Verse r as the score sets it, with the words it leaves out (a refrain set
     *  only under the first verse) on the notes the first verse sings there and
     *  this one leaves bare; null unless every word the score sets is the verse's
     *  and each run of bare notes takes exactly the words left out at that point. */
    const fillBare = (r) => {
        const own = verseLines(verses[r]).flat();
        // The words the row sets, and the runs of notes it leaves bare that the
        // first verse sings, each after so many of its words
        const set = [], runs = [];
        let open = false, run = null;
        notes.forEach((n, j) => {
            const l = n.lyric[r];
            if (l?.syllable) {
                run = null;
                if (open) set[set.length - 1].push(l.syllable);
                else set.push([l.syllable]);
                open = l.divider === "-";
            } else if (n.lyric[0]?.syllable) {
                if (!run) runs.push((run = { at: set.length, notes: [] }));
                run.notes.push(j);
            }
        });
        // Which of the verse's words the row's are, in order
        const a = set.map((w) => key(w.join("").replace(/^\d+\.\s*/, ""))), b = own.map(key);
        const lcs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
        for (let i = a.length - 1; i >= 0; i--)
            for (let j = b.length - 1; j >= 0; j--)
                lcs[i][j] = sameWord(a[i], b[j]) ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        // (a verse number standing alone is no word)
        if (lcs[0][0] !== a.filter(Boolean).length) return null;
        // The verse's words left out before each of the row's words (and after the last)
        const between = [[]];
        for (let i = 0, j = 0; j < b.length; j++) {
            for (; i < a.length && !a[i]; i++) between.push([]);
            if (i < a.length && sameWord(a[i], b[j]) && lcs[i][j] === lcs[i + 1][j + 1] + 1) {
                i++;
                between.push([]);
            } else between[i].push(own[j]);
        }
        // A note the first verse sings where this one holds a note on stays held
        const wanted = between.map((words, at) => ({ at, words, run: runs.find((x) => x.at === at) })).filter((g) => g.words.length);
        if (wanted.some((g) => !g.run)) return null;
        const tokens = notes.map((n) => {
            const l = n.lyric[r];
            if (!l?.syllable) return "_";
            const number = l.syllable.match(/^\d+\.\s*/)?.[0];
            const syl = escapeWord(l.syllable.slice(number?.length || 0)).replace(/\s+/g, "~");
            return (number ? `${r + 1}.~` : "") + syl + (l.divider === "-" ? "-" : "");
        });
        for (const { at, words, run } of wanted) {
            const fitted = fitLine(words, run.notes.length, dict);
            if (!fitted) return null;
            const sung = fitted.flatMap((word) => word.map((syl, k) => escapeWord(syl) + (k < word.length - 1 ? "-" : "")));
            if (at === 0) sung[0] = `${r + 1}.~${sung[0]}`;
            run.notes.forEach((j, k) => (tokens[j] = sung[k]));
        }
        return { tokens, count: notes.filter((n) => n.lyric[r]?.syllable).length + wanted.reduce((s, g) => s + g.run.notes.length, 0) };
    };

    const added = [], missed = [];
    // Verses the score sets with other words, each in its own rhythm first
    const replaced = new Map();
    for (const { r, slots, near, refrain } of redo) {
        const row = setVerse(r, [{ perLine: null, slots }]) || (refrain && fillBare(r)) || null;
        if (row) {
            replaced.set(r, row);
            added.push(r + 1);
        } else if (!near) {
            // Nearly the hymn's words (an old spelling, a word or two) are better
            // than none and stay; other words don't
            replaced.set(r, null);
            missed.push(r + 1);
        }
    }
    // Verses beyond those the score sets; when it set none of this hymn's, they
    // follow the rhythm of its first verse
    const fallback = rows && !patterns.length ? [{ perLine: null, slots: notes.map((n) => !!n.lyric[0]?.syllable) }] : [];
    const newRows = [];
    for (let v = rows; extend && v < verses.length; v++) {
        const row = setVerse(v, fallback);
        if (row) added.push(v + 1);
        else missed.push(v + 1);
        newRows.push(row);
    }
    // Rows after the last verse that fits would only be blank
    while (newRows.length && !newRows[newRows.length - 1]) newRows.pop();
    if (!newRows.length && !replaced.size) return { abc, added: [], missed };
    const out = writeRows(abc, notes, newRows, replaced);

    // Read back: every verse's syllables must land on the notes meant for them
    const check = lyricNotes(out);
    const voice = Object.values(check).find((n) => rowsOf(n) >= rows + newRows.length);
    const sungIn = (r) => voice.filter((n) => n.lyric[r]?.syllable).length;
    const ok =
        voice &&
        [...replaced].every(([r, row]) => sungIn(r) === (row ? row.count : 0)) &&
        newRows.every((row, i) => !row || sungIn(rows + i) === row.count);
    if (!ok) return { abc, added: [], missed: [...added, ...missed].sort((a, b) => a - b) };
    return { abc: out, added: added.sort((a, b) => a - b), missed: missed.sort((a, b) => a - b) };
}

/** A syllable written so nothing in it means something else in a w: line. */
const escapeWord = (syl) => syl.replace(/[_*|~\\]/g, "").replace(/-/g, "\\-");

/** Writes the new rows under each line of the voice's music, after the rows
 *  there, and the rows set afresh (`replaced`, by row; null clears one) in place. */
/** Where the rests are in the voice whose sung notes are `notes`. */
function restsOf(abc, notes) {
    const [tune] = ABCJS.parseOnly(abc);
    const voices = {};
    for (const line of tune.lines)
        (line.staff || []).forEach((staff, s) =>
            (staff?.voices || []).forEach((elements, v) => {
                const list = (voices[`${s}.${v}`] ??= { notes: [], rests: [] });
                for (const el of elements) {
                    if (el.el_type !== "note") continue;
                    if (el.rest || !el.pitches?.length) list.rests.push(el.startChar);
                    else list.notes.push(el.startChar);
                }
            })
        );
    return Object.values(voices).find((v) => v.notes[0] === notes[0]?.start)?.rests || [];
}

function writeRows(abc, notes, newRows, replaced = new Map()) {
    const rowCount = rowsOf(notes);
    const src = abc.split("\n");
    const offsets = [];
    let at = 0;
    for (const line of src) {
        offsets.push(at);
        at += line.length + 1;
    }
    const lineOf = (char) => {
        let lo = 0, hi = offsets.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (offsets[mid] <= char) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    };
    // The notes on each line of the ABC
    const byLine = new Map();
    notes.forEach((n, j) => {
        const l = lineOf(n.start);
        if (!byLine.has(l)) byLine.set(l, []);
        byLine.get(l).push(j);
    });
    const rests = restsOf(abc, notes);
    const out = [];
    for (let l = 0; l < src.length; l++) {
        out.push(src[l]);
        if (!byLine.has(l)) continue;
        // A verse that doesn't fit keeps its place with "*" (a note with no word).
        // abcjs spends a "*" on a rest as well, so a rest among this line's notes takes one too
        const first = notes[byLine.get(l)[0]].start, last = notes[byLine.get(l).at(-1)].start;
        const skips = byLine.get(l).length + rests.filter((r) => r > first && r < last).length;
        const words = (row) => "w: " + (row ? byLine.get(l).map((j) => row.tokens[j]) : Array(skips).fill("*")).join(" ");
        // The rows of words already under this line; a line with fewer than the
        // score's other lines (a refrain set once) gets blank ones, so that every
        // verse written here lands in its own row
        const there = [];
        let k = l + 1;
        while (k < src.length && /^w\s*:/.test(src[k])) there.push(src[k++]);
        const rows = Math.max(there.length, newRows.length ? rowCount : 0, ...[...replaced.keys()].map((r) => r + 1));
        for (let r = 0; r < rows; r++) out.push(replaced.has(r) ? words(replaced.get(r)) : there[r] ?? words(null));
        for (const row of newRows) out.push(words(row));
        l = k - 1;
    }
    return out.join("\n");
}

// For Sheet Music/check_words.mjs, which explains why a verse doesn't fit
export { lyricNotes, rowsOf, setWords, verseLines, ways, naturalCounts, meterOf };

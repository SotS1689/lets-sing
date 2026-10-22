// Words under the notes for every verse a hymn has, not just the verses its
// score happens to set. Open Hymnal scores put the first five verses under the
// notes and print the rest as plain text, and the Cyber Hymnal scores and the
// psalter's tunes set no words at all; this sets the hymn's own words under them.
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
        .map((line) => line.split(/\s+/).filter((w) => key(w)))
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

/**
 * Adds `w:` lines for every verse of `verses` the score doesn't already set.
 * Returns { abc, added, missed }: the verse numbers set, and those that wouldn't
 * fit. Leaves the score as it was when its words aren't this hymn's.
 */
export function fillVerses(abc, verses, dict) {
    const voices = lyricNotes(abc);
    const unchanged = { abc, added: [], missed: [] };
    // The words go under the voice that already has them, else the top line
    const most = Object.values(voices).sort((a, b) => rowsOf(b) - rowsOf(a))[0];
    const notes = most && rowsOf(most) ? most : voices["0.0"];
    if (!notes?.length) return unchanged;
    const rows = rowsOf(notes);
    if (verses.length <= rows) return unchanged;

    // Patterns a new verse can follow: which notes take a fresh syllable, and how
    // many syllables each line of the verse has
    const patterns = [];
    for (let r = 0; r < rows; r++) {
        const words = setWords(notes, r);
        const lines = verseLines(verses[r] || "");
        if (words.length !== lines.flat().length) {
            if (r === 0) return unchanged; // the score's words aren't this hymn's
            continue;
        }
        let w = 0;
        const perLine = lines.map((line) => line.reduce((sum) => sum + words[w++].length, 0));
        const slots = notes.map((n) => !!n.lyric[r]?.syllable);
        if (!patterns.some((p) => p.perLine.join() === perLine.join() && p.slots.join() === slots.join())) patterns.push({ perLine, slots });
    }
    if (!rows) {
        // No words in the score: a syllable on every note a slur or tie doesn't carry
        // on, and each line of the tune as long as most verses' lines want
        const slots = notes.map((n) => !n.carried);
        const total = slots.filter(Boolean).length;
        const all = verses.map(verseLines);
        const lineCount = mode(all.map((l) => l.length));
        const wants = all.filter((l) => l.length === lineCount).map((l) => naturalCounts(l, dict));
        const perLine = Array.from({ length: lineCount }, (_, i) => mode(wants.map((w) => w[i])));
        if (perLine.reduce((a, b) => a + b, 0) !== total) return { abc, added: [], missed: verses.map((_, v) => v + 1) };
        patterns.push({ perLine, slots });
    }

    const newRows = [], added = [], missed = [];
    for (let v = rows; v < verses.length; v++) {
        const lines = verseLines(verses[v]);
        let fit = null;
        for (const p of patterns) {
            if (p.perLine.length !== lines.length) continue;
            const fitted = lines.map((line, i) => fitLine(line, p.perLine[i], dict));
            if (fitted.every(Boolean)) {
                fit = { words: fitted.flat(), pattern: p };
                break;
            }
        }
        if (!fit) {
            missed.push(v + 1);
            newRows.push(null);
            continue;
        }
        added.push(v + 1);
        // One token per note: a syllable ("-" joins it to the rest of its word,
        // the verse number goes on the first), or "_" carrying the one before on
        const sung = fit.words.flatMap((word) => word.map((syl, i) => escapeWord(syl) + (i < word.length - 1 ? "-" : "")));
        sung[0] = `${v + 1}.~${sung[0]}`;
        let s = 0;
        newRows.push({ tokens: notes.map((n, j) => (fit.pattern.slots[j] ? sung[s++] : "_")), count: sung.length });
    }
    // Rows after the last verse that fits would only be blank
    while (newRows.length && !newRows[newRows.length - 1]) newRows.pop();
    if (!added.length) return { abc, added, missed };
    const out = writeRows(abc, notes, newRows);

    // Read back: every new verse's syllables must land on the notes meant for them
    const check = lyricNotes(out);
    const voice = Object.values(check).find((n) => rowsOf(n) >= rows + newRows.length);
    const ok =
        voice &&
        newRows.every((row, i) => !row || voice.filter((n) => n.lyric[rows + i]?.syllable).length === row.count);
    if (!ok) return { abc, added: [], missed: [...added, ...missed].sort((a, b) => a - b) };
    return { abc: out, added, missed };
}

/** A syllable written so nothing in it means something else in a w: line. */
const escapeWord = (syl) => syl.replace(/[_*|~\\]/g, "").replace(/-/g, "\\-");

/** Writes the new rows under each line of the voice's music, after the rows there. */
function writeRows(abc, notes, newRows) {
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
    const out = [];
    for (let l = 0; l < src.length; l++) {
        out.push(src[l]);
        if (!byLine.has(l)) continue;
        // Past the rows of words already under this line
        let k = l + 1;
        while (k < src.length && /^w\s*:/.test(src[k])) out.push(src[k++]);
        // A verse that doesn't fit keeps its place with "*" (a note with no word)
        for (const row of newRows) out.push("w: " + byLine.get(l).map((j) => (row ? row.tokens[j] : "*")).join(" "));
        l = k - 1;
    }
    return out.join("\n");
}

// Cyber Hymnal scores (NoteWorthy Composer .nwc) as ABC, the form the web app
// draws (see web/scripts/build-scores.mjs).
//
// A .nwc file from the Cyber Hymnal is "[NWZ]\0" and then zlib-compressed text:
// one "|Kind|Field:value|..." line per staff item. A hymn is two staves, each
// holding two parts: on one stem as a two-note chord when they move together,
// or as the chord's second layer (Dur2/Pos2) when they move in different
// rhythms, in which case the part whose time lags takes the next plain note.
// Each staff becomes two ABC voices, S and A over T and B.
import { inflateSync } from "node:zlib";

const LETTERS = "CDEFGAB";
// Diatonic step of the middle line: B4 on the treble staff, D3 on the bass
const MIDDLE_LINE = { Treble: 4 * 7 + 6, Bass: 3 * 7 + 1 };
const LENGTHS = { Whole: 8, Half: 4, "4th": 2, "8th": 1, "16th": 0.5, "32nd": 0.25 }; // in eighths
const ACCIDENTALS = { "#": 1, b: -1, n: 0, x: 2, v: -2 };
const SHARP_KEYS = ["C", "G", "D", "A", "E", "B", "F#", "C#"];
const FLAT_KEYS = ["C", "F", "Bb", "Eb", "Ab", "Db", "Gb", "Cb"];

/** The text inside a .nwc file, or null when it is the older binary format. */
export function nwcText(bytes) {
    if (bytes.subarray(0, 5).toString("latin1") !== "[NWZ]") return null;
    const text = inflateSync(bytes.subarray(6)).toString("latin1");
    const at = text.indexOf("!NoteWorthyComposer");
    return at < 0 ? null : text.slice(at);
}

/** "|Chord|Dur:4th,Slur|Pos:-3,1" -> { kind: "Chord", Dur: "4th,Slur", Pos: "-3,1" } */
function item(line) {
    const [, kind, ...fields] = line.split("|");
    const out = { kind };
    for (const f of fields) {
        const i = f.indexOf(":");
        if (i > 0) out[f.slice(0, i)] = f.slice(i + 1);
    }
    return out;
}

const length = (dur) => {
    const parts = dur.split(",");
    let l = LENGTHS[parts.find((p) => p in LENGTHS)];
    if (l === undefined) throw new Error(`unknown note length ${dur}`);
    if (parts.includes("Triplet") || parts.some((p) => p.startsWith("Triplet"))) throw new Error("triplets aren't handled");
    if (parts.includes("Grace")) throw new Error("grace notes aren't handled");
    if (parts.includes("DblDotted")) l *= 1.75;
    else if (parts.includes("Dotted")) l *= 1.5;
    return { l, slur: parts.includes("Slur") };
};

/** "#-3^" -> { step: -3, acc: 1, tie: true } */
function position(p) {
    const m = /^([#bnxv]?)(-?\d+)([^,]*)$/.exec(p.trim());
    if (!m) throw new Error(`unknown note position ${p}`);
    return { step: +m[2], acc: m[1] ? ACCIDENTALS[m[1]] : null, tie: m[3].includes("^") };
}

/**
 * Converts one Cyber Hymnal score. Returns { abc, title } or throws when the
 * score is laid out in a way this doesn't read (more or fewer than two staves,
 * triplets, a part dividing where the two parts are out of step).
 * `transpose` moves it that many semitones, into the key a hymn's MIDI is in.
 */
export function nwcToAbc(text, { transpose = 0 } = {}) {
    const staves = [];
    let info = {};
    for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith("|")) continue;
        const it = item(line);
        if (it.kind === "SongInfo") info = it;
        else if (it.kind === "AddStaff") staves.push({ items: [] });
        else if (staves.length) staves[staves.length - 1].items.push(it);
    }
    const sung = staves.filter((s) => s.items.some((i) => i.kind === "Chord" || i.kind === "Note"));
    if (sung.length !== 2) throw new Error(`${sung.length} staves of music, not 2`);

    let key = null, meter = null, tempo = null;
    const voices = []; // S, A, T, B: lists of bars, each a list of { notes|rest, l, slur }
    for (const staff of sung) {
        const clef = staff.items.find((i) => i.kind === "Clef")?.Type;
        if (!(clef in MIDDLE_LINE)) throw new Error(`clef ${clef}`);
        const middle = MIDDLE_LINE[clef];
        const sig = {}; // letter -> alteration
        // NoteWorthy's own timing: each item starts where the last one's shortest
        // note ended; a longer note in it sounds on, and the part singing it is
        // busy until it ends. Each note goes to a part that is free.
        let now = 0;
        const upper = { end: 0, bars: [[]], last: null }, lower = { end: 0, bars: [[]], last: null };
        let barAcc = {}; // diatonic step -> alteration, for the rest of the bar
        let tiedFrom = new Set(); // steps tied over from the item before
        const pitch = (p) => {
            const step = middle + p.step;
            if (p.acc !== null) barAcc[step] = p.acc;
            const letter = LETTERS[((step % 7) + 7) % 7];
            const alt = barAcc[step] ?? sig[letter] ?? 0;
            return { step, alt, tie: p.tie };
        };
        const free = (v) => v.end <= now + 1e-9;
        // Silence while a part waits (NoteWorthy shows nothing there): an unseen rest
        const catchUp = (v, to) => {
            if (v.end < to - 1e-9) v.bars[v.bars.length - 1].push({ rest: true, hidden: true, l: to - v.end, pitches: [] });
            v.end = Math.max(v.end, to);
        };
        const place = (v, entry) => {
            catchUp(v, now);
            v.bars[v.bars.length - 1].push(entry);
            v.end = now + entry.l;
            if (!entry.rest) v.last = entry.pitches[0];
        };
        const group = (dur, pos, rest = false, hidden = false) => {
            const { l, slur } = length(dur);
            return { l, slur, rest, hidden, pitches: rest ? [] : pos.split(",").map(position).map(pitch) };
        };
        /** The one note of `g` a lone free part sings: not one held on by a tie, and
         *  of those the nearest to what that part sang last. */
        const pick = (g, v) => {
            if (g.pitches.length <= 1) return g;
            let options = g.pitches.filter((p) => !tiedFrom.has(p.step));
            if (!options.length) options = g.pitches;
            const near = v.last ? v.last.step : 0;
            options.sort((a, b) => Math.abs(a.step - near) - Math.abs(b.step - near));
            return { ...g, pitches: [options[0]] };
        };
        for (const it of staff.items) {
          try {
            switch (it.kind) {
                case "Key": {
                    const names = (it.Signature || "").split(",").filter((s) => /^[A-G][#b]$/.test(s));
                    for (const n of names) sig[n[0]] = n[1] === "#" ? 1 : -1;
                    const sharps = names.filter((n) => n[1] === "#").length, flats = names.length - sharps;
                    key ??= sharps ? SHARP_KEYS[sharps] : FLAT_KEYS[flats];
                    break;
                }
                case "TimeSig":
                    meter ??= { Common: "4/4", AllaBreve: "2/2" }[it.Signature] || it.Signature;
                    break;
                case "Tempo":
                    tempo ??= +it.Tempo;
                    break;
                case "Bar": {
                    for (const v of [upper, lower]) {
                        if (v.end > now + 1e-9) throw new Error("a note held over the bar line");
                        catchUp(v, now);
                        v.bars.push([]);
                    }
                    barAcc = {};
                    break;
                }
                case "Note":
                case "Chord":
                case "Rest":
                case "RestChord": {
                    const rest = it.kind === "Rest" || it.kind === "RestChord";
                    const hidden = /HideRest/.test(it.Opts || "");
                    const main = group(it.Dur, it.Pos || "", rest, hidden);
                    const second = it.Dur2 ? group(it.Dur2, it.Pos2 || "") : null;
                    const up = free(upper), down = free(lower);
                    if (!up && !down) throw new Error("no part is free for the next note");
                    if (second) {
                        // Two layers: the stem says which part the main one is
                        const stem = /Stem=(Up|Down)/.exec(it.Opts || "")?.[1];
                        const top = (g) => (g.rest ? -Infinity : Math.max(...g.pitches.map((p) => p.step)));
                        const mainIsUpper = stem ? stem === "Up" : top(main) >= top(second);
                        const [forUpper, forLower] = mainIsUpper ? [main, second] : [second, main];
                        if (up && down) {
                            place(upper, one(forUpper, "top"));
                            place(lower, one(forLower, "bottom"));
                        } else {
                            // Only one part free: it takes the notes, and a rest beside
                            // them only holds the place of the part still singing
                            let notes = [main, second].filter((g) => !g.rest);
                            // Both layers the same note: a unison written twice, sung by the free part
                            const same = (a, b) => a.l === b.l && a.pitches.map((p) => p.step).join() === b.pitches.map((p) => p.step).join();
                            if (notes.length === 2 && same(...notes)) notes = [main];
                            if (notes.length !== 1) throw new Error("two layers of notes but only one part free");
                            const v = up ? upper : lower;
                            place(v, pick(notes[0], v));
                        }
                    } else if (up && down) {
                        // In step: the top note is the upper part's, the bottom the lower's
                        // (one note is both singing it)
                        place(upper, one(main, "top"));
                        place(lower, one(main, "bottom"));
                    } else {
                        const v = up ? upper : lower;
                        place(v, pick(main, v));
                    }
                    tiedFrom = new Set([main, second].filter(Boolean).flatMap((g) => g.pitches.filter((p) => p.tie).map((p) => p.step)));
                    now += Math.min(main.l, second ? second.l : Infinity);
                    break;
                }
            }
          } catch (e) {
            throw new Error(`${e.message} (staff ${voices.length / 2 + 1}, bar ${upper.bars.length}: ${it.kind} ${it.Dur || ""} ${it.Pos || ""})`);
          }
        }
        const end = Math.max(upper.end, lower.end);
        for (const v of [upper, lower]) catchUp(v, end);
        for (const v of [upper, lower]) {
            while (v.bars.length && !v.bars[v.bars.length - 1].length) v.bars.pop();
            voices.push(v.bars);
        }
    }
    if (new Set(voices.map((v) => v.length)).size !== 1) throw new Error("the staves have different numbers of bars");

    if (transpose) {
        const moved = transposeVoices(voices, key || "C", transpose);
        key = moved.key;
    }
    const title = (info.Title || "").replace(/^"|"$/g, "").replace(/,\s*[\d.CLMSD ]+$/, "").trim();
    const lines = [
        "X:1",
        `T:${title}`,
        `M:${meter || "4/4"}`,
        "L:1/8",
        ...(tempo ? [`Q:1/4=${tempo}`] : []),
        "%%score (S A) (T B)",
        "V:S clef=treble",
        "V:A clef=treble",
        "V:T clef=bass",
        "V:B clef=bass",
        `K:${key || "C"}`,
    ];
    const sigOf = Object.fromEntries([...LETTERS].map((l) => [l, 0]));
    for (const [letter, alt] of Object.entries(keyAlterations(key || "C"))) sigOf[letter] = alt;
    const BARS_PER_LINE = 4;
    const bars = voices[0].length;
    const written = voices.map((v) => writeVoice(v, sigOf));
    for (let b = 0; b < bars; b += BARS_PER_LINE) {
        ["S", "A", "T", "B"].forEach((name, v) => {
            const chunk = written[v].slice(b, b + BARS_PER_LINE);
            const last = b + BARS_PER_LINE >= bars;
            lines.push(`[V:${name}] ` + chunk.join(" | ") + (last ? " |]" : " |"));
        });
    }
    return { abc: lines.join("\n") + "\n", title };
}

const NATURAL = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const MAJOR_BY_PITCH = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const pitchOf = (name) => (NATURAL[name[0]] + (name[1] === "#" ? 1 : name[1] === "b" ? -1 : 0) + 12) % 12;
const natural = (step) => 12 * Math.floor(step / 7) + NATURAL[LETTERS[((step % 7) + 7) % 7]];

/** Every note moved `semitones`, spelt in the new key; returns { key }. */
function transposeVoices(voices, key, semitones) {
    const to = MAJOR_BY_PITCH[(pitchOf(key) + semitones + 120) % 12];
    let steps = (LETTERS.indexOf(to[0]) - LETTERS.indexOf(key[0]) + 7) % 7;
    if (semitones < 0 && steps > 0) steps -= 7;
    if (semitones > 6 && steps === 0) steps = 7;
    const done = new Set(); // a note both parts sing is one entry in both
    for (const bars of voices)
        for (const bar of bars)
            for (const n of bar) {
                if (done.has(n)) continue;
                done.add(n);
                n.pitches = n.pitches.map((p) => {
                    const sounding = natural(p.step) + p.alt + semitones;
                    const step = p.step + steps;
                    const alt = sounding - natural(step);
                    if (Math.abs(alt) > 2) throw new Error(`can't spell a note moved ${semitones} semitones`);
                    return { ...p, step, alt };
                });
            }
    return { key: to };
}

/** One part's share of a chord: its top or bottom note. */
function one(g, which) {
    if (g.rest || g.pitches.length <= 1) return g;
    const sorted = [...g.pitches].sort((a, b) => a.step - b.step || a.alt - b.alt);
    return { ...g, pitches: [which === "top" ? sorted[sorted.length - 1] : sorted[0]] };
}

function keyAlterations(key) {
    const order = { sharp: "FCGDAEB", flat: "BEADGCF" };
    const s = SHARP_KEYS.indexOf(key), f = FLAT_KEYS.indexOf(key);
    const out = {};
    if (s > 0) for (const l of order.sharp.slice(0, s)) out[l] = 1;
    if (f > 0) for (const l of order.flat.slice(0, f)) out[l] = -1;
    return out;
}

const lengthText = (l) => {
    if (l === 1) return "";
    if (Number.isInteger(l)) return String(l);
    for (const d of [2, 4, 8]) if (Number.isInteger(l * d)) return `${l * d}/${d}`;
    throw new Error(`note length ${l}`);
};

/** One part's bars as ABC: accidentals written wherever the key or the bar so far
 *  wouldn't give the right note, slurs and ties as the score has them. */
function writeVoice(bars, sig) {
    let slurOpen = false;
    return bars.map((bar) => {
        const state = {}; // letter+octave -> alteration written so far in this bar
        const touched = new Set(); // letters given an accidental this bar, any octave
        return bar
            .map((n) => {
                let out = "";
                if (n.rest) out = (n.hidden ? "x" : "z") + lengthText(n.l);
                else {
                    const p = n.pitches[0];
                    const letter = LETTERS[((p.step % 7) + 7) % 7], octave = Math.floor(p.step / 7);
                    const id = letter + octave;
                    const current = state[id] ?? sig[letter];
                    let acc = "";
                    if (p.alt !== current || touched.has(letter)) {
                        acc = { 1: "^", "-1": "_", 0: "=", 2: "^^", "-2": "__" }[p.alt];
                        state[id] = p.alt;
                        touched.add(letter);
                    }
                    const name = octave >= 5 ? letter.toLowerCase() + "'".repeat(octave - 5) : letter + ",".repeat(Math.max(0, 4 - octave));
                    out = acc + name + lengthText(n.l) + (p.tie ? "-" : "");
                }
                // A slur runs from a note marked Slur to the next note after it
                if (n.slur && !slurOpen && !n.rest) {
                    out = "(" + out;
                    slurOpen = true;
                } else if (!n.slur && slurOpen) {
                    out += ")";
                    slurOpen = false;
                }
                return out;
            })
            .join(" ");
    });
}

// Learn exercises the app writes itself (echo patterns, familiar tunes, rounds,
// a line under a tune): from a few lines of scale degrees to the three things a
// hymn has — a MIDI file to play, ABC to draw, and the note map that says when
// each notehead sounds (the same shape scripts/build-scores.mjs writes), so the
// player, the sheet music and the pitch line work on them unchanged.
//
// A line of notes is written as scale degrees counted from the key's home note
// (0 = do, 2 = mi, 4 = sol, 7 = do above, -3 = sol below) with a length in
// eighth notes after a colon: "0:2 2:2 4:4" is do-mi (quarters) then sol (a half).
// "r:4" is a half rest. Every tune is in a major key and uses only its scale.

const STEPS = [0, 2, 4, 5, 7, 9, 11]; // semitones of each degree of a major scale
/** Each key: its home note's letter (0 = C … 6 = B) and pitch class. */
const KEYS = { C: [0, 0], D: [1, 2], Eb: [2, 3], E: [2, 4], F: [3, 5], G: [4, 7], A: [5, 9], Bb: [6, 10] };
const LETTERS = "CDEFGAB";
const NATURAL = [0, 2, 4, 5, 7, 9, 11]; // pitch class of each natural letter

/** "0:2 2:2 r:4" -> [{ deg, dur } | { rest, dur }] */
export function parseLine(text) {
    return text.trim().split(/\s+/).filter((t) => t !== "|").map((t) => {
        const [d, len = "2"] = t.split(":");
        return d === "r" ? { rest: true, dur: +len } : { deg: +d, dur: +len };
    });
}

/** The same line moved `steps` scale steps (a 3rd below = -2). */
export const shiftLine = (notes, steps) => notes.map((n) => (n.rest ? n : { ...n, deg: n.deg + steps }));

/**
 * An exercise from `spec`:
 *   key      "C" … "Bb";  bpm  quarter notes a minute;  meter  "4/4", "6/8", "3/4" or null (bars after rests)
 *   voices   [{ ch, tonic (MIDI pitch of this line's home note), clef ("treble" | "bass" | "treble-8"),
 *               notes (from parseLine), chs? (per-note channel override) }] — top staff first
 * Returns { midi (Uint8Array), abc, map, duration (seconds) }.
 */
export function buildExercise({ key = "C", bpm = 80, meter = "4/4", voices }) {
    const [tonicLetter] = KEYS[key];
    const eighth = 30 / bpm; // seconds
    const keyAcc = keyAccidentals(key);
    const events = []; // MIDI: [tick, on?, ch, pitch]
    const map = { parts: [], verses: [0] };
    const partsByCh = new Map();
    const header = ["X:1", `M:${meter ?? "none"}`, "L:1/8", `Q:1/4=${bpm}`];
    const staves = voices.map((_, i) => `S${i + 1}V1`);
    header.push(`%%staves ${staves.map((s) => `(${s})`).join(" ")}`);
    const bodies = [];
    let duration = 0;
    voices.forEach((v, i) => {
        header.push(`V: ${staves[i]} clef=${v.clef ?? "treble"}`);
        const barLen = meter ? eighthsPerBar(meter) : null;
        let t = 0, inBar = 0, head = 0;
        const out = [];
        v.notes.forEach((n, k) => {
            if (n.rest) {
                out.push(`z${n.dur}`);
            } else {
                const pitch = pitchOf(v.tonic, n.deg);
                const ch = v.chs?.[k] ?? v.ch;
                events.push([t * 240, true, ch, pitch], [(t + n.dur) * 240 - 12, false, ch, pitch]);
                let part = partsByCh.get(ch);
                if (!part) {
                    part = { ch, voice: `${i}.0`, notes: [] };
                    partsByCh.set(ch, part);
                    map.parts.push(part);
                }
                part.notes.push([head++, +(t * eighth).toFixed(3), +(n.dur * eighth).toFixed(3), pitch]);
                out.push(spell(pitch, n.deg, tonicLetter, keyAcc) + n.dur);
            }
            t += n.dur;
            inBar += n.dur;
            if (barLen ? inBar >= barLen : n.rest && k < v.notes.length - 1) {
                out.push("|");
                inBar = 0;
            }
        });
        if (out.at(-1) !== "|") out.push("|");
        out[out.length - 1] = "|]";
        bodies.push(`[V: ${staves[i]}] ${out.join(" ")}`);
        duration = Math.max(duration, t * eighth);
    });
    map.parts.sort((a, b) => a.ch - b.ch);
    header.push(`K:${key}`);
    return { midi: writeMidi(events, bpm), abc: [...header, ...bodies].join("\n"), map, duration };
}

const pitchOf = (tonic, deg) => tonic + Math.floor(deg / 7) * 12 + STEPS[((deg % 7) + 7) % 7];

function eighthsPerBar(meter) {
    const [n, d] = meter.split("/").map(Number);
    return (n * 8) / d;
}

/** Sharps/flats the key signature puts on each letter (C..B), -1/0/+1. */
function keyAccidentals(key) {
    const [letter, pc] = KEYS[key];
    const acc = [0, 0, 0, 0, 0, 0, 0];
    for (let d = 0; d < 7; d++) {
        const l = (letter + d) % 7;
        let diff = (pc + STEPS[d] - NATURAL[l]) % 12;
        if (diff > 6) diff -= 12;
        if (diff < -6) diff += 12;
        acc[l] = diff;
    }
    return acc;
}

/** ABC for `pitch`, spelled as scale degree `deg` (the key signature supplies its sharp or flat). */
function spell(pitch, deg, tonicLetter, keyAcc) {
    const letter = (((tonicLetter + deg) % 7) + 7) % 7;
    const octave = Math.floor((pitch - keyAcc[letter]) / 12) - 1; // of the natural note: C4 = middle C
    const name = LETTERS[letter];
    if (octave >= 5) return name.toLowerCase() + "'".repeat(octave - 5);
    return name + ",".repeat(Math.max(0, 4 - octave));
}

/** A one-track MIDI file (480 ticks a quarter, 240 an eighth). */
function writeMidi(events, bpm) {
    events.sort((a, b) => a[0] - b[0] || (a[1] === b[1] ? 0 : a[1] ? 1 : -1));
    const track = [];
    const vlq = (n) => {
        const bytes = [n & 0x7f];
        while ((n >>= 7)) bytes.unshift((n & 0x7f) | 0x80);
        return bytes;
    };
    const us = Math.round(60000000 / bpm);
    track.push(0, 0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255);
    let last = 0;
    for (const [tick, on, ch, pitch] of events) {
        track.push(...vlq(Math.max(0, Math.round(tick) - last)), (on ? 0x90 : 0x80) | ch, pitch, on ? 90 : 0);
        last = Math.max(last, Math.round(tick));
    }
    track.push(0, 0xff, 0x2f, 0);
    const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    return new Uint8Array([
        0x4d, 0x54, 0x68, 0x64, ...u32(6), 0, 0, 0, 1, 0x01, 0xe0,
        0x4d, 0x54, 0x72, 0x6b, ...u32(track.length), ...track,
    ]);
}

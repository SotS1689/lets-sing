// Sheet music for the player: for every hymn with a score in
// "../Sheet Music/abc/<midi file stem>.abc", writes
//   public/scores/<stem>.abc   the score, trimmed to what the screen shows
//   public/scores/<stem>.json  its note map: when each notehead sounds in the
//                              hymn's own MIDI file
// Called by prepare-content.mjs, which records the result on each hymn.
//
// The design follows the #doreancon hymnal (gitlab.com/svrbc/doreancon.org,
// scripts/annotate-hymnal-svg.py), used with its developer's permission: every
// notehead is labelled ahead of time with its voice, onset and length, so the
// page only has to light the notes whose time has come. The difference is the
// audio. There the MIDI is generated from the score, so the two agree by
// construction; here the MIDI files are the app's own, hand-corrected, with an
// intro and every verse already in them. So each voice's MIDI notes are walked
// against that voice's notes in the score, by pitch, and a hymn whose notes
// don't line up gets no sheet music rather than a highlight in the wrong place.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const ABCJS = createRequire(import.meta.url)("abcjs");

const SCORE_SRC = "../Sheet Music/abc";
const OUT = "public/scores";

/** Below this share of a voice's MIDI notes matched, the hymn is left without sheet music. */
const MIN_MATCHED = 0.97;
/** Notes starting this close together (seconds) are one chord (divisi) in one voice. */
const CHORD_WINDOW = 0.03;
/** How many notes in a row must agree before the walk accepts a jump (the intro, a verse change). */
const RESYNC_RUN = 4;

// ---- MIDI -------------------------------------------------------------------

/** Every note in a MIDI file as { ch, pitch, start, end } in seconds, tempo changes honoured. */
export function readMidi(bytes) {
    let pos = 0;
    const u32 = () => (bytes[pos++] << 24 | bytes[pos++] << 16 | bytes[pos++] << 8 | bytes[pos++]) >>> 0;
    const u16 = () => bytes[pos++] << 8 | bytes[pos++];
    const varLen = () => {
        let v = 0, b;
        do { b = bytes[pos++]; v = v * 128 + (b & 0x7f); } while (b & 0x80);
        return v;
    };
    const chunkId = () => String.fromCharCode(...bytes.slice(pos, (pos += 4)));
    if (chunkId() !== "MThd") throw new Error("not a MIDI file");
    const headerEnd = u32() + pos;
    u16();
    u16();
    const division = u16();
    if (division & 0x8000) throw new Error("SMPTE timing isn't supported");

    const events = []; // { tick, kind: "tempo"|"on"|"off", ... }
    pos = headerEnd;
    while (pos + 8 <= bytes.length) {
        const id = chunkId(), end = u32() + pos;
        if (id !== "MTrk") { pos = end; continue; }
        let tick = 0, status = 0;
        while (pos < end) {
            tick += varLen();
            if (bytes[pos] & 0x80) status = bytes[pos++]; // else running status
            if (status === 0xff) {
                const type = bytes[pos++], len = varLen();
                if (type === 0x51) events.push({ tick, kind: "tempo", usPerBeat: bytes[pos] << 16 | bytes[pos + 1] << 8 | bytes[pos + 2] });
                pos += len;
            } else if (status === 0xf0 || status === 0xf7) {
                pos += varLen();
            } else {
                const type = status & 0xf0, ch = status & 0x0f;
                const d1 = bytes[pos++], d2 = type === 0xc0 || type === 0xd0 ? 0 : bytes[pos++];
                if (type === 0x90 && d2 > 0) events.push({ tick, kind: "on", ch, pitch: d1 });
                else if (type === 0x80 || type === 0x90) events.push({ tick, kind: "off", ch, pitch: d1 });
            }
        }
        pos = end;
    }
    // Tempo first at equal ticks, then note-offs before note-ons (a repeated pitch)
    const order = { tempo: 0, off: 1, on: 2 };
    events.sort((a, b) => a.tick - b.tick || order[a.kind] - order[b.kind]);

    let usPerBeat = 500000, lastTick = 0, seconds = 0;
    const open = new Map(), notes = [];
    for (const e of events) {
        seconds += ((e.tick - lastTick) * usPerBeat) / division / 1e6;
        lastTick = e.tick;
        if (e.kind === "tempo") usPerBeat = e.usPerBeat;
        else if (e.kind === "on") {
            const key = e.ch * 128 + e.pitch;
            if (!open.has(key)) open.set(key, []);
            open.get(key).push(notes.length);
            notes.push({ ch: e.ch, pitch: e.pitch, start: seconds, end: seconds });
        } else {
            const started = open.get(e.ch * 128 + e.pitch);
            if (started?.length) notes[started.shift()].end = seconds;
        }
    }
    return notes;
}

// ---- Score ------------------------------------------------------------------

/** Only what the player shows: the notes and the verses set under them. Titles,
 *  credits and the verses printed as plain text are already on the page;
 *  abcm2ps-only directives (PostScript, custom decorations) abcjs can't use. */
export function screenAbc(abc) {
    // The tune header ends at its first K: line. Some files carry notes about the
    // hymn or PostScript drawing code too, so only lines known to be music get in:
    // the fields that shape the music, %%staves / %%score (which voices share a
    // staff), and in the body voice lines, sung words and bars of notes.
    let inBody = false;
    const kept = [];
    for (const raw of abc.split(/\r?\n/)) {
        const line = raw.replace(/\s+%.*$/, "");
        const field = /^(X|M|L|K|Q|V)\s*:/.test(line) || /^%%(staves|score)\b/.test(line);
        if (!inBody) {
            if (field) kept.push(line);
            if (/^K\s*:/.test(line)) inBody = true;
        } else if (field || /^w\s*:/.test(line) || (/^\[V:/.test(line) || (/\|/.test(line) && !/^\s*%/.test(line) && !/^[A-Za-z]\s*:/.test(line)))) {
            kept.push(line);
        }
    }
    return kept
        .join("\n")
        .replace(/![se]intro!|!\(\)!/g, "") // OpenHymnal's own marks: the intro, a bracketed note
        .replace(/!ferm!/g, "!fermata!") // abcm2ps's short name
        .replace(/\.(?=[-(])/g, ""); // abcm2ps's dotted ties and slurs (sung in some verses only): drawn plain
}

/** A sung notehead (not a rest, bar line or chord symbol). src/score.js has a copy
 *  of this test and of the voice keys below: they must agree, since the page
 *  finds each note again by its voice and its number within that voice. */
export const isNotehead = (el) => el.el_type === "note" && !el.rest && el.pitches?.length > 0;

/**
 * The score's notes, per voice, in reading order (the order abcjs draws them in).
 * Keyed "<staff>.<voice on that staff>": "0.0" is the top line of the top staff.
 * Each note lists every pitch it sounds, since a chord can be two parts on one
 * stem (soprano and alto) or one part dividing.
 */
export function scoreVoices(abc) {
    const [tune] = ABCJS.parseOnly(abc);
    tune.setUpAudio(); // fills in each note's midiPitches
    const voices = {};
    for (const line of tune.lines) {
        (line.staff || []).forEach((staff, s) =>
            (staff?.voices || []).forEach((elements, v) => {
                const notes = (voices[`${s}.${v}`] ??= []);
                for (const el of elements) {
                    if (!isNotehead(el)) continue;
                    // abcjs gives pitches only to the first note of a tie; the
                    // ones tied on to it sound the same
                    const pitches = el.midiPitches?.length
                        ? el.midiPitches.map((p) => p.pitch)
                        : notes[notes.length - 1]?.pitches ?? [];
                    notes.push({ pitches, length: el.duration, tiedOn: !!el.pitches.some((p) => p.startTie) });
                }
            })
        );
    }
    for (const key of Object.keys(voices)) if (!voices[key].length) delete voices[key];
    return voices;
}

/** Ties make one sung note out of several noteheads: groups[i] lists the
 *  noteheads of the i-th sung note. */
export function sungNotes(heads) {
    const groups = [];
    let open = false;
    heads.forEach((h, i) => {
        if (open) groups[groups.length - 1].push(i);
        else groups.push([i]);
        open = h.tiedOn;
    });
    return groups;
}

/**
 * Walks one part's MIDI notes against one score voice's sung notes, which
 * repeat once per verse (an intro is a jump to a later phrase). A MIDI note
 * matches a sung note when it is any of that note's pitches. Returns each matched
 * MIDI note with the sung note it is, plus how many MIDI notes found no match.
 */
export function align(midi, sung, heads) {
    const n = sung.length;
    const fits = (k, pitch) => heads[sung[((k % n) + n) % n][0]].pitches.includes(pitch);
    const matches = [];
    let k = null, unmatched = 0;
    // How many notes in a row from MIDI note i agree with the score from sung note `at`
    const runFrom = (i, at) => {
        let r = 0;
        while (r < n && i + r < midi.length && fits(at + r, midi[i + r].pitch)) r++;
        return r;
    };
    for (let i = 0; i < midi.length; i++) {
        if (k !== null && fits(k, midi[i].pitch)) {
            matches.push({ note: midi[i], sung: k % n });
            k++;
            continue;
        }
        // Lost (or not started): find where the score picks up again. A repeat,
        // a second ending or the intro is a jump, and a short phrase can recur, so
        // the longest agreeing run wins; ties go to the nearest place ahead.
        let at = -1, best = RESYNC_RUN - 1;
        for (let c = 0; c < n; c++) {
            const run = runFrom(i, c);
            const ahead = k === null ? c : (c - (k % n) + n) % n;
            const bestAhead = k === null ? at : (at - (k % n) + n) % n;
            if (run > best || (run === best && at >= 0 && ahead < bestAhead)) { at = c; best = run; }
        }
        if (at < 0) { unmatched++; continue; }
        matches.push({ note: midi[i], sung: at });
        k = at + 1;
    }
    return { matches, unmatched };
}

/** One MIDI channel's notes, one per sounding moment (the top note of a divisi chord). */
function channelNotes(notes, ch) {
    const out = [];
    for (const note of notes.filter((x) => x.ch === ch).sort((a, b) => a.start - b.start || b.pitch - a.pitch)) {
        const last = out[out.length - 1];
        if (last && note.start - last.start < CHORD_WINDOW) continue;
        out.push(note);
    }
    return out;
}

/** The usual home of each MIDI part in a two-staff hymn: S and A on the top staff, T and B below. */
const USUAL_VOICE = ["0.0", "0.1", "1.0", "1.1"];

/**
 * Builds a hymn's note map, or explains why it can't. Each sung MIDI part
 * (channels 0-3: S A T B) is matched to the score voice it follows best,
 * preferring its usual place. A score can set its parts out differently - three
 * parts, soprano and alto as chords on one stem, a melody staff over the choir -
 * and any line no part follows (an organ part) simply never lights.
 */
export function noteMap(abc, midiBytes, verseCount) {
    const voices = scoreVoices(abc);
    // More lines than the four parts means accompaniment staves (organ): the app
    // is for the sung parts, so these hymns get no sheet music for now
    const lines = Object.keys(voices).length;
    if (lines > 4) return { error: `the score has ${lines} lines of music: accompaniment as well as the sung parts` };
    const notes = readMidi(midiBytes);
    const map = { parts: [], verses: [] };
    for (let ch = 0; ch < 4; ch++) {
        const midi = channelNotes(notes, ch);
        if (!midi.length) continue; // a part this hymn doesn't have
        let chosen = null;
        for (const key of [USUAL_VOICE[ch], ...Object.keys(voices)]) {
            const heads = voices[key];
            if (!heads) continue;
            const sung = sungNotes(heads);
            const { matches, unmatched } = align(midi, sung, heads);
            const share = 1 - unmatched / midi.length;
            if (!chosen || share > chosen.share) chosen = { key, heads, sung, matches, share };
            if (key === USUAL_VOICE[ch] && share >= MIN_MATCHED) break; // its usual place fits
        }
        const name = ["soprano", "alto", "tenor", "bass"][ch];
        if (!chosen || chosen.share < MIN_MATCHED) {
            return { error: `the ${name} matches the score at best ${((chosen?.share ?? 0) * 100).toFixed(1)}%` };
        }

        // Each notehead of a tied note gets its share of the sung note's time
        const { key, heads, sung, matches } = chosen;
        const entries = [];
        let previous = null;
        for (const { note, sung: s } of matches) {
            const group = sung[s];
            const total = group.reduce((sum, h) => sum + heads[h].length, 0);
            let t = note.start;
            for (const h of group) {
                const d = ((note.end - note.start) * heads[h].length) / total;
                entries.push([h, +t.toFixed(2), +d.toFixed(2)]); // to 1/100 s: plenty to light a note by
                t += d;
            }
            // A verse starts where the tune's first note comes round again from
            // its end (a jump back from early on is a repeat inside the verse)
            if (ch === 0 && s === 0 && (previous === null || previous >= sung.length / 2)) {
                map.verses.push(+note.start.toFixed(2));
            }
            if (ch === 0) previous = s;
        }
        map.parts.push({ ch, voice: key, notes: entries });
    }
    if (!map.parts.some((p) => p.ch === 0)) return { error: "no soprano part in the MIDI file" };
    // An introduction that plays the whole tune looks like one verse too many
    if (map.verses.length === verseCount + 1) map.verses.shift();
    return { map };
}

// ---- Entry point -------------------------------------------------------------

/** The words of verse 1 as the score sets them under the notes, as plain lower-case
 *  words: the first line of words under each line of music. */
export function firstVerseWords(abc) {
    const out = [];
    let wanted = false; // the next w: line is the first under a line of music
    for (const line of abc.split("\n")) {
        if (/^w\s*:/.test(line)) {
            if (wanted) out.push(line.slice(line.indexOf(":") + 1));
            wanted = false;
        } else if (/^\[V:/.test(line)) wanted = true;
    }
    return plainWords(out.join(" "));
}

/** Text reduced to lower-case words, so a score's syllables and a hymn's verse compare. */
export const plainWords = (text) =>
    text
        .replace(/\b\d+\.~?/g, "") // verse numbers
        .replace(/-\s*/g, "") // syllables joined back into words
        .replace(/[*_~]/g, " ")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[^a-z\s]/g, "")
        .split(/\s+/)
        .filter(Boolean);

/** Writes public/scores/ for every hymn that has a score; returns, per MIDI file,
 *  { abc: score file, version: content hash, words: verse 1 as set under the notes,
 *    verses: verses found in the MIDI }.
 *  `verseCounts` maps each MIDI file to its hymn's number of verses. */
export function buildScores(verseCounts, midiDir) {
    rmSync(OUT, { recursive: true, force: true });
    mkdirSync(OUT, { recursive: true });
    const built = {}, left = [];
    if (!existsSync(SCORE_SRC)) return built;
    for (const name of readdirSync(SCORE_SRC).filter((f) => f.endsWith(".abc"))) {
        const stem = name.slice(0, -4), midi = `${stem}.mid`;
        if (!(midi in verseCounts) || !existsSync(`${midiDir}/${midi}`)) {
            console.warn(`  score ${name}: no hymn plays ${midi}`);
            continue;
        }
        const abc = screenAbc(readFileSync(`${SCORE_SRC}/${name}`, "utf8"));
        let result;
        try {
            result = noteMap(abc, readFileSync(`${midiDir}/${midi}`), verseCounts[midi]);
        } catch (e) {
            result = { error: `couldn't be read (${e.message})` };
        }
        const { map, error } = result;
        if (error) {
            left.push(`${name}: ${error}`);
            continue;
        }
        writeFileSync(`${OUT}/${stem}.abc`, abc);
        const json = JSON.stringify(map);
        writeFileSync(`${OUT}/${stem}.json`, json);
        built[midi] = {
            abc: `${stem}.abc`,
            // Changes only when the score or its note map does (see midiVersion in prepare-content.mjs)
            version: createHash("sha1").update(abc).update(json).digest("hex").slice(0, 10),
            words: firstVerseWords(abc),
            verses: map.verses.length,
        };
    }
    if (left.length) console.warn(`  ${left.length} scores left out (their notes don't line up with the MIDI):\n  ` + left.join("\n  "));
    return built;
}

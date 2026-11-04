// Gives every hymn that borrows another hymn's tune its own copy of that tune's
// score and MIDI, so its own words go under the notes and the MIDI plays its own
// number of verses (which lets the page follow the verse being sung).
//
//   node scripts/split-shared-tunes.mjs          report what it would do
//   node scripts/split-shared-tunes.mjs --write  write the files and update hymns_data.json
//
// The hymn that keeps the shared files is the one whose words the score sets.
// Each other hymn gets:
//   ../Sheet Music/abc/<Title>-<Tune>.abc  the score, with only as many rows of
//       words as the hymn has verses (the build sets the hymn's own words in them)
//   ../midi/<Title>-<Tune>.mid  the MIDI's intro, then its verses: the middle ones
//       repeated or dropped to make up the hymn's count, its last verse kept last
//       (that is where the closing ritardando and any Amen are)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { screenAbc, noteMap, firstVerseWords, plainWords } from "./build-scores.mjs";

const MASTER = "../hymns_data.json";
const MIDI_DIR = "../midi";
const ABC_DIR = "../Sheet Music/abc";
const write = process.argv.includes("--write");

const raw = readFileSync(MASTER, "utf8");
const hymns = JSON.parse(raw);
const fileOf = (h) => decodeURIComponent((h.midi_url || "").split("/").pop() || "");

// ---- MIDI at tick level ------------------------------------------------------

function parseMidi(bytes) {
    let pos = 0;
    const u32 = () => (bytes[pos++] << 24 | bytes[pos++] << 16 | bytes[pos++] << 8 | bytes[pos++]) >>> 0;
    const u16 = () => bytes[pos++] << 8 | bytes[pos++];
    const varLen = () => {
        let v = 0, b;
        do { b = bytes[pos++]; v = v * 128 + (b & 0x7f); } while (b & 0x80);
        return v;
    };
    const id = () => String.fromCharCode(...bytes.slice(pos, (pos += 4)));
    if (id() !== "MThd") throw new Error("not a MIDI file");
    const hEnd = u32() + pos;
    const format = u16();
    u16();
    const division = u16();
    pos = hEnd;
    const tracks = [];
    while (pos + 8 <= bytes.length) {
        const cid = id(), end = u32() + pos;
        if (cid !== "MTrk") { pos = end; continue; }
        const events = [];
        let tick = 0, status = 0;
        while (pos < end) {
            tick += varLen();
            let s = bytes[pos];
            if (s & 0x80) pos++;
            else s = status;
            if (s === 0xff) {
                const type = bytes[pos++], len = varLen();
                events.push({ tick, kind: "meta", type, data: bytes.slice(pos, pos + len) });
                pos += len;
            } else if (s === 0xf0 || s === 0xf7) {
                const len = varLen();
                events.push({ tick, kind: "sysex", status: s, data: bytes.slice(pos, pos + len) });
                pos += len;
            } else {
                status = s;
                const n = (s & 0xf0) === 0xc0 || (s & 0xf0) === 0xd0 ? 1 : 2;
                const data = bytes.slice(pos, pos + n);
                pos += n;
                events.push({ tick, kind: "ch", status: s, data });
            }
        }
        pos = end;
        tracks.push(events);
    }
    return { format, division, tracks };
}

const isOn = (e) => e.kind === "ch" && (e.status & 0xf0) === 0x90 && e.data[1] > 0;
const isOff = (e) => e.kind === "ch" && ((e.status & 0xf0) === 0x80 || ((e.status & 0xf0) === 0x90 && e.data[1] === 0));
const isEnd = (e) => e.kind === "meta" && e.type === 0x2f;
const isTempo = (e) => e.kind === "meta" && e.type === 0x51;

/** Seconds at each tick, from the tempo map (as build-scores.mjs's readMidi reckons them). */
function clock(midi) {
    const tempos = midi.tracks.flat().filter(isTempo).map((e) => ({ tick: e.tick, us: (e.data[0] << 16) | (e.data[1] << 8) | e.data[2] }));
    tempos.sort((a, b) => a.tick - b.tick);
    return (tick) => {
        let t = 0, last = 0, us = 500000;
        for (const tp of tempos) {
            if (tp.tick >= tick) break;
            t += ((tp.tick - last) * us) / 1e6 / midi.division;
            last = tp.tick;
            us = tp.us;
        }
        return t + ((tick - last) * us) / 1e6 / midi.division;
    };
}

/** Each track's notes paired up (on, off) and its other events. */
function split(track) {
    const notes = [], other = [], open = new Map();
    for (const e of track) {
        if (isOn(e)) {
            const k = `${e.status & 0x0f}.${e.data[0]}`;
            const n = { tick: e.tick, end: null, status: e.status, pitch: e.data[0], vel: e.data[1] };
            (open.get(k) ?? open.set(k, []).get(k)).push(n);
            notes.push(n);
        } else if (isOff(e)) {
            const k = `${e.status & 0x0f}.${e.data[0]}`;
            const n = open.get(k)?.shift();
            if (n) n.end = e.tick;
        } else if (!isEnd(e)) other.push(e);
    }
    for (const n of notes) if (n.end === null) n.end = n.tick;
    return { notes, other };
}

/** A new MIDI file made of the source's [start, end) tick ranges played one after another. */
function assemble(midi, segments) {
    const parts = midi.tracks.map(split);
    const out = parts.map(({ notes, other }) => {
        const events = [];
        let at = 0;
        segments.forEach(([s, e], i) => {
            if (i === 0) {
                // Everything that sets the file up before the first note
                for (const ev of other) if (ev.tick < s) events.push({ ...ev, tick: 0 });
            } else {
                // The state in force where this range starts: tempo, and each
                // channel's latest program and controller values
                const state = new Map();
                for (const ev of other) {
                    if (ev.tick > s) continue;
                    if (isTempo(ev)) state.set("tempo", ev);
                    else if (ev.kind === "ch" && (ev.status & 0xf0) === 0xc0) state.set(`p${ev.status}`, ev);
                    else if (ev.kind === "ch" && (ev.status & 0xf0) === 0xb0) state.set(`c${ev.status}.${ev.data[0]}`, ev);
                    else if (ev.kind === "ch" && (ev.status & 0xf0) === 0xe0) state.set(`b${ev.status}`, ev);
                }
                for (const ev of state.values()) events.push({ ...ev, tick: at });
            }
            for (const ev of other) if (ev.tick >= s && ev.tick < e) events.push({ ...ev, tick: ev.tick - s + at });
            for (const n of notes) {
                if (n.tick < s || n.tick >= e) continue;
                events.push({ tick: n.tick - s + at, kind: "ch", status: n.status, data: [n.pitch, n.vel], on: true });
                events.push({ tick: n.end - s + at, kind: "ch", status: (n.status & 0x0f) | 0x80, data: [n.pitch, 0], off: true });
            }
            at += e - s;
        });
        // Offs before ons at the same tick, so a repeated note sounds again
        events.sort((a, b) => a.tick - b.tick || (b.off ? 1 : 0) - (a.off ? 1 : 0));
        const last = events.length ? Math.max(...events.map((e) => e.tick)) : 0;
        events.push({ tick: Math.max(last, at), kind: "meta", type: 0x2f, data: [] });
        return events;
    });
    return writeMidi(midi.format, midi.division, out);
}

function writeMidi(format, division, tracks) {
    const bytes = [];
    const push32 = (v) => bytes.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
    const varLen = (v) => {
        const out = [v & 0x7f];
        while ((v >>>= 7)) out.unshift((v & 0x7f) | 0x80);
        return out;
    };
    bytes.push(..."MThd".split("").map((c) => c.charCodeAt(0)));
    push32(6);
    bytes.push(0, format, (tracks.length >> 8) & 255, tracks.length & 255, (division >> 8) & 255, division & 255);
    for (const events of tracks) {
        const body = [];
        let last = 0;
        for (const e of events) {
            body.push(...varLen(e.tick - last));
            last = e.tick;
            if (e.kind === "meta") body.push(0xff, e.type, ...varLen(e.data.length), ...e.data);
            else if (e.kind === "sysex") body.push(e.status, ...varLen(e.data.length), ...e.data);
            else body.push(e.status, ...e.data);
        }
        bytes.push(..."MTrk".split("").map((c) => c.charCodeAt(0)));
        push32(body.length);
        bytes.push(...body);
    }
    return Uint8Array.from(bytes);
}

// ---- Scores -------------------------------------------------------------------

/** The score with only the first `rows` lines of words under each line of music. */
function keepRows(abc, rows) {
    let n = 0;
    return abc
        .split(/\r?\n/)
        .filter((line) => {
            if (!/^w\s*:/.test(line)) { n = 0; return true; }
            return n++ < rows;
        })
        .join("\n");
}

const stemOf = (h, tuneStem) =>
    h.title
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^A-Za-z0-9 ]/g, "")
        .trim()
        .split(/\s+/)
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join("_") + "-" + tuneStem;

// ---- Main ---------------------------------------------------------------------

const byFile = new Map();
for (const h of hymns) {
    const f = fileOf(h);
    if (f.endsWith(".mid") && existsSync(`${MIDI_DIR}/${f}`)) (byFile.get(f) ?? byFile.set(f, []).get(f)).push(h);
}

const report = [];
for (const [file, group] of byFile) {
    if (group.length < 2) continue;
    const stem = file.slice(0, -4);
    const abcPath = `${ABC_DIR}/${stem}.abc`;
    if (!existsSync(abcPath)) { report.push(`${file}: no score, skipped`); continue; }
    const sourceAbc = readFileSync(abcPath, "utf8");
    const screened = screenAbc(sourceAbc);
    // The owner: the hymn whose first verse the score's words come nearest
    const own = new Set(firstVerseWords(screened));
    const shared = (h) => plainWords(h.verses?.[0] || "").filter((w) => own.has(w)).length;
    const owner = group.reduce((best, h) => (shared(h) > shared(best) ? h : best));
    const bytes = readFileSync(`${MIDI_DIR}/${file}`);
    const { map, error } = noteMap(screened, bytes, owner.verses.length);
    if (error) { report.push(`${file}: ${error}, skipped`); continue; }
    if (map.verses.length !== owner.verses.length) {
        report.push(`${file}: MIDI has ${map.verses.length} verses, ${owner.title} ${owner.verses.length}, skipped`);
        continue;
    }
    // Verse starts in ticks: the soprano note sounding at each verse's start
    const midi = parseMidi(bytes);
    const seconds = clock(midi);
    const sopranoOns = midi.tracks.flat().filter((e) => isOn(e) && (e.status & 0x0f) === 0).map((e) => e.tick);
    const starts = map.verses.map((t) => sopranoOns.reduce((best, tick) => (Math.abs(seconds(tick) - t) < Math.abs(seconds(best) - t) ? tick : best)));
    const firstNote = Math.min(...midi.tracks.flat().filter(isOn).map((e) => e.tick));
    const endTick = Math.max(...midi.tracks.flat().map((e) => e.tick));
    const M = starts.length;
    const verseRange = (i) => [starts[i], i + 1 < M ? starts[i + 1] : endTick + 1];
    const tuneStem = stem.includes("-") ? stem.slice(stem.lastIndexOf("-") + 1) : stem[0].toUpperCase() + stem.slice(1);

    for (const h of group) {
        if (h === owner) continue;
        const N = h.verses.length;
        const newStem = stemOf(h, tuneStem);
        const segments = starts[0] > firstNote ? [[0, starts[0]]] : [];
        for (let i = 1; i < N; i++) segments.push(verseRange(M === 1 ? 0 : Math.min(i, M - 1) - 1));
        segments.push(verseRange(M - 1));
        const out = assemble(midi, segments);
        const abc = `% Copy of ${stem}.abc for "${h.title}": the build sets this hymn's own words under the notes\n` + keepRows(sourceAbc, N);
        const check = noteMap(screenAbc(abc), out, N);
        const ok = !check.error && check.map.verses.length === N;
        report.push(`${ok ? "ok  " : "FAIL"} ${h.id} ${h.title}: ${N} verses (MIDI had ${M}) -> ${newStem}${check.error ? " " + check.error : ok ? "" : ` (found ${check.map.verses.length} verses)`}`);
        if (!ok || !write) continue;
        writeFileSync(`${MIDI_DIR}/${newStem}.mid`, out);
        writeFileSync(`${ABC_DIR}/${newStem}.abc`, abc);
        h.midi_url = `${newStem}.mid`;
    }
}
console.log(report.join("\n"));
if (write) {
    writeFileSync(MASTER, JSON.stringify(hymns, null, 2) + (raw.endsWith("\n") ? "\n" : ""));
    console.log("hymns_data.json updated");
}

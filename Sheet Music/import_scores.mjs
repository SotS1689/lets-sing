// Finds a score for every hymn that has none yet, from
//   - the svrbc psalter's tune library (gitlab.com/svrbc/psalter.svrbc.org,
//     tunes/*.abc: hand-checked four-part ABC, mostly from Cyber Hymnal scores), and
//   - the Cyber Hymnal's own NoteWorthy scores (hymntime.com/tch, misc/download.htm:
//     the tch-nwc<letter>.7z archives, unpacked; its site index, tch-idx.txt, names
//     the tune it sets each hymn title to),
// and keeps one only when every part of the hymn's own MIDI file follows it
// note for note (the same test the web build applies: build-scores.mjs noteMap).
// Writes "Sheet Music/abc/<midi file stem>.abc"; never replaces a score already there.
//
//   node "Sheet Music/import_scores.mjs" --nwc <unpacked nwc folder> --svrbc <psalter.svrbc.org checkout> [--index tch-idx.txt] [--dry]
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nwcText, nwcToAbc } from "./nwc.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT = join(HERE, "abc");
const MIDI = join(ROOT, "LetsSing_Android_Project/app/src/main/assets/midi");
const { screenAbc, noteMap, readMidi, scoreVoices } = await import(pathToFileURL(join(ROOT, "web/scripts/build-scores.mjs")));

const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : null;
};
const nwcDir = arg("--nwc"), svrbcDir = arg("--svrbc"), indexFile = arg("--index");
const DRY = process.argv.includes("--dry"); // report only

/** Names compared without case, spaces or punctuation. */
const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "");

function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else out.push(p);
    }
    return out;
}

// name -> candidate files
const nwcByName = new Map();
if (nwcDir) {
    for (const p of walk(nwcDir).filter((p) => p.toLowerCase().endsWith(".nwc"))) {
        const n = norm(p.split(/[\\/]/).pop().slice(0, -4));
        if (!nwcByName.has(n)) nwcByName.set(n, []);
        nwcByName.get(n).push(p);
    }
}
const svrbcByName = new Map();
if (svrbcDir) {
    for (const name of readdirSync(join(svrbcDir, "tunes")).filter((f) => f.endsWith(".abc"))) {
        const p = join(svrbcDir, "tunes", name);
        const title = /^T:(.*)$/m.exec(readFileSync(p, "utf8"))?.[1] || "";
        for (const n of [norm(name.slice(0, -4)), norm(title), norm(title.replace(/\(.*?\)/g, ""))]) {
            if (!svrbcByName.has(n)) svrbcByName.set(n, p);
        }
    }
}

// Hymn title -> the Cyber Hymnal tunes (MIDI file names) it is set to
const tunesByTitle = new Map();
if (indexFile) {
    for (const line of readFileSync(indexFile, "utf8").split(/\r?\n/)) {
        const m = /^(.+?)\s{2,}(\S+)\s*$/.exec(line.replace(/\u00ad/g, ""));
        if (!m) continue;
        const title = norm(m[1].replace(/\(.*?\)/g, ""));
        if (!tunesByTitle.has(title)) tunesByTitle.set(title, new Set());
        tunesByTitle.get(title).add(norm(m[2]));
    }
}

/** The names a hymn's tune might be filed under. */
function tuneNames(h, stem) {
    const names = [stem];
    for (const t of (h.tune || "").split(/\s+or\s+|\//i)) names.push(t, t.replace(/\(.*?\)/g, ""), t.replace(/[()]/g, " "));
    // The Cyber Hymnal's MIDI file name is its tune name (e.g. richmond_haweis)
    names.push(...(tunesByTitle.get(norm(h.title.replace(/\(.*?\)/g, ""))) || []));
    return [...new Set(names.map(norm).filter(Boolean))];
}

/** How many semitones the MIDI's soprano sits from the score's: the commonest
 *  difference between the pitches each uses most, tried against both. */
function keyShift(midiBytes, abc) {
    const count = (pitches) => {
        const c = new Array(12).fill(0);
        for (const p of pitches) c[((p % 12) + 12) % 12]++;
        return c;
    };
    const heard = count(readMidi(midiBytes).filter((n) => n.ch === 0).map((n) => n.pitch));
    const written = count((scoreVoices(screenAbc(abc))["0.0"] || []).flatMap((n) => n.pitches));
    let best = 0, bestScore = -1;
    for (let s = -6; s <= 6; s++) {
        let score = 0;
        for (let i = 0; i < 12; i++) score += heard[(i + s + 12) % 12] * written[i];
        if (score > bestScore) [best, bestScore] = [s, score];
    }
    return best;
}

/** A svrbc tune as the app shows it: no guitar chords over the melody. */
const svrbcAbc = (text) => text.replace(/"[^"]*"/g, "");

const hymns = JSON.parse(readFileSync(join(ROOT, "hymns_data.json"), "utf8"));
const midiFile = (h) => decodeURIComponent((h.midi_url || "").split("/").pop() || "");
const byMidi = new Map();
for (const h of hymns) {
    const f = midiFile(h);
    if (!f.endsWith(".mid") || !existsSync(join(MIDI, f))) continue;
    if (!byMidi.has(f)) byMidi.set(f, []);
    byMidi.get(f).push(h);
}

const added = [], failed = [];
for (const [file, users] of byMidi) {
    const stem = file.slice(0, -4);
    if (existsSync(join(OUT, `${stem}.abc`))) continue;
    const midi = readFileSync(join(MIDI, file));
    const verses = Math.max(...users.map((h) => (h.verses || []).length));
    const tried = [];
    let kept = null;
    const names = users.flatMap((h) => tuneNames(h, stem));
    const candidates = [];
    for (const n of names) if (svrbcByName.has(n)) candidates.push({ from: `svrbc psalter tunes/${svrbcByName.get(n).split(/[\\/]/).pop()}`, read: () => svrbcAbc(readFileSync(svrbcByName.get(n), "utf8")) });
    for (const n of names) {
        for (const p of nwcByName.get(n) || []) {
            const from = `Cyber Hymnal ${p.split(/[\\/]nwc[\\/]/).pop().replace(/\\/g, "/")}`;
            const text = () => {
                const t = nwcText(readFileSync(p));
                if (!t) throw new Error("older NoteWorthy format");
                return t;
            };
            candidates.push({ from, read: () => nwcToAbc(text()).abc });
            // The Cyber Hymnal's MIDI files are often a key away from its scores
            candidates.push({
                from,
                moved: true,
                read: () => {
                    const shift = keyShift(midi, nwcToAbc(text()).abc);
                    if (!shift) throw new Error("not in another key either");
                    return nwcToAbc(text(), { transpose: shift }).abc;
                },
            });
        }
    }
    const seen = new Set();
    for (const c of candidates) {
        const id = c.from + (c.moved ? " moved" : "");
        if (seen.has(id)) continue;
        seen.add(id);
        try {
            const abc = c.read();
            const { error } = noteMap(screenAbc(abc), midi, verses);
            if (error) {
                tried.push(`${c.from}${c.moved ? " (moved)" : ""}: ${error}`);
                continue;
            }
            kept = { ...c, abc };
            break;
        } catch (e) {
            tried.push(`${c.from}${c.moved ? " (moved)" : ""}: ${e.message}`);
        }
    }
    const who = users.map((h) => `${h.id} ${h.title}`).join("; ");
    if (!kept) {
        failed.push(`${file} (${who}): ` + (tried.length ? tried.join(" / ") : "no score found under its tune's name"));
        continue;
    }
    if (kept.moved) kept.from += " (moved to the MIDI's key)";
    if (!DRY) writeFileSync(join(OUT, `${stem}.abc`), `% Source: ${kept.from}\n` + kept.abc);
    added.push(`${file} <- ${kept.from}`);
}
console.log(`${added.length} scores added`);
for (const a of added) console.log("  " + a);
console.log(`${failed.length} hymns still without one`);
for (const f of failed) console.log("  " + f);

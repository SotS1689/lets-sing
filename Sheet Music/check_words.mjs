// Why a hymn's verses do or don't fit under its score's notes, in a few lines:
// the melody's syllable slots, the syllables each verse line wants, the lines
// that differ from most verses, and words the syllable table doesn't know, for
// each verse that doesn't fit.
// For reviewing a hymn just added (see Missing Hymns/add_from_cyber_hymnal.py).
//
//   node "Sheet Music/check_words.mjs" <hymn id> [...]
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ABC = join(ROOT, "Sheet Music/abc");
const U = await import(pathToFileURL(join(ROOT, "web/scripts/underlay.mjs")));
const { screenAbc } = await import(pathToFileURL(join(ROOT, "web/scripts/build-scores.mjs")));

const hymns = JSON.parse(readFileSync(join(ROOT, "hymns_data.json"), "utf8"));
const abcs = readdirSync(ABC).filter((f) => f.endsWith(".abc")).map((f) => readFileSync(join(ABC, f), "utf8"));
const dict = U.syllableDictionary(abcs, join(ROOT, "Sheet Music/syllables.tsv"));
const key = (w) => w.toLowerCase().normalize("NFD").replace(/[^a-z]/g, "");

for (const id of process.argv.slice(2).map(Number)) {
    const h = hymns.find((x) => x.id === id);
    if (!h) { console.log(`${id}: no such hymn`); continue; }
    const stem = decodeURIComponent((h.midi_url || "").split("/").pop()).replace(/\.mid$/, "");
    const path = join(ABC, `${stem}.abc`);
    console.log(`== ${id} ${h.title} (${h.tune}) - score ${stem}.abc`);
    if (!existsSync(path)) { console.log("  no score"); continue; }
    // As the web build reads it (build-scores.mjs)
    const abc = screenAbc(readFileSync(path, "utf8"));
    const voices = U.lyricNotes(abc);
    const melody = Object.values(voices).sort((a, b) => U.rowsOf(b) - U.rowsOf(a))[0];
    const notes = melody && U.rowsOf(melody) ? melody : voices["0.0"];
    const rows = U.rowsOf(notes);
    const slots = notes.filter((n) => !n.carried).length;
    const meter = U.meterOf(h.verses, dict);
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    console.log(`  melody: ${notes.length} notes, ${slots} not carried on by a slur or tie; score sets ${rows} verse(s) of words`);
    for (let r = 0; r < rows; r++) {
        const w = U.setWords(notes, r);
        console.log(`  score's verse ${r + 1}: ${sum(w.map((x) => x.length))} syllables: ${w.slice(0, 8).map((x) => x.join("")).join(" ")}...`);
    }
    console.log(`  lines as most verses have them: ${meter.join(".")} = ${sum(meter)} syllables`);
    const { missed } = U.fillVerses(abc, h.verses, dict);
    console.log(`  verses that don't fit: ${missed.length ? missed.join(", ") : "none"}`);
    h.verses.forEach((v, i) => {
        const lines = U.verseLines(v);
        const counts = U.naturalCounts(lines, dict);
        const odd = counts.map((c, j) => (c !== meter[j] ? `line ${j + 1} "${lines[j].join(" ")}" ${c} not ${meter[j] ?? "-"}` : null)).filter(Boolean);
        const unknown = lines.flat().filter((w) => !U.ways(w, dict).length).map(key);
        // A verse that fits may still differ from most as first split (sung "heav'n"): not worth a line
        if (missed.includes(i + 1)) {
            console.log(`  verse ${i + 1}:${sum(counts)} syllables${lines.length !== meter.length ? `, ${lines.length} lines not ${meter.length}` : ""}`);
            for (const o of odd) console.log(`      ${o}`);
            if (unknown.length) console.log(`      no syllable split for: ${unknown.join(", ")}`);
        }
    });
}

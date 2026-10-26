// Slurs a score's melody as another ABC score of the same tune sets its words:
// a note that takes no syllable of the other's first verse is carried on from
// the note before. For scores written out from a MIDI file (which slur next to
// nothing) when an older score of the tune with words is at hand, such as the
// Open Hymnal's own, which this app's MIDI files came with. Kept only when more
// verses fit under the notes, over every hymn sung to the score, and none fits
// fewer; the Source line gets a note of it.
//
//   node "Sheet Music/slurs_from_abc.mjs" <midi file stem> <other score.abc> [--dry]
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { slurLike } from "./slurs.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const ABC = join(HERE, "abc");
const ABCJS = createRequire(join(ROOT, "web/package.json"))("abcjs");
const U = await import(pathToFileURL(join(ROOT, "web/scripts/underlay.mjs")));
const { screenAbc } = await import(pathToFileURL(join(ROOT, "web/scripts/build-scores.mjs")));

const [stem, sourcePath] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const DRY = process.argv.includes("--dry");

/** The other score's melody: pitch, and whether its first verse's words carry it on. */
function sungMelody(abc) {
    const [tune] = ABCJS.parseOnly(abc);
    const notes = [];
    for (const line of tune.lines) {
        for (const el of line.staff?.[0]?.voices?.[0] || []) {
            if (el.el_type !== "note" || el.rest || !el.pitches?.length) continue;
            const top = el.pitches.reduce((a, b) => (b.pitch > a.pitch ? b : a));
            notes.push({ pitch: top.pitch, carried: !el.lyric?.[0]?.syllable });
        }
    }
    return notes;
}

const hymns = JSON.parse(readFileSync(join(ROOT, "hymns_data.json"), "utf8"));
const sung = hymns.filter((h) => decodeURIComponent((h.midi_url || "").split("/").pop()).replace(/\.mid$/, "") === stem);
const abcs = readdirSync(ABC).filter((f) => f.endsWith(".abc")).map((f) => readFileSync(join(ABC, f), "utf8"));
const dict = U.syllableDictionary(abcs, join(HERE, "syllables.tsv"));
const fits = (abc) => sung.map((h) => h.verses.length - U.fillVerses(screenAbc(abc), h.verses, dict).missed.length);

const path = join(ABC, `${stem}.abc`);
const raw = readFileSync(path, "utf8");
const abc = raw.replace(/\r\n/g, "\n"); // abcjs counts characters without the \r
// The Open Hymnal writes its tune out again for later verses: only its first
// time through counts, however long that is (the slice that fits most verses)
const whole = sungMelody(screenAbc(readFileSync(sourcePath, "utf8")));
const length = U.lyricNotes(screenAbc(abc))["0.0"]?.length || whole.length;
const sum = (a) => a.reduce((x, y) => x + y, 0);
let r = { why: "no slurs to add" }, rFits = -1;
for (let n = Math.min(whole.length, length); n <= Math.min(whole.length, length + 12); n++) {
    // A transcription and an older score differ in a note or few (a passing note,
    // a held note written as two): the verses that fit afterwards are the test
    const tried = slurLike(abc, whole.slice(0, n), 0.75);
    if (!tried.slurs) {
        if (rFits < 0) r = tried;
        continue;
    }
    const f = sum(fits(tried.abc));
    if (f > rFits) [r, rFits] = [tried, f];
}
const before = fits(abc), total = sung.map((h) => h.verses.length);
if (!r.slurs) {
    console.log(`${stem}: unchanged (${r.why}); verses fitting ${before.join("/")} of ${total.join("/")}`);
    process.exit(0);
}
const after = fits(r.abc);
const better = after.every((v, i) => v >= before[i]) && after.some((v, i) => v > before[i]);
console.log(`${stem}: ${r.slurs} slurs; verses fitting ${before.join("/")} -> ${after.join("/")} of ${total.join("/")}` + (better ? "" : ", not kept"));
if (better && !DRY) {
    const note = `slurs as the words go in ${sourcePath.split(/[\\/]/).pop()}`;
    const out = /^% Source: .*/m.test(r.abc) ? r.abc.replace(/^(% Source: .*)$/m, `$1; ${note}`) : `% Source: ${note}\n` + r.abc;
    writeFileSync(path, raw.includes("\r\n") ? out.replace(/\n/g, "\r\n") : out);
}

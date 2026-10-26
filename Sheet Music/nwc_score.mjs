// One Cyber Hymnal score (.nwc) as the app's sheet music, with the words it
// sets under its melody, kept only when every part of a MIDI file follows it
// (the web build's test, build-scores.mjs noteMap). The Cyber Hymnal's MIDI
// files are often a key away from its scores, so every key within a tritone is
// tried. Prints one line of JSON: { ok, transpose, verses, lyricsDropped, error }.
// For Missing Hymns/refit_from_cyber_hymnal.py.
//
//   node "Sheet Music/nwc_score.mjs" <score.nwc> <tune.mid> <verses the MIDI plays> <out.abc> [source note]
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nwcText, nwcToAbc } from "./nwc.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { screenAbc, noteMap } = await import(pathToFileURL(join(ROOT, "web/scripts/build-scores.mjs")));

const [nwcPath, midiPath, verses, out, source] = process.argv.slice(2);
const report = (r) => console.log(JSON.stringify(r));
const text = nwcText(readFileSync(nwcPath));
if (!text) {
    report({ ok: false, error: "older NoteWorthy format" });
    process.exit(0);
}
const midi = readFileSync(midiPath);
const errors = [];
for (const transpose of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6]) {
    try {
        const { abc, lyricsDropped, verses: set } = nwcToAbc(text, { transpose, lyrics: true });
        const { error } = noteMap(screenAbc(abc), midi, +verses);
        if (error) {
            if (!transpose) errors.push(error);
            continue;
        }
        writeFileSync(out, `% Source: ${source || "Cyber Hymnal " + nwcPath.split(/[\\/]/).pop()}` + (transpose ? " (moved to the MIDI's key)" : "") + "\n" + abc);
        report({ ok: true, transpose, verses: set, lyricsDropped });
        process.exit(0);
    } catch (e) {
        errors.push(e.message);
        break;
    }
}
report({ ok: false, error: errors[0] || "no key matches the MIDI" });

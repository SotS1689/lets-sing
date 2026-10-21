// Copies the hymn content into the web app:
//   ../hymns_data.json (root working master)  -> public/hymns.json (slimmed)
//   Android assets/midi/<file>.mid            -> public/midi/<file>.mid
// Runs automatically before `npm run dev` and `npm run build`, so the root
// hymns_data.json stays the one master copy, as it is for the Android build.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync, rmSync } from "node:fs";

const MASTER = "../hymns_data.json";
const MIDI_SRC = "../LetsSing_Android_Project/app/src/main/assets/midi";
const OUT = "public";

const hymns = JSON.parse(readFileSync(MASTER, "utf8"));

// Same rule as the Android loader: the file name is the midi_url's last path segment
const midiFile = (h) => decodeURIComponent((h.midi_url || "").split("/").pop() || "");

rmSync(`${OUT}/midi`, { recursive: true, force: true });
mkdirSync(`${OUT}/midi`, { recursive: true });

const missing = [];
const slim = [];
for (const h of hymns) {
    const file = midiFile(h);
    const hasMidi = file.endsWith(".mid") && existsSync(`${MIDI_SRC}/${file}`);
    if (hasMidi) copyFileSync(`${MIDI_SRC}/${file}`, `${OUT}/midi/${file}`);
    else missing.push(`${h.id} ${h.title} (${file || "no midi_url"})`);
    slim.push({
        id: h.id,
        title: h.title,
        tune: h.tune || "",
        // HymnJsonLoader.kt falls back to composer_arranger when Composer is blank
        composer: h.Composer || h.composer_arranger || "",
        verses: h.verses || [],
        credits: h.credits || "",
        midi: hasMidi ? file : null,
    });
}
slim.sort((a, b) => a.title.localeCompare(b.title, "en", { sensitivity: "base" }));
writeFileSync(`${OUT}/hymns.json`, JSON.stringify(slim));

console.log(`prepare-content: ${slim.length} hymns, ${readdirSync(`${OUT}/midi`).length} MIDI files`);
if (missing.length) console.warn(`  ${missing.length} without a MIDI file:\n  ` + missing.join("\n  "));

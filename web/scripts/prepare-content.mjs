// Copies the hymn content into the web app:
//   ../Sheet Music/abc/<file>.abc             -> public/scores/ (see build-scores.mjs)
//   ../hymns_data.json (root working master)  -> public/hymns.json (slimmed)
//   ../midi/<file>.mid                        -> public/midi/<file>.mid
// Runs automatically before `npm run dev` and `npm run build`, so the root
// hymns_data.json stays the one master copy.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { buildScores, plainWords } from "./build-scores.mjs";

const MASTER = "../hymns_data.json";
const MIDI_SRC = "../midi";
const OUT = "public";

const hymns = JSON.parse(readFileSync(MASTER, "utf8"));

// The file name is the midi_url's last path segment
const midiFile = (h) => decodeURIComponent((h.midi_url || "").split("/").pop() || "");

rmSync(`${OUT}/midi`, { recursive: true, force: true });
mkdirSync(`${OUT}/midi`, { recursive: true });

// Sheet music, for the hymns that have a score (see build-scores.mjs)
const versesOf = {};
for (const h of hymns) (versesOf[midiFile(h)] ??= []).push(h.verses || []);
const scores = buildScores(versesOf, MIDI_SRC);

// A score is the tune's: hymns sharing a tune share its MIDI file and score.
// The words set under its notes are shown only when they are this hymn's own,
// and the verse being sung is followed only when the MIDI plays this hymn's verses.
function scoreFields(h, score) {
    if (!score) return { score: null };
    return {
        score: score.abc,
        scoreVersion: score.version,
        scoreWords: sameWords(score.words, plainWords((h.verses || [])[0] || "")),
        scoreVerses: score.verses === (h.verses || []).length,
    };
}

// The opening of verse 1, compared letter by letter: syllable breaks ("si- lent")
// and old spellings ("bless'd") differ by a letter or two, another hymn's words
// or another translation by most of them.
const WORDS_COMPARED = 40; // letters
function sameWords(scoreWords, hymnWords) {
    const a = scoreWords.join("").slice(0, WORDS_COMPARED), b = hymnWords.join("").slice(0, WORDS_COMPARED);
    if (a.length < WORDS_COMPARED / 2 || b.length < WORDS_COMPARED / 2) return false;
    // Edit distance between the two openings
    let row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const next = [i];
        for (let j = 1; j <= b.length; j++) {
            next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        row = next;
    }
    return row[b.length] <= WORDS_COMPARED * 0.15;
}

const missing = [];
const slim = [];
for (const h of hymns) {
    const file = midiFile(h);
    const hasMidi = file.endsWith(".mid") && existsSync(`${MIDI_SRC}/${file}`);
    let midiVersion = null;
    if (hasMidi) {
        copyFileSync(`${MIDI_SRC}/${file}`, `${OUT}/midi/${file}`);
        // Changes only when this file's content changes; the app requests
        // midi/<file>?v=<version>, so offline copies of unchanged hymns
        // survive app updates and changed ones are fetched fresh.
        midiVersion = createHash("sha1").update(readFileSync(`${MIDI_SRC}/${file}`)).digest("hex").slice(0, 10);
    } else missing.push(`${h.id} ${h.title} (${file || "no midi_url"})`);
    slim.push({
        id: h.id,
        title: h.title,
        tune: h.tune || "",
        // HymnJsonLoader.kt falls back to composer_arranger when Composer is blank
        composer: h.Composer || h.composer_arranger || "",
        verses: h.verses || [],
        credits: h.credits || "",
        midi: hasMidi ? file : null,
        midiVersion,
        ...scoreFields(h, hasMidi && scores[file]),
    });
}
// Leading punctuation (the apostrophe in "'Tis So Sweet") is skipped, as
// HymnJsonLoader.kt's sortKey does, so those hymns file under T, not first.
const sortKey = (title) => title.trim().replace(/^[^\p{L}\p{N}]+/u, "");
slim.sort((a, b) => sortKey(a.title).localeCompare(sortKey(b.title), "en", { sensitivity: "base" }));
writeFileSync(`${OUT}/hymns.json`, JSON.stringify(slim));

console.log(`prepare-content: ${slim.length} hymns, ${readdirSync(`${OUT}/midi`).length} MIDI files, ${Object.keys(scores).length} with sheet music`);
if (missing.length) console.warn(`  ${missing.length} without a MIDI file:\n  ` + missing.join("\n  "));

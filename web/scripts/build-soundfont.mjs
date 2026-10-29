// Builds public/soundfont/instruments.sf2: just the instruments the player
// offers, cut out of the 32 MB GeneralUser GS soundfont (../soundfonts) so the
// web app downloads a small file. Presets keep their General MIDI program
// numbers; src/player.js (INSTRUMENTS) selects one and locks it on every
// channel, whatever program change the MIDI file itself asks for.
//
// Run once (or after changing the source soundfont or the instrument list):
//   npm run build-soundfont
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { SoundBankLoader } from "spessasynth_core";

const SRC_DIR = "../soundfonts";
const OUT_DIR = "public/soundfont";
// Keep in step with INSTRUMENTS in src/player.js
const PROGRAMS = [0, 19, 24, 52]; // Grand Piano, Pipe Organ, Nylon Guitar, Concert Choir

const src = readFileSync(`${SRC_DIR}/default.sf2`);
const bank = SoundBankLoader.fromArrayBuffer(
    src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength)
);

const isKept = (p) => PROGRAMS.includes(p.program) && p.bankMSB === 0 && p.bankLSB === 0 && !p.isGMGSDrum;
const kept = bank.presets.filter(isKept);
if (kept.length !== PROGRAMS.length) throw new Error(`Expected ${PROGRAMS.length} presets, found ${kept.length}`);
console.log("Keeping: " + kept.map((p) => `${p.program} ${p.name}`).join(", "));

for (const p of [...bank.presets]) {
    if (!isKept(p)) bank.deletePreset(p);
}
bank.removeUnusedElements();
bank.flush();

mkdirSync(OUT_DIR, { recursive: true });
rmSync(`${OUT_DIR}/choir.sf2`, { force: true }); // replaced by instruments.sf2
const out = bank.writeSF2({ software: "Let's Sing build-soundfont" });
writeFileSync(`${OUT_DIR}/instruments.sf2`, Buffer.from(out));
copyFileSync(`${SRC_DIR}/GeneralUser-GS-LICENSE.txt`, `${OUT_DIR}/GeneralUser-GS-LICENSE.txt`);
console.log(`Wrote ${OUT_DIR}/instruments.sf2 (${(out.byteLength / 1024 / 1024).toFixed(2)} MB)`);

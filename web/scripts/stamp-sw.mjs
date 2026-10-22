// After `vite build`: writes dist/sw.js from sw-template.js, filling in
// VERSION (a hash of every published file) and SHELL (the files cached at
// install -- everything except the per-hymn MIDI files and scores, and source maps).
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, sep } from "node:path";

const DIST = "dist";

const walk = (dir) =>
    readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        return statSync(p).isDirectory() ? walk(p) : [p];
    });

const files = walk(DIST)
    .map((p) => relative(DIST, p).split(sep).join("/"))
    .filter((f) => f !== "sw.js")
    .sort();

const template = readFileSync("sw-template.js", "utf8");
const hash = createHash("sha256").update(template);
for (const f of files) {
    hash.update(f);
    hash.update(readFileSync(join(DIST, f)));
}
const version = hash.digest("hex").slice(0, 16);

const shell = ["./", ...files.filter((f) => !f.startsWith("midi/") && !f.startsWith("scores/") && !f.endsWith(".map")).map((f) => `./${f}`)];

const sw = template
    .replace("__VERSION__", version)
    .replace("__SHELL__", JSON.stringify(shell, null, 4));
writeFileSync(join(DIST, "sw.js"), sw);
console.log(`stamp-sw: version ${version}, ${shell.length} shell files, ${files.length - shell.length + 1} cached on demand`);

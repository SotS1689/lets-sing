// Slurs the melody of a score as the Cyber Hymnal's own score of the hymn does,
// so the hymn's words fit under the notes. Scores written out from a MIDI file,
// and the Cyber Hymnal's tune-only scores, slur nothing, so a syllable sung over
// two notes leaves the verse a syllable short and it gets no words. The Cyber
// Hymnal's score for a hymn (the .nwc on the hymn's page, beside its pdf) sets
// the words under its notes, and the notes its syllables skip are the ones its
// slurs and ties carry on.
//
// For each score given (or every score with a verse that doesn't fit): finds
// Cyber Hymnal pages that set the hymn's tune (its tune index, tun/tun-<letter>.htm),
// reads the score on each, lines its melody up with ours note by note, and slurs
// our melody where theirs carries a note on. Only the melody's slurs change, never
// a note. The result is kept only when more verses fit, over every hymn sung to
// the score, and none fits fewer; the Source line gets a note of it.
//
//   node "Sheet Music/slurs_from_cyber_hymnal.mjs" [<midi file stem> ...] [--dry] [--cache <dir>]
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nwcText, nwcToAbc } from "./nwc.mjs";
import { melody, slurLike } from "./slurs.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const ABC = join(HERE, "abc");
const TCH = "http://www.hymntime.com/tch/"; // the site answers on http only
const U = await import(pathToFileURL(join(ROOT, "web/scripts/underlay.mjs")));
const { screenAbc } = await import(pathToFileURL(join(ROOT, "web/scripts/build-scores.mjs")));

const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : null;
};
const DRY = process.argv.includes("--dry");
const CACHE = arg("--cache") || join(tmpdir(), "lets-sing-tch");
mkdirSync(CACHE, { recursive: true });
const stemsAsked = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--cache");

const norm = (s) => s.toLowerCase().normalize("NFD").replace(/&shy;|­/g, "").replace(/[^a-z0-9]/g, "");
const unhtml = (s) =>
    s.replace(/<[^>]+>/g, "").replace(/&shy;|­/g, "").replace(/&amp;/g, "&").replace(/&rsquo;|&#8217;/g, "’").replace(/&nbsp;/g, " ").trim();

/** A Cyber Hymnal file, fetched once and kept in the cache. */
async function fetchTch(path) {
    const file = join(CACHE, path.replace(/[\\/:]/g, "_"));
    if (existsSync(file)) return readFileSync(file);
    const r = await fetch(TCH + path, { headers: { "User-Agent": "Mozilla/5.0" } });
    const body = r.ok ? Buffer.from(await r.arrayBuffer()) : Buffer.alloc(0);
    writeFileSync(file, body);
    return body;
}

// Tune name (as the index writes it, and in short) -> hymn pages that use it
const tunePages = new Map();
for (const letter of "abcdefghijklmnopqrstuvwxyz") {
    const page = (await fetchTch(`tun/tun-${letter}.htm`)).toString("utf8");
    for (const row of page.match(/<tr>[\s\S]*?<\/tr>/g) || []) {
        const cell = /<td>([\s\S]*?)<\/td>/.exec(row);
        if (!cell) continue;
        const name = unhtml(cell[1]);
        const pages = [...row.matchAll(/href="\.\.\/(htm\/[^"]+)"/g)].map((m) => m[1]);
        for (const n of new Set([norm(name), norm(name.replace(/\(.*?\)/g, ""))])) {
            if (n) tunePages.set(n, [...(tunePages.get(n) || []), ...pages]);
        }
    }
}
// Hymn title -> its pages (the title index, ttl/ttl-<letter>.htm): gospel songs
// whose tune has no name of its own are found by their title
const titlePages = new Map();
for (const letter of "abcdefghijklmnopqrstuvwxyz") {
    const page = (await fetchTch(`ttl/ttl-${letter}.htm`)).toString("utf8");
    for (const [, href, name] of page.matchAll(/<a href="\.\.\/(htm\/[^"]+)">([\s\S]*?)<\/a>/g)) {
        const n = norm(unhtml(name));
        titlePages.set(n, [...(titlePages.get(n) || []), href]);
    }
}

/** The names a tune goes by: "Consolator (Webbe)", "Beecher / Hyfrydol", "Old 134th (St. Michael)". */
function tuneNames(tune, stem) {
    const names = new Set();
    for (const part of tune.split(/\s+or\s+|\s*\/\s*/i)) {
        names.add(norm(part));
        names.add(norm(part.replace(/\(.*?\)/g, "")));
        for (const m of part.matchAll(/\((.*?)\)/g)) names.add(norm(m[1]));
    }
    // The MIDI file's own name: "rathbun", "Come_Thou_Almighty_King-ITALIAN_HYMN_TRINITY"
    for (const part of stem.split("-").slice(stem.includes("-") ? 1 : 0)) names.add(norm(part.replace(/_/g, " ")));
    names.delete("");
    return [...names].filter((n) => n.length > 2);
}

/** The scores on a page for one of the tune's names: its own tune's (the "Music:"
 *  line, often set with its first verse's words) and any alternate tune's. */
async function pageScores(path, names) {
    const page = (await fetchTch(path)).toString("utf8");
    const title = unhtml(/<title>([\s\S]*?)<\/title>/.exec(page)?.[1] || "");
    const music = /<span class="lead">Music:<\/span>([\s\S]*?)<\/p>/.exec(page)?.[1] || "";
    const own = /href="([^"]+\.nwc)"/.exec(music)?.[1];
    const named = [...page.matchAll(/href="([^"]+\.nwc)"/g)].map((m) => m[1]).filter((h) => names.includes(norm(decodeURIComponent(h).split("/").pop().slice(0, -4).replace(/\(.*?\)/g, ""))) || names.includes(norm(decodeURIComponent(h).split("/").pop().slice(0, -4))));
    const out = [];
    for (const href of new Set([own, ...named].filter(Boolean))) {
        const nwcPath = href.replace(/^(\.\.\/)+/, "");
        const text = nwcText(await fetchTch(nwcPath));
        if (!text) continue;
        // "1._In the cross of Christ I glo-ry,\nTow-ering ..." -> its syllables; a tune alone has none
        // A refrain is set once, under one verse only: the verse with the most syllables counts
        const lyrics = href === own ? [...text.matchAll(/^\|Lyric\d+\|Text:"(.*)"/gm)].map((m) => m[1]) : [];
        const lyric = lyrics.length > 0;
        const count = (l) => l.replace(/\\n/g, " ").replace(/^\s*\d+\._?/, "").split(/[\s-]+/).filter((s) => /[a-z]/i.test(s)).length;
        const syllables = lyric ? Math.max(...lyrics.map(count)) : null;
        try {
            out.push({ nwcPath, title: lyric ? title : nwcPath.split("/").pop(), abc: nwcToAbc(text).abc, syllables });
        } catch {}
    }
    return out;
}

// Hymns by score
const hymns = JSON.parse(readFileSync(join(ROOT, "hymns_data.json"), "utf8"));
const stemOf = (h) => decodeURIComponent((h.midi_url || "").split("/").pop()).replace(/\.mid$/, "");
const byStem = new Map();
for (const h of hymns) byStem.set(stemOf(h), [...(byStem.get(stemOf(h)) || []), h]);
const abcs = readdirSync(ABC).filter((f) => f.endsWith(".abc")).map((f) => readFileSync(join(ABC, f), "utf8"));
const dict = U.syllableDictionary(abcs, join(HERE, "syllables.tsv"));

/** Verses that fit, per hymn sung to the score. */
const fits = (abc, stem) => (byStem.get(stem) || []).map((h) => h.verses.length - U.fillVerses(screenAbc(abc), h.verses, dict).missed.length);

const stems = stemsAsked.length
    ? stemsAsked
    : [...byStem.keys()].filter((s) => existsSync(join(ABC, `${s}.abc`)) && byStem.get(s).some((h) => U.fillVerses(screenAbc(readFileSync(join(ABC, `${s}.abc`), "utf8")), h.verses, dict).missed.length));

const summary = { fixed: [], better: [], unchanged: [] };
for (const stem of stems) {
    const path = join(ABC, `${stem}.abc`);
    const sung = byStem.get(stem) || [];
    if (!existsSync(path) || !sung.length) {
        console.log(`${stem}: no score or no hymn`);
        continue;
    }
    // abcjs counts characters without the \r of Windows line ends
    const raw = readFileSync(path, "utf8");
    const crlf = raw.includes("\r\n");
    const abc = raw.replace(/\r\n/g, "\n");
    const before = fits(abc, stem);
    const total = sung.map((h) => h.verses.length);
    // Pages that set this tune, the hymn's own first
    const titles = sung.map((h) => norm(h.title.replace(/\(Psalm \d+\)/, "")));
    const pages = [...new Set([...titles.flatMap((t) => titlePages.get(t) || []), ...tuneNames(sung[0].tune || "", stem).flatMap((n) => tunePages.get(n) || [])])];
    const names = tuneNames(sung[0].tune || "", stem);
    const found = (await Promise.all(pages.slice(0, 40).map((p) => pageScores(p, names).catch(() => [])))).flat();
    // Each score once: the hymn's own first, then others with words, then the tune alone
    const rank = (s) => (titles.includes(norm(s.title)) ? 0 : s.syllables !== null ? 1 : 2);
    const scores = [...new Map(found.map((s) => [s.nwcPath, s])).values()].sort((a, b) => rank(a) - rank(b));
    let best = { abc, after: before, note: "" };
    const tried = [];
    for (const s of scores) {
        const theirs = melody(s.abc);
        // Their slurs must be how their words go: one syllable per note not carried on.
        // A tune set without words is tried too; the verses fitting afterwards are the test
        if (s.syllables !== null && theirs.filter((n) => !n.carried).length !== s.syllables) {
            tried.push(`${s.title}: its words don't follow its slurs`);
            continue;
        }
        const r = slurLike(abc, theirs);
        if (!r.slurs) {
            tried.push(`${s.title}: ${r.why}`);
            continue;
        }
        const after = fits(r.abc, stem);
        const gain = after.reduce((a, b) => a + b, 0) - best.after.reduce((a, b) => a + b, 0);
        if (after.every((v, i) => v >= before[i]) && gain > 0) best = { abc: r.abc, after, note: `${r.slurs} slur${r.slurs > 1 ? "s" : ""} as in the Cyber Hymnal's ${s.nwcPath.split("/").pop()} (${s.title})` };
        else tried.push(`${s.title}: ${r.slurs} slurs, no more verses fit (${after.join("/")})`);
        if (best.after.every((v, i) => v === total[i])) break;
    }
    const line = `${stem}: verses fitting ${before.join("/")} of ${total.join("/")}`;
    if (best.abc === abc) {
        console.log(`${line}, unchanged${scores.length ? "" : ` (no Cyber Hymnal score with words found among ${pages.length} pages)`}`);
        for (const t of tried.slice(0, 4)) console.log(`    ${t}`);
        summary.unchanged.push(stem);
        continue;
    }
    const done = best.after.every((v, i) => v === total[i]);
    console.log(`${line} -> ${best.after.join("/")}: ${best.note}`);
    (done ? summary.fixed : summary.better).push(stem);
    const note = `% Melody slurred where the words need it: ${best.note}`;
    const out = /^% Source: .*$/m.test(best.abc) ? best.abc.replace(/^(% Source: .*)$/m, `$1\n${note}`) : `${note}\n${best.abc}`;
    if (!DRY) writeFileSync(path, crlf ? out.replace(/\n/g, "\r\n") : out);
}
console.log(`\n${summary.fixed.length} scores now fit every verse, ${summary.better.length} fit more, ${summary.unchanged.length} unchanged${DRY ? " (dry run: nothing written)" : ""}`);

// Matches a pasted list of hymns (a bulletin, an email, a spreadsheet column)
// to the hymns in the app. Each line is compared with every hymn's title,
// first line and tune by letter triples, so spelling slips, missing commas,
// "heav'n" for "heaven" and extra words around the title still find it.

const norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const clean = (s) => norm(s).replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const numbers = (s) => s.match(/\d+/g) ?? [];

// Each word on its own, padded, so word starts and ends count and
// "psalm 1" doesn't look like "psalm 100"
function grams(s) {
    const set = new Set();
    for (const w of s.split(" ")) {
        if (!w) continue;
        const p = ` ${w} `;
        for (let i = 0; i < p.length - 2; i++) set.add(p.slice(i, i + 3));
    }
    return set;
}

// How alike two gram sets are, also allowing for one sitting inside the other
// (a title with a hymn number or "Opening hymn:" around it)
function similarity(q, c) {
    if (!q.size || !c.size) return 0;
    let common = 0;
    for (const g of c) if (q.has(g)) common++;
    const dice = (2 * common) / (q.size + c.size);
    const titleInLine = common / c.size;
    const lineInTitle = common / q.size;
    return Math.max(dice, 0.9 * titleInLine, 0.75 * lineInTitle);
}

const index = new WeakMap();
function indexOf(hymns) {
    if (!index.has(hymns)) {
        index.set(
            hymns,
            hymns.map((h) => {
                const title = clean(h.title);
                const firstLine = clean((h.verses?.[0] ?? "").split("\n")[0].replace(/^\s*\d+\.?\s*/, ""));
                return {
                    hymn: h,
                    title: grams(title),
                    firstLine: grams(firstLine),
                    tune: grams(clean(h.tune ?? "")),
                    numbers: numbers(title),
                };
            })
        );
    }
    return index.get(hymns);
}

/** The pasted text as one entry per hymn: list numbers, bullets and blank lines dropped. */
export function splitList(text) {
    return text
        .split(/\r?\n|;/)
        .map((line) =>
            line
                .replace(/\t+/g, " ")
                .replace(/^\s*[-*•·◦▪]+\s*/, "")
                .replace(/^\s*(?:(?:hymn|no\.?|#)\s*)?\d+[a-z]?\s*[.):\-–—]?\s+(?=\D)/i, "")
                .trim()
        )
        .filter((line) => (line.match(/\p{L}/gu) ?? []).length >= 3);
}

/** Scores every hymn against one line; best first. */
export function rank(line, hymns, limit = 6) {
    const text = clean(line);
    const q = grams(text);
    const qNumbers = numbers(text);
    const scored = indexOf(hymns).map((e) => {
        let score = Math.max(similarity(q, e.title), 0.95 * similarity(q, e.firstLine));
        // A tune named alongside the title tells same-titled hymns apart
        if (e.tune.size && similarity(q, e.tune) > 0.8) score += 0.1;
        score = Math.max(score, 0.8 * similarity(q, e.tune));
        // Psalm numbers have to agree
        if (qNumbers.length && e.numbers.length) {
            if (e.numbers.some((n) => qNumbers.includes(n))) score += 0.1;
            else score *= 0.6;
        }
        return { hymn: e.hymn, score: Math.min(1, score) };
    });
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

export const SURE = 0.6; // at or above: taken as the hymn meant
export const LIKELY = 0.55; // between: offered, but worth a look

/** Each pasted line with its likely hymns, best first, and how sure the best one is. */
export function matchList(text, hymns) {
    return splitList(text).map((line) => {
        const candidates = rank(line, hymns);
        const [best, next] = candidates;
        const close = next && best.score - next.score < 0.03;
        const confidence = best.score >= SURE && !close ? "sure" : best.score >= LIKELY ? "likely" : "none";
        // The same hymn set to more than one tune
        const tunes = close && next.hymn.title === best.hymn.title;
        return { line, candidates, confidence, tunes };
    });
}

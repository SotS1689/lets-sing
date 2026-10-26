// Slurs one score's melody as another score of the same tune slurs it: where
// the other carries a note on (a slur or tie, one syllable over two notes),
// ours does too. Only slurs are added, never a note changed. Used by
// slurs_from_cyber_hymnal.mjs and slurs_from_abc.mjs.
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ABCJS = createRequire(join(ROOT, "web/package.json"))("abcjs");

/** The first voice's notes: diatonic pitch, where it is in the text, whether a slur or tie carries it on. */
export function melody(abc) {
    const [tune] = ABCJS.parseOnly(abc);
    const notes = [];
    let open = 0;
    for (const line of tune.lines) {
        const voice = line.staff?.[0]?.voices?.[0];
        for (const el of voice || []) {
            if (el.el_type !== "note" || el.rest || !el.pitches?.length) continue;
            const top = el.pitches.reduce((a, b) => (b.pitch > a.pitch ? b : a));
            const tied = el.pitches.some((p) => p.endTie);
            // abcjs counts the spaces either side as part of the note
            let start = el.startChar, end = el.endChar;
            while (/\s/.test(abc[start])) start++;
            while (end > start && /\s/.test(abc[end - 1])) end--;
            notes.push({ pitch: top.pitch, start, end, carried: open > 0 || tied });
            const starts = el.pitches.reduce((n, p) => n + (p.startSlur?.length || 0), 0) + (el.startSlur?.length || 0);
            const ends = el.pitches.reduce((n, p) => n + (p.endSlur?.length || 0), 0) + (el.endSlur?.length || 0);
            open = Math.max(0, open + starts - ends);
        }
    }
    return notes;
}

/** Longest run of notes the two melodies share in order, `shift` steps apart: pairs [i, j]. */
function align(a, b, shift) {
    const n = a.length, m = b.length;
    const L = Array.from({ length: n + 1 }, () => new Int16Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
        for (let j = m - 1; j >= 0; j--)
            L[i][j] = a[i].pitch === b[j].pitch + shift ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const pairs = [];
    for (let i = 0, j = 0; i < n && j < m; ) {
        if (a[i].pitch === b[j].pitch + shift && L[i][j] === L[i + 1][j + 1] + 1) pairs.push([i++, j++]);
        else if (L[i + 1][j] >= L[i][j + 1]) i++;
        else j++;
    }
    return pairs;
}

/** Our melody slurred where theirs carries a note on that ours sings afresh, when
 *  `share` of the notes of each (the longer) are matched. */
export function slurLike(abc, theirs, share = 0.9) {
    const ours = melody(abc);
    let best = [];
    for (let shift = -7; shift <= 7; shift++) {
        const pairs = align(ours, theirs, shift);
        if (pairs.length > best.length) best = pairs;
    }
    // Both melodies have to be the same tune: nearly every note of each matched
    if (best.length < share * Math.max(ours.length, theirs.length)) return { abc, why: `melodies differ (${best.length} of ${ours.length}/${theirs.length} notes match)` };
    const ofTheirs = new Map(best.map(([i, j]) => [j, i]));
    const carry = new Set();
    for (let j = 1; j < theirs.length; j++) {
        if (!theirs[j].carried) continue;
        const i = ofTheirs.get(j), before = ofTheirs.get(j - 1);
        if (i === undefined || before !== i - 1 || ours[i].carried) continue;
        carry.add(i);
    }
    if (!carry.size) return { abc, why: "no slurs to add" };
    // Runs of carried notes, each slurred from the note before it
    const runs = [];
    for (const i of [...carry].sort((x, y) => x - y)) {
        const last = runs[runs.length - 1];
        if (last && last.to === i - 1) last.to = i;
        else runs.push({ from: i - 1, to: i });
    }
    const edits = runs.flatMap((r) => [
        { at: ours[r.from].start, text: "(" },
        { at: ours[r.to].end, text: ")" },
    ]);
    let out = abc;
    for (const e of edits.sort((x, y) => y.at - x.at)) out = out.slice(0, e.at) + e.text + out.slice(e.at);
    return { abc: out, slurs: runs.length };
}

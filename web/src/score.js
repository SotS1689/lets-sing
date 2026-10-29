// Sheet music that follows the playback: the web counterpart of the #doreancon
// hymnal's HymnNotation.tsx (gitlab.com/svrbc/doreancon.org, used with its
// developer's permission). abcjs draws the score; scripts/build-scores.mjs has
// already worked out when every notehead sounds in the hymn's MIDI file, so
// all this does is light the notes whose time has come, each part in its own
// colour, and only for the parts that are switched on.
//
// Two views:
// - "page": the score as a hymnal prints it, reflowed to the screen.
// - "scroll": the whole tune on one long line at a readable size, sliding past
//   so the note being sung stays near the left edge with what comes next in
//   view, and the words of just the verse being sung under it.
import abcjs from "abcjs";

/** Where the note being sung sits in the scrolling view: this share of the way
 *  across the space right of the pinned clefs. Just short of the middle, so the
 *  notes just sung stay in sight on the left instead of vanishing mid-breath. */
const SCROLL_ANCHOR = 0.4;

/**
 * Draws a hymn's score into `host` and returns its controller; rejects when the
 * score can't be loaded (the player works the same without it).
 * A score belongs to the tune, so for a hymn sharing it: `words` false leaves
 * out the words under the notes (they're another hymn's), and `verses` false
 * means the MIDI doesn't play this hymn's verses one per time through, so no
 * line of those words is lit as the verse being sung.
 */
export async function loadScore(host, url, { words = true, verses = true, view = "page" } = {}) {
    let [abc, map] = await Promise.all([
        fetch(url).then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.status)))),
        fetch(url.replace(/\.abc(\?|$)/, ".json$1")).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status)))),
    ]);
    if (!words) abc = abc.split("\n").filter((line) => !/^w\s*:/.test(line)).join("\n");

    const followVerses = words && verses;
    // In the scrolling view `verse` is the time through the tune drawn first
    // (0 = the introduction); `passes` how many times through the line holds
    const state = { view, verse: 1, passes: 1, heads: {}, timeline: null, strip: null, passWidth: 0 };
    const lastVerse = map.verses.length;
    // Words under time through the tune k: that verse's, none for the introduction
    // (or for another hymn's words), verse 1's when the MIDI's verses aren't this hymn's
    const wordsFor = (k) => (k === 0 || !words ? 0 : followVerses ? k : 1);
    let drawnWidth = 0;
    const draw = () => {
        drawnWidth = host.clientWidth;
        painter.clear();
        if (state.view === "scroll") {
            // This time through the tune and then the next, end to end, so the line
            // runs on into what's coming instead of jumping back to its start. One row
            // of words per time through. No tempo mark: the Tempo control sets the pace
            const passes = state.verse < lastVerse ? [state.verse, state.verse + 1] : [state.verse];
            const shown = stripAbc(abc, passes.map(wordsFor)).replace(/\[Q:[^\]]*\]/g, "").replace(/^Q:.*(\r?\n|$)/gm, ""); // the whole line: a blank line would end the tune
            const previousWidth = state.passWidth;
            Object.assign(state, drawStrip(host, shown), { passes: passes.length });
            // A single time through (the last verse) can't measure itself, but the
            // line drawn before it had the same notes
            state.passWidth = passWidth(state) || previousWidth;
        } else {
            Object.assign(state, { heads: drawPage(host, abc), passes: 1, timeline: null, strip: null, pinWidth: 0 });
        }
    };
    const painter = makePainter(state, map, followVerses, host);
    draw();
    // Reflowed whenever the space changes enough to matter (a phone turned on its side);
    // the scrolling line only needs its anchor, which is read from the width each frame
    new ResizeObserver(() => {
        if (host.isConnected && state.view === "page" && Math.abs(host.clientWidth - drawnWidth) > 40) draw();
    }).observe(host);

    return {
        verseAt: (now) => painter.verseAt(now),
        verseCount: map.verses.length,
        paint(now, on, follow = false) {
            if (state.view === "scroll") {
                const verse = painter.verseAt(now);
                const shown = verse === state.verse || (verse === state.verse + 1 && state.passes > 1);
                // Singing on into the second copy, the line is redrawn to start from
                // it (with the verse after it behind) only once the verse before has
                // slid out of sight, so the swap doesn't show. A jump elsewhere (a
                // seek) redraws at once. The last verse needs nothing after it.
                const movingOn = verse === state.verse + 1 && verse < lastVerse && painter.pastPreviousVerse(now);
                if (!shown || movingOn) {
                    state.verse = verse;
                    draw();
                }
            }
            painter.paint(now, on, follow);
        },
        clear() {
            painter.clear();
            if (state.view === "scroll" && state.verse !== 1) {
                state.verse = 1;
                draw();
            }
        },
        /** "page" or "scroll". */
        setView(next) {
            if (next === state.view) return;
            state.view = next;
            state.verse = 1;
            draw();
        },
    };
}

/** Numbered exactly as scoreVoices() in scripts/build-scores.mjs numbers them. */
const isNotehead = (el) => el.el_type === "note" && !el.rest && el.pitches?.length > 0;

/** Each voice's noteheads ("<staff>.<voice>" -> list of each note's SVG elements). */
function noteheads(tune) {
    const heads = {};
    for (const line of tune.lines) {
        (line.staff || []).forEach((staff, s) =>
            (staff?.voices || []).forEach((elements, v) => {
                const list = (heads[`${s}.${v}`] ??= []);
                for (const el of elements) if (isNotehead(el)) list.push(el.abselem?.elemset ?? []);
            })
        );
    }
    return heads;
}

/** The score as a hymnal prints it, reflowed to fit `host`. */
function drawPage(host, abc) {
    host.classList.remove("is-scrolling");
    host.innerHTML = "";
    const width = host.clientWidth;
    const [tune] = abcjs.renderAbc(host, abc, {
        add_classes: true,
        responsive: "resize",
        // Phones get fewer bars per line, at a readable size
        staffwidth: Math.max(280, width - 16),
        wrap: { minSpacing: 1.6, maxSpacing: 2.6, preferredMeasuresPerLine: width < 600 ? 3 : 5 },
        paddingleft: 0,
        paddingright: 0,
        paddingtop: 0,
    });
    return noteheads(tune);
}

/** Only the k-th line of words under each line of music (verse k), so one row
 *  shows; none for k = 0. */
function oneVerse(lines, k) {
    let row = 0;
    return lines.filter((line) => {
        if (/^\[V:/.test(line)) row = 0;
        if (!/^w\s*:/.test(line)) return true;
        return k > 0 && ++row === k;
    });
}

/** The tune written out once per entry of `verses`, end to end, each time with
 *  that verse's words (see oneVerse). */
function stripAbc(abc, verses) {
    const lines = abc.split("\n");
    const start = lines.findIndex((line) => /^\[V:/.test(line));
    const header = lines.slice(0, start), body = lines.slice(start);
    return [...header, ...verses.flatMap((k) => oneVerse(body, k))].join("\n");
}

/** How far the line moves from one time through the tune to the next: between
 *  the first notes of the first two. 0 when it holds only one. */
function passWidth(state) {
    if (state.passes < 2) return 0;
    const list = Object.values(state.heads).find((l) => l.length >= 2);
    const first = list?.[0]?.[0], again = list?.[list.length / 2]?.[0];
    if (!first || !again) return 0;
    const centre = (el) => { const b = el.getBoundingClientRect(); return b.left + b.width / 2; };
    return centre(again) - centre(first);
}

/** The music on one line inside a strip that slides sideways; returns its noteheads. */
function drawStrip(host, abc) {
    // The page view's "resize" mode sizes `host` itself (a padding-bottom as tall
    // as the page); without clearing that, the box stays page-sized
    host.removeAttribute("style");
    host.classList.remove("abcjs-container");
    host.classList.add("is-scrolling");
    host.innerHTML = '<div class="score-strip"></div>';
    const strip = host.firstElementChild;
    const narrow = host.clientWidth < 600;
    // Wide enough that abcjs keeps it all on one line: start from the number of
    // notes in the tune, and widen if it still broke the line
    const music = abc.split("\n").filter((line) => /^\[V:/.test(line));
    const notes = (music.join(" ").replace(/\[V:[^\]]*\]/g, "").match(/[A-Ga-g]/g) || []).length / 4;
    let tune;
    for (let staffwidth = Math.max(host.clientWidth, notes * 72); ; staffwidth *= 1.6) {
        [tune] = abcjs.renderAbc(strip, abc, {
            add_classes: true,
            scale: narrow ? 1.1 : 1.35,
            staffwidth,
            wrap: { minSpacing: 1.4, maxSpacing: 2.2, preferredMeasuresPerLine: 1000 },
            paddingleft: 8,
            paddingright: 8,
            paddingtop: 0,
        });
        if (tune.lines.filter((line) => line.staff).length <= 1 || staffwidth > 60000) break;
    }
    const heads = noteheads(tune);
    return { heads, timeline: null, strip, pinWidth: pinClefs(host, strip) };
}

/** A copy of the line's clefs and key signature held at the left edge, so the key
 *  stays in sight while the music slides under it. Returns its width. */
function pinClefs(host, strip) {
    const svg = strip.querySelector("svg");
    if (!svg) return 0;
    const left = svg.getBoundingClientRect().left;
    // Up to the end of the key signature (or the clef, in C major)
    const signs = [...svg.querySelectorAll(".abcjs-key-signature, .abcjs-clef")];
    const end = Math.max(...signs.map((el) => el.getBoundingClientRect().right));
    if (!isFinite(end)) return 0;
    const width = end - left + 8;
    const pin = document.createElement("div");
    pin.className = "score-pin";
    pin.style.width = `${width}px`;
    const copy = svg.cloneNode(true);
    // Nothing in the copy should light up or be read twice by a screen reader
    copy.querySelectorAll(".abcjs-lyric, .abcjs-tempo").forEach((el) => el.remove());
    copy.setAttribute("aria-hidden", "true");
    pin.append(copy);
    host.append(pin);
    return width;
}

/** Index of the last entry starting at or before `now` (entries are [head, start, ...]). */
function lastStarted(entries, now) {
    let lo = 0, hi = entries.length - 1, found = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (entries[mid][1] <= now) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found;
}

function makePainter(state, map, lightWords, host) {
    let lit = new Map(); // svg element -> part (MIDI channel: 0 S, 1 A, 2 T, 3 B)
    let lastLine = null, lastFollow = 0;

    // Where parts share a score voice, each one's place in it from the top
    // (parts come in S A T B order); null for a part with a voice to itself
    const sharing = {};
    for (const p of map.parts) (sharing[p.voice] ??= []).push(p.ch);
    const parts = map.parts.map((p) => ({
        ...p,
        rank: sharing[p.voice].length > 1 ? sharing[p.voice].indexOf(p.ch) : null,
    }));
    const verseStarts = map.verses.map((t) => [0, t]);

    /** The rank-th notehead of a chord from the top; the whole note when it has just one (a unison). */
    function noteheadOf(el, rank) {
        const heads = [...(el.querySelectorAll?.(":scope > .abcjs-notehead") ?? [])];
        if (heads.length < 2) return el;
        heads.sort((a, b) => a.getBBox().y - b.getBBox().y);
        return heads[Math.min(rank, heads.length - 1)];
    }

    const verseAt = (now) => lastStarted(verseStarts, now) + 1;

    return {
        /** Verse being sung at `now`: 0 for the intro, then 1..n. */
        verseAt,

        /** Lights what sounds at `now` (seconds into the MIDI); `on[ch]` false skips that part. */
        paint(now, on, follow = false) {
            const verse = verseAt(now);
            const scrolling = state.view === "scroll";
            // The verse's line of words: in the scrolling view the only one there is
            const wordsRow = scrolling ? 0 : verse - 1;
            // Each part's note sounding at `now`, muted or not: the words follow the
            // melody's notes even when the melody itself is muted
            const sounding = [];
            for (const { ch, voice, notes, rank } of parts) {
                const i = lastStarted(notes, now);
                if (i < 0) continue;
                const [head, start, length] = notes[i];
                if (now >= start + length) continue; // a rest, or between notes
                // The scrolling line holds the tune twice: which copy this note is in
                const list = state.heads[voice] ?? [];
                const copy = scrolling ? verseAt(start) - state.verse : 0;
                if (copy < 0 || copy >= state.passes) continue;
                sounding.push({ ch, rank, els: list[head + (copy * list.length) / state.passes] ?? [] });
            }
            // The words take the colour of the highest part heard right now (or,
            // in its rests, the highest part turned on)
            const wordsPart = sounding.find((s) => on[s.ch])?.ch ?? parts.find((p) => on[p.ch])?.ch;
            const next = new Map();
            for (const { ch, rank, els } of sounding) {
                for (const el of els) {
                    // Two parts on one stem (soprano and alto written as chords):
                    // each lights only its own notehead, the upper part the higher one
                    if (on[ch]) {
                        const own = rank === null ? el : noteheadOf(el, rank);
                        if (!next.has(own)) next.set(own, ch);
                    }
                    // A note's words are one <text> inside it with a line per verse:
                    // only the verse being sung lights (none when it isn't set under the notes)
                    const line = lightWords && verse > 0 && !rank && wordsPart !== undefined && el.querySelector?.(":scope > .abcjs-lyric")?.children[wordsRow];
                    if (line?.textContent && !next.has(line)) next.set(line, wordsPart);
                }
            }
            for (const [el, v] of lit) if (next.get(el) !== v) el.classList.remove("is-sounding", `part-${v}`);
            for (const [el, v] of next) if (lit.get(el) !== v) el.classList.add("is-sounding", `part-${v}`);
            lit = next;
            if (scrolling) slide(now);
            if (follow) (scrolling ? keepStripInView : keepInView)(next);
        },

        clear() {
            for (const [el, v] of lit) el.classList.remove("is-sounding", `part-${v}`);
            lit = new Map();
            lastLine = null;
            if (state.strip) state.strip.style.transform = "";
        },

        /** Whether the music at `now` is far enough into the second copy that
         *  nothing of the first is left in view (left of the anchor, past the pin). */
        pastPreviousVerse(now) {
            const points = timeline();
            if (state.nextStartX === null) return false;
            const pin = state.pinWidth || 0;
            return positionAt(points, now) - state.nextStartX > anchorX() - pin + 24;
        },
    };

    // ---- Scrolling view ----

    /** [x, time] for every note (x its centre in the strip, in pixels; time the
     *  middle of its sounding), in time order; built on first use after each drawing. */
    function timeline() {
        if (state.timeline) return state.timeline;
        const left = state.strip.getBoundingClientRect().left;
        const centres = new Map();
        const centre = (el) => {
            if (!centres.has(el)) {
                const box = el.getBoundingClientRect();
                centres.set(el, box.left + box.width / 2 - left);
            }
            return centres.get(el);
        };
        // Each note of this time through the tune at its place in the first copy,
        // the next time through's in the second, and the time before's (sung just
        // before this line was drawn) where it would sit one copy further left
        const v = state.verse;
        const startOf = (k) => (k <= 0 ? -Infinity : map.verses[k - 1] ?? Infinity);
        const points = [];
        for (const { voice, notes } of parts) {
            const list = state.heads[voice] ?? [];
            const n = list.length / state.passes;
            for (const [head, start] of notes) {
                let el = null, offset = 0;
                if (start >= startOf(v) && start < startOf(v + 1)) el = list[head]?.[0];
                else if (state.passes > 1 && start >= startOf(v + 1) && start < startOf(v + 2)) el = list[head + n]?.[0];
                else if (v > 0 && state.passWidth && start >= startOf(v - 1) && start < startOf(v)) {
                    el = list[head]?.[0];
                    offset = -state.passWidth;
                }
                if (el) points.push([centre(el) + offset, start]);
            }
        }
        points.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
        // One point per moment: parts singing together share it
        const moments = points.filter((p, i) => i === 0 || p[1] - points[i - 1][1] > 0.02);
        // Each note passes the anchor halfway through its time, until the next one
        // starts: it arrives a little right of it and leaves a little left, rather
        // than starting there and drifting off while it's still being sung
        state.timeline = moments.map(([x, t], i) => [x, (t + (moments[i + 1]?.[1] ?? t + 1)) / 2]);
        // Where the second copy's first note is, for pastPreviousVerse
        state.nextStartX = moments.find(([, t]) => t >= startOf(v + 1) && state.passes > 1)?.[0] ?? null;
        return state.timeline;
    }

    /** Where in the strip the music at `now` is, gliding between notes. */
    function positionAt(points, now) {
        const i = Math.max(0, lastStarted(points, now));
        const [x0, t0] = points[i];
        const following = points[i + 1];
        // Glide towards the next note, unless the music jumps back (a repeat)
        if (following && following[0] > x0 && now > t0) {
            return x0 + (following[0] - x0) * Math.min(1, (now - t0) / (following[1] - t0));
        }
        return x0;
    }

    /** Where on screen the note being sung sits. */
    function anchorX() {
        const pin = state.pinWidth || 0;
        return pin + (host.clientWidth - pin) * SCROLL_ANCHOR;
    }

    /** Slides the strip so the music at `now` sits at the anchor. */
    function slide(now) {
        const points = timeline();
        if (!points.length) return;
        const shift = Math.min(0, anchorX() - positionAt(points, now));
        state.strip.style.transform = `translateX(${shift.toFixed(1)}px)`;
    }

    /** Keeps the scrolling line on screen below the sticky controls (checked at most once a second). */
    function keepStripInView() {
        if (performance.now() - lastFollow < 1000) return;
        lastFollow = performance.now();
        const box = host.getBoundingClientRect();
        const controls = document.querySelector(".controls")?.getBoundingClientRect().bottom ?? 0;
        if (box.top < controls || box.bottom > innerHeight) {
            scrollBy({ top: box.top - controls - 56, behavior: "smooth" });
        }
    }

    // ---- Page view ----

    // Scrolls the line being sung into view when it has run off screen, below
    // the sticky controls. Only on a change of line, so it doesn't fight a
    // reader who is looking ahead.
    function keepInView(next) {
        const el = next.keys().next().value;
        if (!el) return;
        // abcjs marks every note with its line of music: class "abcjs-l<n>"
        const tagged = el.closest?.('[class*="abcjs-l"]');
        const line = tagged?.getAttribute("class").match(/abcjs-l(\d+)/)?.[1];
        if (line === undefined || line === lastLine) return;
        lastLine = line;
        const box = el.getBoundingClientRect();
        const controls = document.querySelector(".controls")?.getBoundingClientRect().bottom ?? 0;
        if (box.top < controls + 40 || box.bottom > innerHeight - 40) {
            scrollBy({ top: box.top - controls - 72, behavior: "smooth" });
        }
    }
}

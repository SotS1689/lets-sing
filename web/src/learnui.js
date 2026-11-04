// The Learn tab's course screens: the tracks and their lessons (#/learn), a
// lesson with its exercises (#/learn/<track>/<n>), and the range check.
// Lesson progress is kept on this device, like favorites and scores, and in the
// singer's account when signed in (src/sync.js).
import * as player from "./player.js";
import { TRACKS, trackById, SUPPORT, TUNES, PARTS } from "./lessons.js";
import { buildExercise, parseLine, shiftLine } from "./exercise.js";
import { tally, shares, splitBar, addRun, MIN_SECONDS } from "./progress.js";
import { loadScore } from "./score.js";
import { listen } from "./learn.js";
import { changed } from "./sync.js";

const KEY = "learnLessons";
/** How far behind the music the voice reaches the app (as on the hymn page). */
const LAG = 0.16;
/** Share of the part's notes that must be sung for an exercise to count. */
const MIN_COVERAGE = 0.6;

// ---- Progress through the course ---------------------------------------------
// { best: { "<track>.<lesson>.<exercise>": { on, passed } }, open: { "<track>.<lesson>": true },
//   range: { lo, hi, part }, rangeAt: <when range was set>, track: "<last track looked at>" }

function loadState() {
    try {
        const s = JSON.parse(localStorage.getItem(KEY));
        if (s && typeof s === "object") return { best: {}, open: {}, ...s };
    } catch { /* fall through */ }
    return { best: {}, open: {} };
}
function saveState(s) {
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ }
    changed();
}

const exKey = (t, l, e) => `${t}.${l}.${e}`;
const lessonPassed = (s, t, i) => t.lessons[i].exercises.every((_, e) => s.best[exKey(t.id, i, e)]?.passed);
const lessonOpen = (s, t, i) => i === 0 || lessonPassed(s, t, i - 1) || !!s.open[`${t.id}.${i}`];
const passedCount = (s, t) => t.lessons.filter((_, i) => lessonPassed(s, t, i)).length;

const NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
const noteName = (p) => `${NAMES[((Math.round(p) % 12) + 12) % 12]}${Math.floor(Math.round(p) / 12) - 1}`;

const ICON = {
    passed: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.2l-3.5-3.5L4 14.2l5 5 11-11-1.5-1.5z"/></svg>',
    locked: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 9V7A5 5 0 007 7v2H5v12h14V9h-2zm-8-2a3 3 0 016 0v2H9V7z"/></svg>',
    open: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="6" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
};

// ---- The tracks ----------------------------------------------------------------

/** The Learn tab: every track and its lessons, then the singer's scores below (`scoresHost` filled by main). */
export function renderCourse(host, ctx) {
    const s = loadState();
    const beginnerDone = passedCount(s, TRACKS[0]) === TRACKS[0].lessons.length;
    const suggested = s.range?.part;
    const shown = s.track ?? (beginnerDone && suggested !== undefined ? TRACKS[suggested + 1].id : "beginner");
    host.innerHTML = `
        <p class="learn-intro">Learn to sing on pitch, then to hold your part in a hymn. Each lesson is a short tip and a
            few exercises sung with the microphone; pass them all to open the next lesson. Use headphones.</p>
        ${suggested !== undefined ? `<p class="learn-suggest">Your range check suggested <strong>${PARTS[suggested]}</strong>
            (${noteName(s.range.lo)} to ${noteName(s.range.hi)}).</p>` : ""}
        ${TRACKS.map((t) => {
            const done = passedCount(s, t);
            return `<details class="track card" data-track="${t.id}"${t.id === shown ? " open" : ""}>
                <summary>
                    <span class="track-name">${t.name}${t.part !== undefined && t.part === suggested ? ' <span class="badge">Suggested</span>' : ""}</span>
                    <span class="track-count">${done} of ${t.lessons.length}</span>
                </summary>
                <p class="track-blurb">${t.blurb}</p>
                <ol class="lesson-list">${t.lessons.map((l, i) => {
                    const passed = lessonPassed(s, t, i), open = lessonOpen(s, t, i);
                    const state = passed ? "passed" : open ? "open" : "locked";
                    return `<li class="is-${state}"><a href="#/learn/${t.id}/${i + 1}" data-lesson="${t.id}:${i}" data-locked="${!open}">
                        <span class="lesson-icon" aria-label="${state}">${ICON[state]}</span>
                        <span class="lesson-n">${i + 1}</span>
                        <span class="lesson-title">${ctx.esc(l.title)}</span>
                    </a></li>`;
                }).join("")}</ol>
            </details>`;
        }).join("")}`;
    host.querySelectorAll("details.track").forEach((d) =>
        d.addEventListener("toggle", () => {
            if (!d.open) return;
            const st = loadState();
            st.track = d.dataset.track;
            saveState(st);
        })
    );
    host.querySelectorAll('[data-locked="true"]').forEach((a) =>
        a.addEventListener("click", (e) => {
            const [tid, i] = a.dataset.lesson.split(":");
            if (!confirm("This lesson opens when you pass the one before it. Skip ahead to it anyway?")) return e.preventDefault();
            const st = loadState();
            st.open[`${tid}.${i}`] = true;
            saveState(st);
        })
    );
}

// ---- A lesson ----------------------------------------------------------------------

const describe = (ex) =>
    ex.kind === "echo" ? (ex.along ? "Sing each note with it while it plays." : "Listen to each pattern, then sing it back.")
    : ex.kind === "range" ? "Sing as low, then as high, as is comfortable. The app suggests your part."
    : ex.kind === "tune" ? (ex.voices.length < 2 ? "Sing the tune with it playing."
        : ex.mute?.length ? "Your line is lit on the music and plays alone; the other line is shown but silent."
        : "Your line is lit on the music; the other line plays with you.")
    : `${ex.verses === "all" ? "Every verse" : "Verse 1"} · ${SUPPORT[ex.support].name}: ${SUPPORT[ex.support].say.toLowerCase()}.`;

/** The lesson screen into `ctx.app`. Returns a cleanup for leaving the page. */
export async function showLesson(ctx, trackId, n) {
    const t = trackById(trackId), lesson = t?.lessons[n - 1];
    if (!lesson) {
        ctx.app.innerHTML = `<p class="message">That lesson isn't here. <a href="#/learn">Back to Learn</a></p>`;
        return () => {};
    }
    const hymns = await ctx.hymnsPromise;
    const hymnOf = (ex) => hymns.find((h) => h.id === ex.hymn);
    const st = loadState();
    const titleOf = (ex) => ex.title ?? hymnOf(ex)?.title ?? "Hymn";
    ctx.setTitle(`${t.name} ${n}: ${lesson.title}`);
    const nextOpen = n < t.lessons.length && lessonOpen(st, t, n);
    ctx.app.innerHTML = `
        <section class="lesson">
            <p class="lesson-crumb"><a href="#/learn">Learn</a> · ${t.name} · Lesson ${n} of ${t.lessons.length}</p>
            <h2>${ctx.esc(lesson.title)}</h2>
            <div class="card lesson-tip"><p>${ctx.esc(lesson.tip)}</p>
                <p class="learn-sub">Pass: ${lesson.target}% on pitch in each exercise, singing at least
                ${Math.round(MIN_COVERAGE * 100)}% of the notes.</p></div>
            ${lesson.exercises.map((ex, e) => {
                const h = ex.kind === "hymn" ? hymnOf(ex) : null;
                return `<div class="card exercise" data-ex="${e}">
                    <div class="exercise-head">
                        <div>
                            <h3>${e + 1}. ${ctx.esc(titleOf(ex))}${h?.tune ? ` <span class="sub">${ctx.esc(h.tune)}</span>` : ""}</h3>
                            <p class="learn-sub">${ex.kind === "hymn" ? `${PARTS[ex.part]} · ` : ""}${describe(ex)}</p>
                        </div>
                        <span class="exercise-best" data-best></span>
                    </div>
                    <div class="exercise-actions">
                        <button type="button" class="btn" data-start>Start</button>
                        ${ex.kind === "range" ? "" : `<label class="tempo-pick">Tempo
                            <select data-tempo>${[100, 90, 80, 70].map((v) => `<option value="${v}">${v}%</option>`).join("")}</select></label>`}
                    </div>
                    <div class="exercise-stage" hidden></div>
                    <div class="exercise-result" hidden></div>
                </div>`;
            }).join("")}
            <nav class="lesson-nav">
                ${n > 1 ? `<a href="#/learn/${t.id}/${n - 1}">← Lesson ${n - 1}</a>` : "<span></span>"}
                ${n < t.lessons.length ? `<a href="#/learn/${t.id}/${n + 1}" id="next-lesson"${nextOpen ? "" : ' data-locked="true"'}>Lesson ${n + 1} →</a>` : `<a href="#/learn">Back to Learn</a>`}
            </nav>
        </section>`;

    const paintBest = () => {
        const s = loadState();
        lesson.exercises.forEach((ex, e) => {
            const b = s.best[exKey(t.id, n - 1, e)];
            const el = ctx.app.querySelector(`[data-ex="${e}"] [data-best]`);
            el.innerHTML = b ? (b.passed ? `${ICON.passed}<span>${ex.kind === "range" ? "Done" : `${b.on}%`}</span>` : `<span>Best ${b.on}%</span>`) : "";
            el.className = `exercise-best${b?.passed ? " is-passed" : ""}`;
        });
    };
    paintBest();
    // Checked at the click: passing this lesson here opens the next one
    ctx.app.querySelector("#next-lesson")?.addEventListener("click", (e) => {
        if (n >= t.lessons.length || lessonOpen(loadState(), t, n)) return;
        if (!confirm("The next lesson opens when you pass this one. Skip ahead anyway?")) return e.preventDefault();
        const s = loadState();
        s.open[`${t.id}.${n}`] = true;
        saveState(s);
    });

    // One exercise runs at a time; the microphone stays on until leaving the lesson
    let learner = null, active = null;
    const getMic = async () => {
        if (learner) return learner;
        try {
            learner = await listen();
            return learner;
        } catch {
            ctx.toast("Learn needs the microphone. Allow it for this site and try again.", 3500);
            return null;
        }
    };
    const stopActive = () => {
        active?.stop();
        active = null;
    };

    ctx.app.querySelectorAll(".exercise").forEach((card) => {
        const e = +card.dataset.ex, ex = lesson.exercises[e];
        const btn = card.querySelector("[data-start]");
        btn.addEventListener("click", async () => {
            if (active?.card === card) return stopActive();
            stopActive();
            const mic = await getMic();
            if (!mic) return;
            btn.textContent = "Stop";
            const done = () => {
                btn.textContent = "Start again";
                if (active?.card === card) active = null;
                paintBest();
                const s = loadState();
                if (lessonPassed(s, t, n - 1)) {
                    const next = ctx.app.querySelector("#next-lesson");
                    next?.removeAttribute("data-locked");
                    if (!card.dataset.cheered) {
                        card.dataset.cheered = "1";
                        ctx.toast(n < t.lessons.length ? `Lesson passed! Lesson ${n + 1} is open.` : `You've finished the ${t.name} track!`, 3500);
                        ctx.track("learn_lesson_pass", { track: t.id, lesson: n });
                    }
                }
            };
            const run = ex.kind === "range"
                ? rangeCheck(card, mic, ctx, (r) => { record(t, n - 1, e, { on: 100, passed: true }); saveRange(r); done(); })
                : await exerciseRun(card, ex, mic, ctx, hymnOf(ex), lesson.target, (result) => {
                    if (result) record(t, n - 1, e, result);
                    done();
                });
            if (!run) {
                btn.textContent = "Start";
                return;
            }
            active = { card, stop: () => { run.stop(); btn.textContent = "Start"; } };
        });
    });

    return () => {
        stopActive();
        learner?.stop();
        learner = null;
    };
}

/** Keeps an exercise's best score (and whether it was ever passed). */
function record(t, l, e, { on, passed }) {
    const s = loadState();
    const k = exKey(t.id, l, e), was = s.best[k];
    s.best[k] = { on: Math.max(on, was?.on ?? 0), passed: passed || !!was?.passed };
    saveState(s);
}

function saveRange(r) {
    const s = loadState();
    s.range = r;
    s.rangeAt = Date.now();
    saveState(s);
}

// ---- Running an exercise --------------------------------------------------------------

/** The MIDI/score for an exercise the app writes (echo or tune), and each channel's volume. */
function written(ex) {
    if (ex.kind === "echo") {
        const notes = [], chs = [];
        for (const p of ex.patterns) {
            const line = parseLine(p);
            if (!ex.along) {
                for (const note of line) { notes.push(note); chs.push(1); } // you hear it…
                notes.push({ rest: true, dur: 1 }); chs.push(1); // …a breath…
            }
            for (const note of line) { notes.push(note); chs.push(0); } // …then sing it back (or with it)
            notes.push({ rest: true, dur: 2 }); chs.push(0);
        }
        const built = buildExercise({ key: ex.key, bpm: ex.bpm, meter: null, voices: [{ ch: 0, chs, tonic: ex.tonic, clef: ex.clef, notes }] });
        return { built, learn: 0, volumes: ex.along ? { 0: 1 } : { 0: 0, 1: 1 } };
    }
    const voices = ex.voices.map((v) => {
        let notes = parseLine(TUNES[v.tune].notes);
        if (v.shift) notes = shiftLine(notes, v.shift);
        if (v.round) notes = [{ rest: true, dur: v.round }, ...notes];
        return { ch: v.ch, tonic: v.tonic, clef: v.clef, notes };
    });
    const built = buildExercise({ key: ex.key, bpm: ex.bpm, meter: ex.meter, voices });
    const volumes = {};
    for (const v of ex.voices) volumes[v.ch] = v.ch === ex.learn ? 1 : ex.mute?.includes(v.ch) ? 0 : 0.7;
    return { built, learn: ex.learn, volumes };
}

const SUPPORT_VOLUMES = {
    alone: (own) => [0, 1, 2, 3].map((c) => (c === own ? 1 : 0)),
    help: (own) => [0, 1, 2, 3].map((c) => (c === own ? 1 : 0.4)),
    even: () => [0.85, 0.85, 0.85, 0.85],
    own: (own) => [0, 1, 2, 3].map((c) => (c === own ? 0 : 1)),
};

/** Plays exercise `ex` in `card` and scores the singing; `onDone(result | null)` when it ends by itself. */
async function exerciseRun(card, ex, mic, ctx, hymn, target, onDone) {
    const stage = card.querySelector(".exercise-stage"), resultEl = card.querySelector(".exercise-result");
    stage.hidden = false;
    resultEl.hidden = true;
    stage.innerHTML = `<div class="stage-bar"><span class="learn-readout" data-readout role="img"></span>
        <span class="stage-status" data-status>Loading…</span></div><div class="score-notation" data-score></div>`;
    const status = stage.querySelector("[data-status]"), readout = stage.querySelector("[data-readout]");
    let url, source, learnCh, volumes, words = false, verses = false, blobUrl = null;
    if (ex.kind === "hymn") {
        if (!hymn?.midi || !hymn.score) {
            status.textContent = "This hymn's music isn't available.";
            return null;
        }
        url = ctx.midiUrl(hymn);
        source = ctx.scoreUrl(hymn);
        learnCh = ex.part;
        volumes = SUPPORT_VOLUMES[ex.support](ex.part);
        words = hymn.scoreWords;
        verses = hymn.scoreVerses;
    } else {
        const w = written(ex);
        blobUrl = url = URL.createObjectURL(new Blob([w.built.midi], { type: "audio/midi" }));
        source = { abc: w.built.abc, map: w.built.map };
        learnCh = w.learn;
        volumes = [0, 1, 2, 3].map((c) => w.volumes[c] ?? 0);
    }
    let stopped = false, frame = 0;
    const cleanup = () => {
        stopped = true;
        cancelAnimationFrame(frame);
        player.pause();
        if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
    const handle = { stop: () => { cleanup(); status.textContent = "Stopped. Start again when you're ready."; } };
    try {
        const [loaded, score] = await Promise.all([
            player.load(url),
            loadScore(stage.querySelector("[data-score]"), source, { words, verses, view: "scroll" }),
        ]);
        if (!loaded || stopped) return handle;
        handle.score = score;
        volumes.forEach((v, c) => player.setVoiceVolume(c, v));
        player.setTranspose(0);
        player.setTempo((+card.querySelector("[data-tempo]")?.value || 100) / 100);
        // The stretch that's scored: verse 1 (or every verse) of a hymn, all of an exercise the app wrote
        const starts = score.verseStarts;
        const from = ex.kind === "hymn" ? starts[0] ?? 0 : 0;
        const to = ex.kind === "hymn" && ex.verses === "1" ? starts[1] ?? player.duration() : player.duration();
        const notes = score.partNotes(learnCh).filter((nt) => nt[1] >= from - 0.01 && nt[1] < to);
        const listenNotes = ex.kind === "echo" ? score.partNotes(1) : [];
        const noteTime = notes.reduce((sum, nt) => sum + Math.min(nt[2], to - nt[1]), 0);
        const on = [0, 1, 2, 3].map((c) => volumes[c] > 0 || c === learnCh);
        // The whole introduction first, to hear the key and the tune
        player.seek(0);
        await player.play();
        const run = tally();
        let shown = null;
        const tick = () => {
            if (stopped) return;
            const now = player.position();
            score.paint(now, on, true);
            let cents = null;
            if (now >= from && now < to) {
                cents = score.trace(now - LAG, learnCh, mic.read(), 0);
                // A note's let-off start counts as sung, but not as on or off pitch
                if (score.settling) run.settle(now - LAG), cents = null;
                else run.add(now - LAG, cents === null ? null : score.grade(cents), cents);
            }
            const grade = cents === null ? "idle" : score.grade(cents);
            const key = grade === "learn-good" || grade === "idle" ? grade : `${grade}${cents > 0 ? "d" : "u"}`;
            if (key !== shown) {
                shown = key;
                readout.className = `learn-readout ${grade}`;
                readout.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${
                    grade === "idle" ? '<circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2"/>'
                    : grade === "learn-good" ? '<circle cx="12" cy="12" r="9"/>'
                    : cents > 0 ? '<path d="M12 21l-8-10h5V3h6v8h5z"/>' : '<path d="M12 3l8 10h-5v8H9v-8H4z"/>'}</svg>`;
                readout.setAttribute("aria-label", grade === "idle" ? "Listening" : grade === "learn-good" ? "On pitch" : cents > 0 ? "Sharp: sing lower" : "Flat: sing higher");
            }
            status.textContent = now < from ? "Get ready…"
                : ex.kind === "echo" && !ex.along ? (listening(listenNotes, notes, now) ? "Listen…" : "Your turn")
                : "Sing!";
            if (now >= to - 0.02 || !player.isPlaying()) return finish();
            frame = requestAnimationFrame(tick);
        };
        const finish = () => {
            cleanup();
            score.clearTrace();
            const sung = run.seconds(), coverage = noteTime ? sung / noteTime : 0;
            const sh = shares(run.sums);
            const enough = coverage >= MIN_COVERAGE;
            const passed = enough && sh.on >= target;
            if (ex.kind === "hymn" && sung >= MIN_SECONDS) {
                const r = (v) => Math.round(v * 10) / 10;
                addRun({ hymn: hymn.id, title: hymn.title, part: ex.part, at: Date.now(), on: r(run.sums.on), flat: r(run.sums.flat), sharp: r(run.sums.sharp) });
            }
            status.textContent = "";
            stage.hidden = true;
            resultEl.hidden = false;
            resultEl.innerHTML = !enough
                ? `<p class="result-line">We heard you on ${Math.round(coverage * 100)}% of the notes. Sing all the way
                    through (at least ${Math.round(MIN_COVERAGE * 100)}%) to get a score.</p>`
                : `<p class="result-line ${passed ? "is-passed" : ""}">${passed ? `${ICON.passed} Passed: ` : ""}<strong>${sh.on}% on pitch</strong>
                    ${passed ? "" : ` · target ${target}%. Try again; a slower tempo can help.`}</p>
                   ${splitBar(run.sums)}`;
            ctx.track("learn_exercise", { kind: ex.kind, on_pitch: sh.on, passed });
            onDone(enough ? { on: sh.on, passed } : null);
        };
        frame = requestAnimationFrame(tick);
        return handle;
    } catch (err) {
        cleanup();
        status.textContent = `Couldn't load this exercise (${err.message}).`;
        return handle;
    }
}

/** Whether it's time to listen: a pattern is playing, or the next one to come is to listen to.
 *  "Your turn" shows as soon as the pattern ends, so the singer is ready to come in. */
function listening(listen, sing, now) {
    const sounding = (list) => list.some((nt) => nt[1] <= now && now < nt[1] + nt[2]);
    const next = (list) => list.reduce((t, nt) => (nt[1] > now && nt[1] < t ? nt[1] : t), Infinity);
    if (sounding(listen)) return true;
    if (sounding(sing)) return false;
    return next(listen) < next(sing);
}

// ---- Range check ---------------------------------------------------------------------

/** The part each voice suits: where most of its notes lie (from the app's hymns). */
const CORE = [[62, 74], [57, 67], [50, 62], [43, 55]];

/** Lowest, then highest, comfortable note; suggests a part. `onDone({ lo, hi, part })`. */
function rangeCheck(card, mic, ctx, onDone) {
    const stage = card.querySelector(".exercise-stage"), resultEl = card.querySelector(".exercise-result");
    stage.hidden = false;
    resultEl.hidden = true;
    let frame = 0, stopped = false, phase = "low", lo = null, hi = null, recent = [];
    stage.innerHTML = `<div class="range-check">
        <p data-say></p>
        <p class="range-now"><span data-now>…</span></p>
        <div class="exercise-actions"><button type="button" class="btn" data-next>Done with low notes</button>
            <button type="button" class="link-btn" data-tone>Play a starting note</button></div>
    </div>`;
    const say = stage.querySelector("[data-say]"), nowEl = stage.querySelector("[data-now]"), next = stage.querySelector("[data-next]");
    const tell = () => {
        say.textContent = phase === "low"
            ? "Start on a comfortable note, then sing down step by step (“loo”) as low as you comfortably can. Hold each note for a moment."
            : "Now start comfortably and sing up step by step as high as you comfortably can, without straining.";
        next.textContent = phase === "low" ? "Done with low notes" : "Done with high notes";
    };
    tell();
    stage.querySelector("[data-tone]").addEventListener("click", async () => {
        const { midi } = buildExercise({ key: "C", bpm: 60, meter: null, voices: [{ ch: 0, tonic: 57, clef: "treble", notes: parseLine("0:4") }] });
        const url = URL.createObjectURL(new Blob([midi], { type: "audio/midi" }));
        if (await player.load(url)) {
            [0, 1, 2, 3].forEach((c) => player.setVoiceVolume(c, c === 0 ? 1 : 0));
            player.setTranspose(0);
            await player.play();
        }
        setTimeout(() => URL.revokeObjectURL(url), 5000);
    });
    const tick = () => {
        if (stopped) return;
        const p = mic.read(), t = performance.now();
        if (p !== null) recent.push([t, p]);
        recent = recent.filter(([at]) => t - at < 700);
        // A note held steady (within half a semitone) for most of 0.7 s counts
        if (recent.length >= 20) {
            const ps = recent.map(([, v]) => v), spread = Math.max(...ps) - Math.min(...ps);
            if (spread < 0.5) {
                const held = ps.sort((a, b) => a - b)[ps.length >> 1];
                if (phase === "low") lo = lo === null ? held : Math.min(lo, held);
                else hi = hi === null ? held : Math.max(hi, held);
            }
        }
        const mark = phase === "low" ? lo : hi;
        nowEl.textContent = `${p === null ? "…" : `Hearing ${noteName(p)}`}${mark === null ? "" : ` · ${phase === "low" ? "lowest" : "highest"} held: ${noteName(mark)}`}`;
        frame = requestAnimationFrame(tick);
    };
    next.addEventListener("click", () => {
        if (phase === "low") {
            if (lo === null) return ctx.toast("Hold a low note steady for a moment so the app can hear it.");
            phase = "high";
            recent = [];
            return tell();
        }
        if (hi === null || hi <= lo) return ctx.toast("Hold a high note steady for a moment so the app can hear it.");
        stopped = true;
        cancelAnimationFrame(frame);
        const fit = CORE.map(([a, b]) => Math.max(0, Math.min(b, hi) - Math.max(a, lo)) / (b - a));
        const mid = (lo + hi) / 2;
        let part = 0;
        fit.forEach((f, i) => {
            const better = f > fit[part] + 0.01 || (Math.abs(f - fit[part]) <= 0.01 && Math.abs(mid - (CORE[i][0] + CORE[i][1]) / 2) < Math.abs(mid - (CORE[part][0] + CORE[part][1]) / 2));
            if (better) part = i;
        });
        stage.hidden = true;
        resultEl.hidden = false;
        resultEl.innerHTML = `<p class="result-line">${ICON.passed} Your comfortable range: <strong>${noteName(lo)} to ${noteName(hi)}</strong>.
            That suits <strong>${PARTS[part]}</strong>.</p>
            <p class="learn-sub">Soprano and alto are usually women's and children's voices, tenor and bass men's. You can
            learn any part: <a href="#/learn">see all the tracks</a>.</p>`;
        ctx.track("learn_range", { part: PARTS[part] });
        onDone({ lo: Math.round(lo), hi: Math.round(hi), part });
    });
    frame = requestAnimationFrame(tick);
    return { stop: () => { stopped = true; cancelAnimationFrame(frame); stage.hidden = true; } };
}

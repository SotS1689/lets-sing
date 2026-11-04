// Learn mode scores: how much of a run was on pitch, flat or sharp, saved on
// this device so singers can see how they're doing on each hymn and overall.
// Signed in (src/sync.js), they're also kept in the singer's account.
import { changed, cleared } from "./sync.js";

const KEY = "learnRuns";
/** Oldest runs are dropped past this many (a few years of daily practice). */
const MAX_RUNS = 2000;
/** A run with less singing than this (seconds heard on a note) isn't saved. */
export const MIN_SECONDS = 8;

export const PARTS = ["Soprano", "Alto", "Tenor", "Bass"];

/** Every saved run, oldest first: { hymn, title, part, at, on, flat, sharp } with
 *  on/flat/sharp in seconds of singing. */
export function loadRuns() {
    try {
        const runs = JSON.parse(localStorage.getItem(KEY));
        return Array.isArray(runs) ? runs : [];
    } catch {
        return [];
    }
}

/** A run's name, the same on every device: when it was sung, the hymn and the part. */
export const runId = (run) => `${run.at.toString(36)}-${String(run.hymn).replace(/[^\w-]/g, "")}-${run.part}`;

/** Saves `runs` (oldest first) as this device's whole history. */
export function replaceRuns(runs) {
    try { localStorage.setItem(KEY, JSON.stringify(runs.slice(-MAX_RUNS))); } catch { /* private mode / full */ }
}

export function addRun(run) {
    const runs = loadRuns();
    runs.push(run);
    replaceRuns(runs);
    changed();
}

export function clearRuns() {
    try { localStorage.removeItem(KEY); } catch { /* nothing to clear */ }
    cleared();
}

/** Whole-number shares of a run: { on, flat, sharp } adding up to 100. */
export function shares(run) {
    const total = run.on + run.flat + run.sharp || 1;
    const on = Math.round((run.on / total) * 100), flat = Math.round((run.flat / total) * 100);
    return { on, flat, sharp: Math.max(0, 100 - on - flat) };
}

/**
 * Adds up a run as it's sung. Each reading counts for the playback time since
 * the one before (so a slow phone's fewer readings weigh the same), into on
 * pitch, flat or sharp; silence and rests count for nothing.
 */
export function tally() {
    let last = null;
    const sums = { on: 0, flat: 0, sharp: 0 };
    let settled = 0;
    return {
        sums,
        /** `now` the playback position, `grade` "learn-good" etc. or null, `cents` how far off. */
        add(now, grade, cents) {
            const dt = last === null ? 0 : now - last;
            last = now;
            // A seek or a stall isn't singing time
            if (grade === null || dt <= 0 || dt > 0.25) return;
            if (grade === "learn-good") sums.on += dt;
            else if (cents < 0) sums.flat += dt;
            else sums.sharp += dt;
        },
        /** Singing in a note's let-off start: counts as time sung, not as on or off pitch. */
        settle(now) {
            const dt = last === null ? 0 : now - last;
            last = now;
            if (dt > 0 && dt <= 0.25) settled += dt;
        },
        /** Playback paused: the gap until it resumes isn't singing time. */
        pause() { last = null; },
        seconds: () => sums.on + sums.flat + sums.sharp + settled,
    };
}

// ---- Drawing ------------------------------------------------------------------

const pct = (n) => `${n}%`;

/** The run split into flat | on pitch | sharp, with each share named in text below. */
export function splitBar(run) {
    const s = shares(run);
    const seg = (key, n) => (n > 0 ? `<span class="split-${key}" style="flex-grow:${n}"></span>` : "");
    return `<div class="split-bar" role="img" aria-label="${s.on}% on pitch, ${s.flat}% flat, ${s.sharp}% sharp">
            ${seg("flat", s.flat)}${seg("on", s.on)}${seg("sharp", s.sharp)}
        </div>
        <div class="split-key">
            <span><i class="split-flat"></i>${pct(s.flat)} flat</span>
            <span><i class="split-on"></i>${pct(s.on)} on pitch</span>
            <span><i class="split-sharp"></i>${pct(s.sharp)} sharp</span>
        </div>`;
}

/**
 * A line of on-pitch % across `runs` (oldest first) into `host`, 0-100%, with a
 * tooltip under the pointer naming the run. `label(run)` says what each run was.
 */
export function onPitchChart(host, runs, label = (r) => new Date(r.at).toLocaleDateString()) {
    const W = Math.max(260, host.clientWidth || 300), H = 150;
    const pad = { l: 34, r: 10, t: 10, b: 20 };
    const x = (i) => pad.l + (runs.length < 2 ? (W - pad.l - pad.r) / 2 : (i * (W - pad.l - pad.r)) / (runs.length - 1));
    const y = (v) => pad.t + ((100 - v) * (H - pad.t - pad.b)) / 100;
    const values = runs.map((r) => shares(r).on);
    const line = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
    const grid = [0, 50, 100]
        .map((v) => `<line class="chart-grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/>
                     <text class="chart-axis" x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}%</text>`)
        .join("");
    const lastI = values.length - 1;
    host.innerHTML = `<div class="chart-wrap">
        <svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img"
             aria-label="On pitch, run by run: from ${values[0]}% to ${values[lastI]}%">
            ${grid}
            <text class="chart-axis" x="${pad.l}" y="${H - 4}">${runs.length > 1 ? "first run" : ""}</text>
            <text class="chart-axis" x="${W - pad.r}" y="${H - 4}" text-anchor="end">latest</text>
            <path class="chart-line" d="${line}"/>
            <circle class="chart-dot" cx="${x(lastI)}" cy="${y(values[lastI])}" r="4"/>
            <line class="chart-cross" y1="${pad.t}" y2="${H - pad.b}" visibility="hidden"/>
            <circle class="chart-dot chart-hover" r="5" visibility="hidden"/>
        </svg>
        <div class="chart-tip" hidden></div>
    </div>`;
    const svg = host.querySelector("svg"), tip = host.querySelector(".chart-tip");
    const cross = svg.querySelector(".chart-cross"), dot = svg.querySelector(".chart-hover");
    const show = (e) => {
        const box = svg.getBoundingClientRect();
        const px = ((e.clientX - box.left) / box.width) * W;
        let i = 0;
        for (let k = 1; k < runs.length; k++) if (Math.abs(x(k) - px) < Math.abs(x(i) - px)) i = k;
        cross.setAttribute("x1", x(i));
        cross.setAttribute("x2", x(i));
        dot.setAttribute("cx", x(i));
        dot.setAttribute("cy", y(values[i]));
        cross.setAttribute("visibility", "visible");
        dot.setAttribute("visibility", "visible");
        const s = shares(runs[i]);
        tip.innerHTML = `<strong>${s.on}% on pitch</strong><br>${s.flat}% flat · ${s.sharp}% sharp<br><span>${label(runs[i])}</span>`;
        tip.hidden = false;
        const left = (x(i) / W) * box.width;
        tip.style.left = `${Math.min(Math.max(left, 70), box.width - 70)}px`;
    };
    const hide = () => {
        tip.hidden = true;
        cross.setAttribute("visibility", "hidden");
        dot.setAttribute("visibility", "hidden");
    };
    svg.addEventListener("pointermove", show);
    svg.addEventListener("pointerdown", show);
    svg.addEventListener("pointerleave", hide);
}

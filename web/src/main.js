// Let's Sing -- web app. Two screens, like the Android app: the hymn list
// (#/) and the player (#/hymn/<id>). Hash routes keep it working from any
// static host folder with no server-side setup.
import * as player from "./player.js";
import { VOICES, INSTRUMENTS } from "./player.js";

const app = document.getElementById("app");
const backBtn = document.getElementById("back");
const pageTitle = document.getElementById("page-title");

// ---- Settings ---------------------------------------------------------------
// Theme and instrument are remembered on this device; mix/tempo/pitch carry
// across hymns for the session, as in the Android app.

const store = {
    get(key, fallback) {
        try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
    },
    set(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
    },
};

const mix = {
    volumes: [100, 100, 100, 100], // percent, per SATB voice
    on: [true, true, true, true], // part switched on/off (keeps its volume setting)
    tempo: 100, // percent of the hymn's own pace, 50..150
    pitch: 0, // semitones, -6..6
};

const instrumentById = (id) => INSTRUMENTS.find((i) => i.id === id) ?? INSTRUMENTS[0];
let instrument = instrumentById(store.get("instrument", "piano"));
player.setInstrument(instrument.program);

const applyVoice = (i) => player.setVoiceVolume(i, mix.on[i] ? mix.volumes[i] / 100 : 0);

const THEMES = ["system", "light", "dark"];
function applyTheme(theme) {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
}
applyTheme(store.get("theme", "system"));
document.getElementById("theme-toggle").addEventListener("click", () => {
    const next = THEMES[(THEMES.indexOf(store.get("theme", "system")) + 1) % THEMES.length];
    store.set("theme", next);
    applyTheme(next);
    toast(`Theme: ${next}`);
});

// ---- Helpers ----------------------------------------------------------------

const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const fmtTime = (s) => {
    s = Math.max(0, Math.floor(s));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const fmtPitch = (n) => (n > 0 ? `+${n}` : String(n));

const norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Shows a short message; ms = 0 keeps it up until the caller removes it. */
function toast(message, ms = 1800) {
    const el = document.createElement("div");
    el.className = "toast";
    el.setAttribute("role", "status");
    el.textContent = message;
    document.body.append(el);
    if (ms) setTimeout(() => el.remove(), ms);
    return el;
}

// ---- Data -------------------------------------------------------------------

const hymnsPromise = fetch("./hymns.json").then((r) => r.json());

// The ?v= content version lets offline copies of unchanged hymns survive app
// updates (see sw-template.js)
const midiUrl = (h) => `./midi/${encodeURIComponent(h.midi)}?v=${h.midiVersion}`;
let searchText = "";
let listScroll = 0;

// ---- List screen ------------------------------------------------------------

async function showList() {
    stopPlayer();
    backBtn.hidden = true;
    pageTitle.textContent = "Let's Sing";
    document.title = "Let's Sing";
    const hymns = await hymnsPromise;
    hymns.forEach((h) => (h._search ??= norm(`${h.title} ${h.tune} ${h.composer}`)));

    app.innerHTML = `
        <div class="search">
            <input id="search" type="search" placeholder="Search title, tune, or composer"
                   autocomplete="off" aria-label="Search hymns" value="${esc(searchText)}">
        </div>
        <p class="count" id="count"></p>
        <ul class="hymn-list" id="list"></ul>`;

    const list = document.getElementById("list");
    const count = document.getElementById("count");
    const render = () => {
        const terms = norm(searchText).split(/\s+/).filter(Boolean);
        const shown = hymns.filter((h) => terms.every((t) => h._search.includes(t)));
        count.textContent = terms.length ? `${shown.length} of ${hymns.length} hymns` : `${hymns.length} hymns`;
        list.innerHTML = shown
            .map(
                (h) => `<li><a href="#/hymn/${h.id}">
                    <span class="title">${esc(h.title)}</span>
                    <span class="sub">${esc([h.tune, h.composer].filter(Boolean).join(" · "))}</span>
                </a></li>`
            )
            .join("");
    };
    render();
    const search = document.getElementById("search");
    search.addEventListener("input", () => {
        searchText = search.value;
        render();
    });
    window.scrollTo(0, listScroll);
}

// ---- Download all for offline (top bar arrow) --------------------------------
// Fetching a file through the service worker stores it in its cache. Whether
// everything is downloaded is checked against that cache itself, so the arrow
// stays truthful after an update replaces the cache.

const downloadBtn = document.getElementById("download");
const DOWNLOAD_ICONS = {
    todo: "M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z",
    done: "M5 20h14v-2H5v2zm4.6-5.6L5.4 10.2 6.8 8.8l2.8 2.8 7.6-7.6 1.4 1.4-9 9z",
};
const DOWNLOAD_LABELS = {
    todo: "Download all hymns for offline use",
    busy: "Downloading hymns…",
    done: "All hymns downloaded for offline use",
};

function setDownloadState(state) {
    downloadBtn.dataset.state = state;
    downloadBtn.setAttribute("aria-label", DOWNLOAD_LABELS[state]);
    downloadBtn.title = DOWNLOAD_LABELS[state];
    if (state !== "busy") downloadBtn.querySelector("path").setAttribute("d", DOWNLOAD_ICONS[state]);
}

async function offlineFiles() {
    const hymns = await hymnsPromise;
    return [...new Set(hymns.filter((h) => h.midi).map(midiUrl))].concat("./soundfont/instruments.sf2");
}

async function missingFiles() {
    const missing = [];
    for (const url of await offlineFiles()) {
        if (!(await caches.match(url, { ignoreVary: true }))) missing.push(url);
    }
    return missing;
}

// Drops saved copies of hymns no current hymn uses (an older version of a
// changed MIDI file, or a removed hymn), so the saved store doesn't grow.
async function pruneOldHymns() {
    const current = new Set((await offlineFiles()).map((u) => new URL(u, location.href).href));
    const cache = await caches.open("lets-sing-content");
    for (const req of await cache.keys()) {
        if (!current.has(req.url)) await cache.delete(req);
    }
}

// Asks the browser not to clear the saved hymns when the device runs low on
// space. Chrome decides by itself (installed apps are normally granted) and
// shows no prompt; when it's refused, everything still works, just unprotected.
function protectStorage() {
    navigator.storage?.persist?.().catch(() => {});
}

async function downloadAll() {
    if (!navigator.onLine) return toast("Connect to the internet to download the hymns.", 3000);
    protectStorage();
    setDownloadState("busy");
    const files = await missingFiles();
    const total = files.length;
    const progress = toast("Downloading hymns…", 0);
    let done = 0;
    const next = async () => {
        while (files.length) {
            try { await fetch(files.pop()); } catch { /* counted by the re-check below */ }
            progress.textContent = `Downloading hymns… ${++done} of ${total}`;
        }
    };
    await Promise.all(Array.from({ length: 6 }, next));
    progress.remove();
    const failed = (await missingFiles()).length;
    setDownloadState(failed ? "todo" : "done");
    toast(failed
        ? `${failed} files didn't download. Check your connection and tap the arrow again.`
        : "All hymns downloaded. The app now works offline.", 3500);
}

downloadBtn.addEventListener("click", () => {
    const state = downloadBtn.dataset.state;
    if (state === "busy") return;
    if (state === "done") return toast("All hymns are downloaded. The app works offline.", 2500);
    downloadAll();
});

// Only offered once the service worker (production builds) is in control;
// on a first visit it takes over a moment after the page loads.
async function showDownloadButton() {
    downloadBtn.hidden = false;
    protectStorage();
    await pruneOldHymns();
    setDownloadState((await missingFiles()).length ? "todo" : "done");
}
if (navigator.serviceWorker?.controller) showDownloadButton();
else navigator.serviceWorker?.addEventListener("controllerchange", showDownloadButton, { once: true });

// ---- Player screen ----------------------------------------------------------

let frame = 0;
let wakeLock = null;

function stopPlayer() {
    cancelAnimationFrame(frame);
    player.stop();
    releaseWakeLock();
}

async function keepScreenOn() {
    try { wakeLock ??= await navigator.wakeLock?.request("screen"); } catch { /* not allowed now */ }
}
function releaseWakeLock() {
    wakeLock?.release().catch(() => {});
    wakeLock = null;
}

async function showHymn(id) {
    const hymns = await hymnsPromise;
    const hymn = hymns.find((h) => h.id === id);
    stopPlayer();
    backBtn.hidden = false;
    if (!hymn) {
        pageTitle.textContent = "Not found";
        app.innerHTML = `<p class="message">That hymn isn't in the list. <a href="#/">Back to all hymns</a></p>`;
        return;
    }
    pageTitle.textContent = hymn.title;
    document.title = `${hymn.title} · Let's Sing`;

    app.innerHTML = `
        <section class="hymn-head">
            <h2>${esc(hymn.title)}</h2>
            ${hymn.tune ? `<p class="tune">${esc(hymn.tune)}</p>` : ""}
            ${hymn.composer ? `<p class="sub">Composer: ${esc(hymn.composer)}</p>` : ""}
        </section>

        <section class="card controls" aria-label="Player">
            <div class="transport">
                <button class="mini-btn primary" id="play" aria-label="Play" disabled>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path id="play-icon" d="M8 5v14l11-7z"/></svg>
                </button>
                <button class="mini-btn" id="stop" aria-label="Stop" disabled>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6h12v12H6z"/></svg>
                </button>
                <input type="range" id="seek" min="0" max="1" step="0.01" value="0" aria-label="Position" disabled>
                <span class="times"><span id="pos">0:00</span> / <span id="dur">–:––</span></span>
            </div>
            <p class="status" id="status">Loading music…</p>

            <div class="parts" title="Tap a letter to turn that part on or off">
                ${VOICES.map(
                    (v, i) => `<div class="part${mix.on[i] ? "" : " is-off"}" id="voice-${i}">
                        <button class="part-toggle" data-toggle="${i}" aria-pressed="${mix.on[i]}"
                                aria-label="${v}" title="${v}">${v[0]}</button>
                        <input type="range" min="0" max="100" step="1" value="${mix.volumes[i]}"
                               data-voice="${i}" aria-label="${v} volume">
                    </div>`
                ).join("")}
            </div>

            <div class="settings">
                <select id="instrument" aria-label="Instrument">
                    ${INSTRUMENTS.map(
                        (ins) => `<option value="${ins.id}"${ins.id === instrument.id ? " selected" : ""}>${ins.name}</option>`
                    ).join("")}
                </select>
                <div class="stepper" role="group" aria-label="Tempo">
                    <button data-step="tempo" data-delta="-5" aria-label="Slower">−</button>
                    <span class="stepper-value"><span class="stepper-label">Tempo</span><output id="tempo-val">${mix.tempo}%</output></span>
                    <button data-step="tempo" data-delta="5" aria-label="Faster">+</button>
                </div>
                <div class="stepper" role="group" aria-label="Pitch">
                    <button data-step="pitch" data-delta="-1" aria-label="Lower">−</button>
                    <span class="stepper-value"><span class="stepper-label">Pitch</span><output id="pitch-val">${fmtPitch(mix.pitch)}</output></span>
                    <button data-step="pitch" data-delta="1" aria-label="Higher">+</button>
                </div>
            </div>
        </section>

        <section class="lyrics">
            <h3>Lyrics</h3>
            ${hymn.verses.map((v) => `<p>${esc(v)}</p>`).join("")}
            ${hymn.credits ? `<p class="credits">${esc(hymn.credits)}</p>` : ""}
        </section>`;

    const $ = (sel) => app.querySelector(sel);
    const seekEl = $("#seek"), playBtn = $("#play"), stopBtn = $("#stop");
    const posEl = $("#pos"), durEl = $("#dur"), statusEl = $("#status"), playIcon = $("#play-icon");
    let dragging = false;

    const setPlayingUi = (playing) => {
        playIcon.setAttribute("d", playing ? "M6 5h4v14H6zm8 0h4v14h-4z" : "M8 5v14l11-7z");
        playBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
        if (playing) keepScreenOn(); else releaseWakeLock();
    };
    const tick = () => {
        if (!dragging) {
            seekEl.value = player.position();
            posEl.textContent = fmtTime(player.position());
        }
        if (player.isPlaying()) frame = requestAnimationFrame(tick);
        else setPlayingUi(false);
    };

    $("#play").addEventListener("click", async () => {
        if (player.isPlaying()) {
            player.pause();
            setPlayingUi(false);
        } else {
            if (player.position() >= player.duration() - 0.05) player.seek(0);
            await player.play();
            setPlayingUi(true);
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(tick);
        }
    });
    stopBtn.addEventListener("click", () => {
        player.stop();
        setPlayingUi(false);
        seekEl.value = 0;
        posEl.textContent = fmtTime(0);
    });
    seekEl.addEventListener("input", () => {
        dragging = true;
        posEl.textContent = fmtTime(+seekEl.value);
    });
    seekEl.addEventListener("change", () => {
        player.seek(+seekEl.value);
        dragging = false;
    });

    $("#instrument").addEventListener("change", (e) => {
        instrument = instrumentById(e.target.value);
        store.set("instrument", instrument.id);
        player.setInstrument(instrument.program);
    });
    app.querySelectorAll("[data-toggle]").forEach((el) =>
        el.addEventListener("click", () => {
            const i = +el.dataset.toggle;
            mix.on[i] = !mix.on[i];
            el.setAttribute("aria-pressed", mix.on[i]);
            $(`#voice-${i}`).classList.toggle("is-off", !mix.on[i]);
            applyVoice(i);
        })
    );
    app.querySelectorAll("[data-voice]").forEach((el) =>
        el.addEventListener("input", () => {
            const i = +el.dataset.voice;
            mix.volumes[i] = +el.value;
            // Moving the slider of a part that's off turns it back on
            if (!mix.on[i]) $(`[data-toggle="${i}"]`).click();
            applyVoice(i);
        })
    );

    const STEPS = {
        tempo: { min: 50, max: 150, show: (v) => `${v}%`, apply: (v) => player.setTempo(v / 100) },
        pitch: { min: -6, max: 6, show: fmtPitch, apply: (v) => player.setTranspose(v) },
    };
    const updateSteppers = () =>
        app.querySelectorAll("[data-step]").forEach((b) => {
            const s = STEPS[b.dataset.step], next = mix[b.dataset.step] + +b.dataset.delta;
            b.disabled = next < s.min || next > s.max;
        });
    app.querySelectorAll("[data-step]").forEach((b) =>
        b.addEventListener("click", () => {
            const key = b.dataset.step, s = STEPS[key];
            mix[key] = Math.min(s.max, Math.max(s.min, mix[key] + +b.dataset.delta));
            $(`#${key}-val`).textContent = s.show(mix[key]);
            s.apply(mix[key]);
            updateSteppers();
        })
    );
    updateSteppers();

    if (!hymn.midi) {
        statusEl.textContent = "No music file for this hymn yet.";
        return;
    }
    try {
        await player.load(midiUrl(hymn));
        if (location.hash !== `#/hymn/${id}`) return; // navigated away while loading
        VOICES.forEach((_, i) => applyVoice(i));
        player.setTempo(mix.tempo / 100);
        player.setTranspose(mix.pitch);
        seekEl.max = player.duration();
        durEl.textContent = fmtTime(player.duration());
        seekEl.disabled = playBtn.disabled = stopBtn.disabled = false;
        statusEl.textContent = "";
    } catch (err) {
        statusEl.textContent = navigator.onLine
            ? `Couldn't load the music: ${err.message}`
            : "You're offline and this hymn hasn't been downloaded yet.";
    }
}

// A hymn shouldn't keep singing after you leave the app (as on Android).
document.addEventListener("visibilitychange", () => {
    if (document.hidden && player.isPlaying()) player.pause();
});

// ---- Router -----------------------------------------------------------------

function route() {
    const m = location.hash.match(/^#\/hymn\/(\d+)/);
    if (m) showHymn(+m[1]);
    else showList();
}
window.addEventListener("hashchange", () => {
    if (!location.hash.startsWith("#/hymn/")) return route();
    listScroll = window.scrollY;
    route();
    window.scrollTo(0, 0);
});
backBtn.addEventListener("click", () => {
    if (history.length > 1) history.back();
    else location.hash = "#/";
});
route();

// ---- Offline support (production builds only) ---------------------------------

if (import.meta.env.PROD && "serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("service worker:", e));
}

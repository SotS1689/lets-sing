// Let's Sing -- web app. Two screens: the hymn list
// (#/) and the player (#/hymn/<id>). Hash routes keep it working from any
// static host folder with no server-side setup.
import * as player from "./player.js";
import { VOICES, INSTRUMENTS } from "./player.js";
import churchListsData from "./church-lists.json";
import { loadRuns, addRun, clearRuns, tally, shares, splitBar, onPitchChart, PARTS, MIN_SECONDS } from "./progress.js";
import { account, syncStatus, onSync, signIn, signOut, sync, favoritesChanged, listsChanged, tunesChanged } from "./sync.js";

const app = document.getElementById("app");
const backBtn = document.getElementById("back");
const pageTitle = document.getElementById("page-title");

// ---- Settings ---------------------------------------------------------------
// Theme and instrument are remembered on this device; mix/tempo/pitch carry
// across hymns for the session.

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

// Sheet music: the hymnal page, or one line that scrolls along with the music
const SCORE_VIEWS = [
    { id: "scroll", name: "Scroll", title: "One line of music that moves along as it plays" },
    { id: "page", name: "Page", title: "The whole score, as a hymnal prints it" },
];
// Learn mode: the part the singer is learning (0 S, 1 A, 2 T, 3 B)
let learnPart = [0, 1, 2, 3].includes(store.get("learnPart")) ? store.get("learnPart") : 0;
let scoreView = SCORE_VIEWS.some((v) => v.id === store.get("scoreView")) ? store.get("scoreView") : "scroll";
// Shape notes on the sheet music (src/shapes.js): "off", "4" (fa-sol-la-mi,
// as in the Sacred Harp) or "7" (do-re-mi, Aikin's seven shapes).
const SHAPE_NOTES = [
    { id: "off", name: "Off", title: "Ordinary round notes" },
    { id: "4", name: "4 shapes", title: "Fa, sol, la, mi, as in the Sacred Harp" },
    { id: "7", name: "7 shapes", title: "Do, re, mi, fa, sol, la, ti, each with its own shape" },
];
// Psalms only: the hymn list shows just the psalms (hymns with a `psalm`, from psalm_number)
let psalmsOnly = store.get("psalmsOnly", false) === true;
let shapeNotes = SHAPE_NOTES.some((v) => v.id === store.get("shapeNotes")) ? store.get("shapeNotes") : "off";

const applyVoice = (i) => player.setVoiceVolume(i, mix.on[i] ? mix.volumes[i] / 100 : 0);

const THEMES = ["system", "light", "dark"];
function applyTheme(theme) {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
}
// Shown inside another app's page (see the embed section below)
const EMBED = document.documentElement.classList.contains("embed");
// The church copy: built with --mode church (npm run build:church)
const CHURCH = import.meta.env.MODE === "church";
const embedParams = new URLSearchParams(location.search);
// An embedded player follows the host page's theme (?theme=light|dark) without saving it
applyTheme(EMBED && THEMES.includes(embedParams.get("theme")) ? embedParams.get("theme") : store.get("theme", "system"));
document.getElementById("theme-toggle").addEventListener("click", () => {
    const next = THEMES[(THEMES.indexOf(store.get("theme", "system")) + 1) % THEMES.length];
    store.set("theme", next);
    applyTheme(next);
    toast(`Theme: ${next}`);
    if (location.hash === "#/settings") showSettings();
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
// Sheet music (scripts/build-scores.mjs), versioned the same way; its note map
// is the .json beside it
const scoreUrl = (h) => `./scores/${encodeURIComponent(h.score)}?v=${h.scoreVersion}`;
const scoreMapUrl = (h) => scoreUrl(h).replace(/\.abc\?/, ".json?");
let searchText = "";
let listScroll = 0;
let listMode = "all";

// ---- Favorites ----------------------------------------------------------------
// Hymn ids, in the order they were added, remembered on this device (and in
// the singer's account when signed in, src/sync.js)

// ---- Tunes --------------------------------------------------------------------
// A hymn sung to more than one tune is in hymns.json once per tune, each copy with
// `tunes` (every copy's id, oldest first; scripts/prepare-content.mjs). The app shows
// it as one hymn: listed once, with a choice of tune on its page. The tune picked
// last is remembered per hymn (`tuneChoices`, and in the account, src/sync.js).
// Favorites and lists keep the tune a hymn was added with, and count it once
// whichever of its tunes they hold.

const tunesOf = (h) => h.tunes ?? [h.id];
const tuneKey = (h) => tunesOf(h)[0];
let tuneChoices = store.get("tuneChoices", {}); // { <first tune's id>: { id, at } }
/** The id of the tune `h` is sung to unless the singer picks another: their last pick, or the first. */
function chosenTune(h) {
    const id = tuneChoices[tuneKey(h)]?.id;
    return tunesOf(h).includes(id) ? id : tuneKey(h);
}
function chooseTune(h, id) {
    tuneChoices = { ...tuneChoices, [tuneKey(h)]: { id, at: Date.now() } };
    store.set("tuneChoices", tuneChoices);
    tunesChanged(tuneChoices);
    track("tune_pick");
}
/** Whether `ids` (favorites, a list) holds hymn `h`, to any of its tunes. */
const holds = (ids, h) => tunesOf(h).some((id) => ids.includes(id));
/** `ids` with hymn `h` taken out (every tune of it), and added back to its tune `h` when `on`. */
const withHymn = (ids, h, on) => [...ids.filter((id) => !tunesOf(h).includes(id)), ...(on ? [h.id] : [])];
/** Hymns for `ids`, each hymn once (the first of its tunes there). */
function hymnsFor(ids, byId) {
    const seen = new Set();
    return ids.map((id) => byId.get(id)).filter((h) => h && !seen.has(tuneKey(h)) && seen.add(tuneKey(h)));
}

let favorites = store.get("favorites", []);
const isFavorite = (h) => holds(favorites, h);
function setFavorite(h, on) {
    favorites = withHymn(favorites, h, on);
    store.set("favorites", favorites);
    favoritesChanged(favorites);
    track("favorite_toggle", { on });
}

const STAR = {
    on: "M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z",
    off: "M22 9.24l-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4z",
};
const starLabel = (h, on) => (on ? `Remove ${h.title} from favorites` : `Add ${h.title} to favorites`);
const starButton = (h) => {
    const on = isFavorite(h);
    return `<button type="button" class="star-btn" data-fav="${h.id}" aria-pressed="${on}"
                aria-label="${esc(starLabel(h, on))}" title="${on ? "Remove from favorites" : "Add to favorites"}">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="${on ? STAR.on : STAR.off}"/></svg>
        </button>`;
};
function paintStar(btn, h) {
    const on = isFavorite(h);
    btn.setAttribute("aria-pressed", on);
    btn.setAttribute("aria-label", starLabel(h, on));
    btn.title = on ? "Remove from favorites" : "Add to favorites";
    btn.querySelector("path").setAttribute("d", on ? STAR.on : STAR.off);
}

// ---- The singer's own lists (Advent hymns, Church hymns, Hymns to learn...) ----------
// Each { id, name, hymns: [hymn ids in the order added] }, oldest list first, kept
// like favorites (and in the account when signed in, src/sync.js)

let lists = store.get("hymnLists", []);
// The church copy's own lists (src/church-lists.json): shown to everyone first
// under My lists, fixed (no adding, removing, renaming), each hymn at the tune
// the church sings it to. The list's titles and tunes are there for reading; the
// app goes by the ids.
const churchLists = CHURCH
    ? churchListsData.map((l) => ({ id: l.id, name: l.name, hymns: l.hymns.map((h) => h.id), fixed: true }))
    : [];
const listById = (id) => lists.find((l) => l.id === id) ?? churchLists.find((l) => l.id === id);
const listHash = (l) => `#/lists/${l.id}`;
function saveLists() {
    store.set("hymnLists", lists);
    listsChanged(lists);
}
/** Asks for a list's name (`current` when renaming); null if they cancel or leave it blank. */
function askListName(current = "") {
    const name = prompt(current ? "New name for this list:" : "Name your new list (for example, Advent hymns):", current);
    return name?.trim().replace(/\s+/g, " ").slice(0, 60) || null;
}
/** Makes a new list (asking its name); returns it, or null if they cancel. */
function newList() {
    const name = askListName();
    if (!name) return null;
    const l = { id: `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, hymns: [] };
    lists.push(l);
    saveLists();
    track("list_create");
    return l;
}
function setInList(l, h, on) {
    l.hymns = withHymn(l.hymns, h, on);
    saveLists();
    track("list_toggle", { on });
}
const LIST_ICON = {
    add: "M14 10H3v2h11v-2zm0-4H3v2h11V6zm4 8v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zM3 16h7v-2H3v2z",
    has: "M14 10H2v2h12v-2zm0-4H2v2h12V6zM2 16h8v-2H2v2zm19.5-4.5L23 13l-6.99 7-4.51-4.5L13 14l3.01 3 5.49-5.5z",
};
const REMOVE_ICON = "M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z";

/**
 * The "add to a list" button beside a hymn's title, and the little menu it opens:
 * a tick box for Favorites and each list, and "New list".
 */
function listButton(h) {
    const any = lists.some((l) => holds(l.hymns, h));
    return `<div class="list-pick">
        <button type="button" class="star-btn" id="list-btn" aria-haspopup="true" aria-expanded="false"
                aria-pressed="${any}" aria-label="Add ${esc(h.title)} to a list" title="Add to a list">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="${any ? LIST_ICON.has : LIST_ICON.add}"/></svg>
        </button>
        <div class="list-menu" id="list-menu" hidden></div>
    </div>`;
}
function wireListButton(h, onFavorite) {
    const btn = document.getElementById("list-btn");
    const menu = document.getElementById("list-menu");
    const paintBtn = () => {
        const any = lists.some((l) => holds(l.hymns, h));
        btn.setAttribute("aria-pressed", any);
        btn.querySelector("path").setAttribute("d", any ? LIST_ICON.has : LIST_ICON.add);
    };
    const fill = () => {
        menu.innerHTML = `
            <p class="list-menu-head">Add to a list</p>
            <label><input type="checkbox" data-pick-fav${isFavorite(h) ? " checked" : ""}> Favorites</label>
            ${lists.map((l) => `<label><input type="checkbox" data-pick-list="${l.id}"${holds(l.hymns, h) ? " checked" : ""}> ${esc(l.name)}</label>`).join("")}
            <button type="button" class="link-btn" data-new-list>+ New list</button>`;
    };
    const close = () => {
        menu.hidden = true;
        btn.setAttribute("aria-expanded", "false");
        document.removeEventListener("click", outside, true);
        document.removeEventListener("keydown", onKey);
    };
    const outside = (e) => {
        if (!menu.isConnected) return close();
        if (!e.target.closest(".list-pick")) close();
    };
    const onKey = (e) => {
        if (e.key === "Escape") {
            close();
            btn.focus();
        }
    };
    btn.addEventListener("click", () => {
        if (!menu.hidden) return close();
        fill();
        menu.hidden = false;
        btn.setAttribute("aria-expanded", "true");
        document.addEventListener("click", outside, true);
        document.addEventListener("keydown", onKey);
        menu.querySelector("input")?.focus();
    });
    menu.addEventListener("change", (e) => {
        const box = e.target;
        if (box.hasAttribute("data-pick-fav")) {
            setFavorite(h, box.checked);
            onFavorite();
            toast(box.checked ? "Added to favorites" : "Removed from favorites");
            return;
        }
        const l = listById(box.dataset.pickList);
        if (!l) return;
        setInList(l, h, box.checked);
        paintBtn();
        toast(box.checked ? `Added to ${l.name}` : `Removed from ${l.name}`);
    });
    menu.addEventListener("click", (e) => {
        if (!e.target.closest("[data-new-list]")) return;
        const l = newList();
        if (!l) return;
        setInList(l, h, true);
        fill();
        paintBtn();
        toast(`Added to ${l.name}`);
    });
}

// ---- Search ranking -----------------------------------------------------------
// How closely a hymn matches the search: a title that is (or starts with) what was
// typed comes first, then whole-phrase matches, then title words, then tune and
// composer. Punctuation is ignored so "o god our help" finds "O God, Our Help".

const plain = (s) => norm(unshorten(s || "")).replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();

// Old hymns drop a letter for the metre (heav'n, o'er, wand'ring, bless'd); spelt out,
// "heaven" finds "heav'n". Lowercase only, so names like O'Neill are left alone.
function unshorten(s) {
    return s
        .replace(/[‘’]/g, "'")
        .replace(/([oe])'er/g, "$1ver") // o'er, e'er, ne'er, where'er, o'ertaken
        .replace(/\be'en\b/g, "even")
        .replace(/([a-z])'n(?=\b|ly\b)/g, "$1en") // heav'n, giv'n, heav'nly
        .replace(/([a-z])'r/g, "$1er") // pow'r, ev'ry, wand'ring
        .replace(/\b(?!(?:i|you|he|she|we|they|who|it|that)'d\b)([a-z]+)'d\b/gi, "$1ed"); // bless'd, wander'd
}
const words = (s) => s.split(" ");

function fieldScore(field, q, terms, weight) {
    if (!field) return 0;
    let score = 0;
    if (field === q) score += 100;
    else if (field.startsWith(q)) score += 60;
    else if (` ${field}`.includes(` ${q}`)) score += 40;
    else if (field.includes(q)) score += 25;
    const ws = words(field);
    for (const t of terms) {
        if (ws.includes(t)) score += 8;
        else if (ws.some((w) => w.startsWith(t))) score += 5;
        else if (field.includes(t)) score += 2;
    }
    return score * weight;
}

function matchScore(h, terms) {
    h._plain ??= { title: plain(h.title), tune: plain(h.tune), composer: plain(h.composer) };
    const pterms = plain(terms.join(" ")).split(" ").filter(Boolean);
    const q = pterms.join(" ");
    return (
        fieldScore(h._plain.title, q, pterms, 10) +
        fieldScore(h._plain.tune, q, pterms, 2) +
        fieldScore(h._plain.composer, q, pterms, 1) +
        lyricScore(lyricsOf(h), q, pterms, 3)
    );
}

// ---- Lyrics index --------------------------------------------------------------
// So a remembered line finds its hymn: every verse's words, punctuation and verse
// numbers dropped and the lines run together (a phrase can cross a line break).
// Built the first time a hymn is searched, from the verses already loaded.

/** A hymn's lyrics: `text` to search, and its `lines` ({ raw, p: plain, verse }) to show. */
function lyricsOf(h) {
    if (h._lyrics) return h._lyrics;
    const lines = [];
    (h.verses || []).forEach((v, i) =>
        v.replace(/^\s*\d+\.?\s+/, "").split("\n").forEach((raw) => {
            raw = raw.trim();
            const p = plain(raw.replace(/[–—]/g, " ")); // dashes join words, not letters
            if (p) lines.push({ raw, p, verse: i + 1 });
        })
    );
    const text = lines.map((l) => l.p).join(" ");
    return (h._lyrics = { text, lines, words: new Set(text.split(" ")) });
}

/** Like fieldScore, for the lyrics: the first line, then a whole phrase, then single words. */
function lyricScore(lyr, q, terms, weight) {
    if (!lyr.text || !q) return 0;
    let score = 0;
    if (lyr.text.startsWith(q)) score += 60;
    else if (` ${lyr.text}`.includes(` ${q}`)) score += 40;
    else if (lyr.text.includes(q)) score += 25;
    for (const t of terms) score += lyr.words.has(t) ? 8 : lyr.text.includes(t) ? 3 : 0;
    return score * weight;
}

/** The line (or pair of lines, for a phrase across a break) that best matches, or null. */
function matchingLine(lyr, q, terms) {
    const { lines } = lyr;
    let line = lines.find((l) => l.p.includes(q));
    if (!line) {
        const i = lines.findIndex((l, i) => i + 1 < lines.length && `${l.p} ${lines[i + 1].p}`.includes(q));
        if (i >= 0) line = { raw: `${lines[i].raw} / ${lines[i + 1].raw}`, verse: lines[i].verse };
    }
    if (!line) {
        // The line holding the most of the words searched for, longer words counting
        // for more (so "mercy" beats "of")
        let best = 0;
        for (const l of lines) {
            const n = terms.reduce((sum, t) => sum + (` ${l.p}`.includes(` ${t}`) ? t.length : 0), 0);
            if (n > best) [best, line] = [n, l];
        }
    }
    return line && { text: line.raw.replace(/[\s,;:.\-–—]+$/, ""), verse: line.verse };
}

// ---- List screen ------------------------------------------------------------
// mode "all" lists every hymn, "favorites" only the starred ones, "list" the
// singer's own list `listId`. Favorites and their own lists are under "My lists".

async function showList(mode = "all", listId = null) {
    const own = mode === "list" ? listById(listId) : null;
    if (mode === "list" && !own) return location.replace("#/favorites"); // deleted, maybe on another device
    stopPlayer();
    setDownloadScope(null);
    backBtn.hidden = true;
    pageTitle.textContent = "Let's Sing";
    document.title = own ? `${own.name} · Let's Sing` : mode === "favorites" ? "Favorites · Let's Sing" : "Let's Sing";
    const key = own ? own.id : mode;
    if (key !== listMode) listScroll = 0;
    listMode = key;
    const hymns = await hymnsPromise;
    hymns.forEach((h) => (h._search ??= norm(`${h.title} ${h.tune} ${h.composer}`)));
    const byId = new Map(hymns.map((h) => [h.id, h]));
    const mine = mode !== "all";
    const fixed = !!own?.fixed; // a church list: read only
    const ids = () => (own ? own.hymns : favorites);
    // How many hymns a list holds (a hymn there in two of its tunes counts once)
    const howMany = (ids) => hymnsFor(ids, byId).length || "";

    app.innerHTML = `
        <div class="search">
            <input id="search" type="search" placeholder="Search title, words, tune, or composer"
                   autocomplete="off" aria-label="Search hymns" value="${esc(searchText)}">
            <nav class="tabs" aria-label="Which hymns">
                <a href="#/"${mode === "all" ? ' aria-current="page"' : ""}>${psalmsOnly ? "All psalms" : "All hymns"}</a>
                <a href="#/favorites"${mine ? ' aria-current="page"' : ""}>My lists</a>
                <a href="#/learn">Learn</a>
            </nav>
        </div>
        <div id="install-slot"></div>
        ${mine ? `<nav class="list-chips" aria-label="Your lists">
            ${churchLists.map((l) => `<a href="${listHash(l)}" class="church-chip"${l === own ? ' aria-current="page"' : ""}>${esc(l.name)}
                <span class="tab-count"${l === own ? ' id="own-count"' : ""}>${howMany(l.hymns)}</span></a>`).join("")}
            <a href="#/favorites"${own ? "" : ' aria-current="page"'}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="${STAR.on}"/></svg>Favorites
                <span class="tab-count" id="fav-count">${howMany(favorites)}</span></a>
            ${lists.map((l) => `<a href="${listHash(l)}"${l === own ? ' aria-current="page"' : ""}>${esc(l.name)}
                <span class="tab-count"${l === own ? ' id="own-count"' : ""}>${howMany(l.hymns)}</span></a>`).join("")}
            <button type="button" class="list-chip-new" id="list-new">+ New list</button>
        </nav>
        ${fixed ? `<p class="fav-actions hint">The hymns Grace Community Church sings, each to the church's tune.
            Tap the star to add one to your favorites.</p>` : `<div class="fav-actions">
            <a class="btn" href="${own ? `${listHash(own)}/paste` : "#/favorites/paste"}">Paste a list</a>
            ${own ? `<button type="button" class="link-btn" id="list-rename">Rename</button>
                <button type="button" class="link-btn" id="list-delete">Delete list</button>`
            : `<button type="button" class="link-btn" id="fav-clear"${favorites.length ? "" : " hidden"}>Clear favorites</button>`}
        </div>`}
        <div id="sync-card"></div>` : ""}
        <p class="count" id="count"></p>
        <ul class="hymn-list" id="list"></ul>
        <details class="privacy">
            <summary>Privacy</summary>
            <p>Let's Sing uses Google Analytics to count visits and see which features get used,
               so the app can be improved. You don't need an account, and nothing you type into
               the app is collected. Your data will never be sold or given away.</p>
            <p>Learn listens through your microphone only while it's turned on. Your voice is
               analysed on your device as you sing; it's never recorded or sent anywhere. Your
               scores and lesson progress are kept on this device.</p>
            <p>If you choose to sign in with Google (with the round button at the top right, or on the Favorites or Learn page), your scores and lesson
               progress and your favorites and lists are also saved to your account, so they appear on your
               other devices.
               Let's Sing receives only your name and email address from Google, and you can sign
               out at any time.</p>
        </details>`;

    const list = document.getElementById("list");
    const count = document.getElementById("count");
    const render = () => {
        const terms = norm(searchText).split(/\s+/).filter(Boolean);
        // Psalms only (Settings) narrows All hymns; the singer's own lists stay whole
        // (All hymns holds every tune of each hymn; one of them is shown, below)
        const pool = mine ? hymnsFor(ids(), byId) : psalmsOnly ? hymns.filter((h) => h.psalm) : hymns;
        const total = mine ? pool.length : new Set(pool.map(tuneKey)).size;
        // A hymn is found by its title, tune and composer, or else by its words
        // (each word searched for somewhere in them, or in the title and words together)
        // (Not the words for a letter or two: every hymn's words have an "a" in them)
        const pterms = plain(searchText).length >= 3 ? plain(searchText).split(" ").filter(Boolean) : [];
        const q = pterms.join(" ");
        const inInfo = (h) => terms.every((t) => h._search.includes(t));
        const inWords = (h) => {
            h._plain ??= { title: plain(h.title), tune: plain(h.tune), composer: plain(h.composer) };
            const all = `${h._plain.title} ${h._plain.tune} ${h._plain.composer} ${lyricsOf(h).text}`;
            return pterms.length > 0 && pterms.every((t) => all.includes(t));
        };
        let shown = pool.filter((h) => inInfo(h) || inWords(h));
        // Closest match first; the sort is stable, so ties keep the list's order.
        if (terms.length) {
            const scores = new Map(shown.map((h) => [h, matchScore(h, terms)]));
            shown = shown.sort((a, b) => scores.get(b) - scores.get(a));
        }
        // A hymn's tunes as one row, where its best-placed tune was: the singer's
        // tune, unless the search names another of its tunes
        if (!mine) {
            const found = new Map();
            for (const h of shown) found.set(tuneKey(h), [...(found.get(tuneKey(h)) ?? []), h]);
            const tuneNamed = (h) => pterms.length > 0 && pterms.every((t) => h._plain.tune.includes(t));
            const pick = (same) => {
                const named = same.filter(tuneNamed);
                const from = named.length ? named : same;
                return from.find((h) => h.id === chosenTune(h)) ?? from[0];
            };
            shown = shown.filter((h) => found.get(tuneKey(h))[0] === h).map((h) => pick(found.get(tuneKey(h))));
        }
        // Under a hymn found by its words, the line that matched (also when a phrase of
        // two or more words is in its verses but not its title)
        const lineFor = (h) => {
            if (!pterms.length) return null;
            const phrase = pterms.length > 1 && lyricsOf(h).text.includes(q) && !h._plain.title.includes(q);
            return !inInfo(h) || phrase ? matchingLine(lyricsOf(h), q, pterms) : null;
        };
        const noun = psalmsOnly && !mine ? (total === 1 ? "psalm" : "psalms") : total === 1 ? "hymn" : "hymns";
        count.textContent = terms.length ? `${shown.length} of ${total} ${noun}` : `${total} ${noun}`;
        paintCounts();
        if (mine && !pool.length) {
            count.textContent = "";
            list.innerHTML = own
                ? `<li class="empty">Nothing in ${esc(own.name)} yet. Open a hymn and tap the list button
                    beside its title to add it here, or paste a list of hymns to add them all at once.</li>`
                : `<li class="empty">No favorites yet. Tap the star beside any hymn to add it here,
                    or paste a list of hymns (from a bulletin or an email) to add them all at once.</li>`;
            return;
        }
        list.innerHTML = shown
            .map((h) => {
                const line = lineFor(h);
                return `<li><a href="#/hymn/${h.id}">
                    <span class="title">${esc(h.title)}</span>
                    <span class="sub">${esc([h.tune, h.composer, h.tunes && `${h.tunes.length} tunes`].filter(Boolean).join(" · "))}</span>
                    ${line ? `<span class="lyric-line">“${esc(line.text)}”<span class="lyric-verse"> · verse ${line.verse}</span></span>` : ""}
                </a>${own && !fixed ? `<button type="button" class="star-btn" data-remove="${h.id}"
                    aria-label="${esc(`Remove ${h.title} from ${own.name}`)}" title="Remove from this list">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="${REMOVE_ICON}"/></svg></button>` : starButton(h)}</li>`;
            })
            .join("");
    };
    const paintCounts = () => {
        const fav = document.getElementById("fav-count");
        if (fav) fav.textContent = howMany(favorites);
        const ownCount = document.getElementById("own-count");
        if (ownCount) ownCount.textContent = howMany(own.hymns);
        document.getElementById("fav-clear")?.toggleAttribute("hidden", !favorites.length);
    };
    render();
    const search = document.getElementById("search");
    search.addEventListener("input", () => {
        searchText = search.value;
        render();
    });
    list.addEventListener("click", (e) => {
        const remove = e.target.closest("[data-remove]");
        if (remove && own && !fixed) {
            const h = byId.get(+remove.dataset.remove);
            setInList(own, h, false);
            render();
            toast(`Removed ${h.title}`);
            return;
        }
        const btn = e.target.closest("[data-fav]");
        if (!btn) return;
        const h = byId.get(+btn.dataset.fav);
        const on = !isFavorite(h);
        setFavorite(h, on);
        if (mode === "favorites") {
            render();
            toast(`Removed ${h.title}`);
        } else {
            paintStar(btn, h);
            paintCounts();
        }
    });
    document.getElementById("list-new")?.addEventListener("click", () => {
        const l = newList();
        if (l) location.hash = listHash(l);
    });
    document.getElementById("list-rename")?.addEventListener("click", () => {
        const name = askListName(own.name);
        if (!name || name === own.name) return;
        own.name = name;
        saveLists();
        route();
    });
    document.getElementById("list-delete")?.addEventListener("click", () => {
        if (!confirm(`Delete the list “${own.name}”?\n\nIts hymns stay in the app; only the list goes.`)) return;
        lists = lists.filter((l) => l !== own);
        saveLists();
        track("list_delete");
        location.hash = "#/favorites";
    });
    document.getElementById("fav-clear")?.addEventListener("click", () => {
        if (!confirm(`Remove all ${howMany(favorites)} hymns from your favorites?`)) return;
        favorites = [];
        store.set("favorites", favorites);
        favoritesChanged(favorites);
        render();
    });
    renderSyncCard();
    renderInstallBanner();
    window.scrollTo(0, listScroll);
}

// ---- Learn: the course (src/learnui.js), then the singer's scores ---------------------

const learnNav = () => `<nav class="tabs learn-tabs" aria-label="Which hymns">
        <a href="#/">All hymns</a><a href="#/favorites">My lists</a><a href="#/learn" aria-current="page">Learn</a>
    </nav>`;

/** What the course screens need from the app. */
const learnCtx = () => ({
    app, esc, toast, track, hymnsPromise, midiUrl, scoreUrl, shapes: shapeNotes,
    setTitle(title) {
        pageTitle.textContent = title;
        document.title = `${title} · Let's Sing`;
    },
});

async function showLearn() {
    stopPlayer();
    setDownloadScope(null);
    backBtn.hidden = false;
    pageTitle.textContent = "Learn";
    document.title = "Learn · Let's Sing";
    app.innerHTML = `${learnNav()}<div id="course"><p class="message">Loading lessons…</p></div>
        <section class="scores"><h2>Your scores</h2>${EMBED ? "" : `<div id="sync-card"></div>`}<div id="scores"></div></section>`;
    renderSyncCard();
    renderScores(document.getElementById("scores"));
    const { renderCourse } = await import("./learnui.js");
    if (location.hash !== "#/learn") return;
    renderCourse(document.getElementById("course"), learnCtx());
}

async function showLessonPage(trackId, n) {
    stopPlayer();
    setDownloadScope(null);
    backBtn.hidden = false;
    const { showLesson } = await import("./learnui.js");
    leaveLesson = await showLesson(learnCtx(), trackId, n);
    window.scrollTo(0, 0);
}

/** Learn scores across every hymn, into `host`. */
function renderScores(host) {
    const runs = loadRuns();
    if (!runs.length) {
        host.innerHTML = `<p class="learn-sub">No scores yet. Each hymn you sing in a lesson, or with <strong>Learn</strong>
            on a hymn's page, is scored and kept here.</p>`;
        return;
    }
    const avg = (list) => Math.round(list.reduce((sum, r) => sum + shares(r).on, 0) / list.length);
    const recent = runs.slice(-10);
    const minutes = Math.round(runs.reduce((sum, r) => sum + r.on + r.flat + r.sharp, 0) / 60);
    const best = Math.max(...runs.map((r) => shares(r).on));
    const all = runs.reduce((t, r) => ({ on: t.on + r.on, flat: t.flat + r.flat, sharp: t.sharp + r.sharp }), { on: 0, flat: 0, sharp: 0 });
    // One row per hymn and part, the most recently practised first
    const groups = new Map();
    for (const r of runs) {
        const key = `${r.hymn}:${r.part}`;
        groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    const rows = [...groups.values()].sort((a, b) => b.at(-1).at - a.at(-1).at);
    const when = (t) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    host.innerHTML = `
        <section class="progress">
            <div class="tiles">
                <div class="tile"><span class="tile-n">${avg(recent)}%</span><span class="tile-l">on pitch, last ${recent.length} ${recent.length === 1 ? "run" : "runs"}</span></div>
                <div class="tile"><span class="tile-n">${best}%</span><span class="tile-l">best run</span></div>
                <div class="tile"><span class="tile-n">${runs.length}</span><span class="tile-l">${runs.length === 1 ? "run" : "runs"}</span></div>
                <div class="tile"><span class="tile-n">${minutes}</span><span class="tile-l">${minutes === 1 ? "minute" : "minutes"} sung</span></div>
            </div>
            <div class="card">
                <h3>All your singing</h3>
                ${splitBar(all)}
            </div>
            <div class="card">
                <h3>On pitch, run by run</h3>
                <div id="progress-chart"></div>
            </div>
            <div class="card">
                <h3>By hymn</h3>
                <table class="progress-table">
                    <thead><tr><th>Hymn</th><th>Part</th><th>Runs</th><th>Latest</th><th>Best</th><th>Last sung</th></tr></thead>
                    <tbody>${rows.map((g) => {
                        const ons = g.map((r) => shares(r).on), last = ons.at(-1), change = g.length > 1 ? last - ons[0] : 0;
                        return `<tr>
                            <td><a href="#/hymn/${g[0].hymn}">${esc(g[0].title)}</a></td>
                            <td>${PARTS[g[0].part]}</td>
                            <td>${g.length}</td>
                            <td>${last}%${change ? ` <span class="change">${change > 0 ? "▲" : "▼"} ${Math.abs(change)}</span>` : ""}</td>
                            <td>${Math.max(...ons)}%</td>
                            <td>${when(g.at(-1).at)}</td>
                        </tr>`;
                    }).join("")}</tbody>
                </table>
                <p class="learn-sub">▲/▼ the change since that hymn's first run.</p>
            </div>
            <button type="button" class="link-btn" id="progress-clear">Clear all scores</button>
        </section>`;
    onPitchChart(host.querySelector("#progress-chart"), runs,
        (r) => `${esc(r.title)} · ${PARTS[r.part]} · ${new Date(r.at).toLocaleDateString()}`);
    host.querySelector("#progress-clear").addEventListener("click", () => {
        const where = account() ? "on this device and in your account" : "on this device";
        if (!confirm(`Delete all ${runs.length} saved scores ${where}? Lesson progress is kept.`)) return;
        clearRuns();
        renderScores(host);
    });
}

// ---- Sign in to sync (src/sync.js) -----------------------------------------------

const ago = (t) => {
    const min = Math.round((Date.now() - t) / 60000);
    return min < 1 ? "just now" : min < 60 ? `${min} min ago` : new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
};

/** The Learn page's sign-in box: an invitation signed out, the account and how syncing is going signed in. */
function renderSyncCard() {
    const host = document.getElementById("sync-card");
    if (!host) return;
    const { account: acct, status, lastSynced } = syncStatus();
    if (!acct) {
        host.innerHTML = `<div class="card sync-card">
            <h3>Use Let's Sing on all your devices</h3>
            <p class="learn-sub">Sign in with Google to keep your favorites, scores and lesson progress on
                every phone, tablet and computer you use. Optional: everything works without it.</p>
            <button type="button" class="btn" id="sync-in">Sign in with Google</button>
        </div>`;
        host.querySelector("#sync-in").addEventListener("click", (e) => startSignIn(e.target));
        return;
    }
    const state = syncState(status, lastSynced);
    host.innerHTML = `<div class="sync-line">
        <span>Signed in as <strong>${esc(acct.email || acct.name)}</strong>${state ? ` · <span class="sync-state">${state}</span>` : ""}</span>
        <button type="button" class="link-btn" id="sync-out">Sign out</button>
    </div>`;
    host.querySelector("#sync-out").addEventListener("click", startSignOut);
}

const syncState = (status, lastSynced) => ({
    syncing: "Syncing…",
    synced: `Synced ${ago(lastSynced)}`,
    offline: "Offline: will sync when you're back online",
    error: "Couldn't sync just now; will try again",
})[status] ?? "";

/** Signs in with Google from `btn` (greyed out meanwhile): the Learn/Favorites card or the account panel. */
async function startSignIn(btn) {
    if (btn) btn.disabled = true;
    try {
        if (await signIn()) {
            track("sync_sign_in");
            toast("Signed in. Your progress will now sync.", 2500);
        }
    } catch (err) {
        console.warn("sign-in:", err);
        toast("Couldn't sign in. Please try again.", 3000);
    }
    if (btn) btn.disabled = false;
    renderSyncCard();
    renderAccount();
}

async function startSignOut() {
    const removeHere = confirm("Also remove your favorites, scores and lesson progress from this device?\n\n"
        + "They stay in your account either way. Choose OK on a shared device, Cancel to keep them here.");
    try {
        await signOut(removeHere);
        toast("Signed out.");
    } catch (err) {
        console.warn("sign-out:", err);
        toast("Couldn't sign out. Please try again.", 3000);
    }
    renderAccount();
}

// ---- The account button (top right) ---------------------------------------------
// A round avatar: a blank figure while signed out, the first letter of the name
// once signed in (Google gives the app only the name and email, no photo). It
// opens a small panel to sign in, or to see the account and sign out.

const accountBtn = document.getElementById("account");
const accountPanel = document.getElementById("account-panel");
const BLANK_AVATAR = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8.5" r="4.2"/><path d="M3.5 23c.8-5 4.3-8 8.5-8s7.7 3 8.5 8z"/></svg>`;

function renderAccount() {
    const { account: acct, status, lastSynced } = syncStatus();
    const avatar = document.getElementById("avatar");
    const label = acct ? `Signed in as ${acct.name || acct.email}` : "Sign in";
    accountBtn.setAttribute("aria-label", label);
    accountBtn.title = label;
    avatar.classList.toggle("signed-in", !!acct);
    if (acct) avatar.textContent = ([...(acct.name || acct.email || "?").trim()][0] || "?").toUpperCase();
    else avatar.innerHTML = BLANK_AVATAR;
    if (!accountPanel.classList.contains("open")) return;
    const state = acct ? syncState(status, lastSynced) : "";
    accountPanel.innerHTML = acct ? `
        <div class="support-callout-arrow"></div>
        <p class="support-callout-title">${esc(acct.name || "Signed in")}</p>
        <p class="support-callout-body">${acct.email ? `${esc(acct.email)}<br>` : ""}Your favorites, scores and lesson
            progress are kept in step on every device you sign in on.${state ? `<br><span class="sync-state">${state}</span>` : ""}</p>
        <div class="support-callout-actions">
            <button type="button" class="support-callout-btn support-callout-btn-secondary" data-account="out">Sign out</button>
            <a href="#/settings" class="support-callout-btn support-callout-btn-secondary" data-account="settings">Settings</a>
            <button type="button" class="support-callout-btn support-callout-btn-text" data-account="close">Close</button>
        </div>` : `
        <div class="support-callout-arrow"></div>
        <p class="support-callout-title">Sign in</p>
        <p class="support-callout-body">Sign in with Google to keep your favorites, scores and lesson progress on
            every phone, tablet and computer you use. Optional: everything works without it.</p>
        <div class="support-callout-actions">
            <button type="button" class="support-callout-btn support-callout-btn-primary" data-account="in">Sign in with Google</button>
            <a href="#/settings" class="support-callout-btn support-callout-btn-secondary" data-account="settings">Settings</a>
            <button type="button" class="support-callout-btn support-callout-btn-text" data-account="close">Not now</button>
        </div>`;
}

function openAccountPanel() {
    accountPanel.classList.add("open");
    accountBtn.setAttribute("aria-expanded", "true");
    renderAccount();
    setTimeout(() => document.addEventListener("click", accountOutsideClick), 0);
}

function closeAccountPanel() {
    accountPanel.classList.remove("open");
    accountBtn.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", accountOutsideClick);
}

function accountOutsideClick(e) {
    if (!accountPanel.contains(e.target) && !accountBtn.contains(e.target)) closeAccountPanel();
}

accountBtn.addEventListener("click", () => {
    if (accountPanel.classList.contains("open")) return closeAccountPanel();
    track("account_button", { signed_in: !!account() });
    openAccountPanel();
});
accountPanel.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-account]");
    const action = btn?.dataset.account;
    if (action === "close" || action === "settings") closeAccountPanel();
    else if (action === "in") startSignIn(btn).then(() => account() && closeAccountPanel());
    else if (action === "out") {
        closeAccountPanel();
        startSignOut();
    }
});
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && accountPanel.classList.contains("open")) closeAccountPanel();
});
renderAccount();

onSync(({ changed }) => {
    renderSyncCard();
    renderAccount();
    if (changed) {
        favorites = store.get("favorites", []);
        lists = store.get("hymnLists", []);
        tuneChoices = store.get("tuneChoices", {});
        // Favorites, lists and tunes from another device: show them if the hymn list is open
        if (/^(#\/?|#\/favorites|#\/lists\/[\w-]+)?$/.test(location.hash)) route();
    }
    // New progress from another device: show it if the Learn page is open
    if (changed && location.hash === "#/learn") {
        const scores = document.getElementById("scores");
        if (scores) renderScores(scores);
        const course = document.getElementById("course");
        if (course) import("./learnui.js").then(({ renderCourse }) => location.hash === "#/learn" && renderCourse(course, learnCtx()));
    }
});
if (!EMBED) sync(); // does nothing unless signed in (or back from signing in)

// ---- Settings page (#/settings, from the account panel) --------------------------
// Choices kept on this device. The player and Learn save to the same places,
// so changing one there changes it here too.

/** A row of buttons with one pressed: `options` are { id, name, title }. */
const choiceRow = (key, label, options, current) => `
    <div class="view-switch setting-choice" role="group" aria-label="${label}" data-setting="${key}">
        ${options.map((o) => `<button type="button" data-value="${o.id}" aria-pressed="${o.id === current}"${o.title ? ` title="${esc(o.title)}"` : ""}>${o.name}</button>`).join("")}
    </div>`;

function showSettings() {
    stopPlayer();
    setDownloadScope(null);
    backBtn.hidden = false;
    pageTitle.textContent = "Settings";
    document.title = "Settings · Let's Sing";
    const theme = store.get("theme", "system");
    app.innerHTML = `
        <section class="settings-page">
            <div class="card">
                <h3>Look</h3>
                <div class="setting">
                    <div><p class="setting-name">Colors</p><p class="hint">System follows your phone or computer.</p></div>
                    ${choiceRow("theme", "Colors", THEMES.map((t) => ({ id: t, name: t[0].toUpperCase() + t.slice(1) })), theme)}
                </div>
            </div>
            <div class="card">
                <h3>Hymn list</h3>
                <div class="setting">
                    <div><p class="setting-name">Psalms only</p><p class="hint">Show only the metrical psalms
                        (like All People That On Earth Do Dwell, Psalm 100). Your own lists still show everything in them.</p></div>
                    ${choiceRow("psalmsOnly", "Psalms only", [{ id: "off", name: "Off" }, { id: "on", name: "On" }], psalmsOnly ? "on" : "off")}
                </div>
            </div>
            <div class="card">
                <h3>Learn</h3>
                <div class="setting">
                    <div><p class="setting-name">Your part</p><p class="hint">The voice Learn listens for and scores you on.</p></div>
                    ${choiceRow("learnPart", "Your part", VOICES.map((v, i) => ({ id: String(i), name: v })), String(learnPart))}
                </div>
            </div>
            <div class="card">
                <h3>Music</h3>
                <div class="setting">
                    <div><p class="setting-name">Instrument</p></div>
                    <select id="setting-instrument" aria-label="Instrument">
                        ${INSTRUMENTS.map((ins) => `<option value="${ins.id}"${ins.id === instrument.id ? " selected" : ""}>${ins.name}</option>`).join("")}
                    </select>
                </div>
                <div class="setting">
                    <div><p class="setting-name">Sheet music</p><p class="hint">Scroll shows one moving line; Page shows the whole hymn.</p></div>
                    ${choiceRow("scoreView", "Sheet music", SCORE_VIEWS, scoreView)}
                </div>
                <div class="setting">
                    <div><p class="setting-name">Shape notes</p>
                        <p class="hint">Each note gets a shape for its place in the scale, to help you sing at sight.</p></div>
                    ${choiceRow("shapeNotes", "Shape notes", SHAPE_NOTES, shapeNotes)}
                </div>
            </div>
            <p class="hint settings-foot">These settings are kept on this device.</p>
        </section>`;

    app.querySelectorAll("[data-setting]").forEach((group) =>
        group.addEventListener("click", (e) => {
            const btn = e.target.closest("[data-value]");
            if (!btn) return;
            const key = group.dataset.setting, value = btn.dataset.value;
            group.querySelectorAll("[data-value]").forEach((b) => b.setAttribute("aria-pressed", b === btn));
            if (key === "theme") { store.set("theme", value); applyTheme(value); }
            else if (key === "learnPart") { learnPart = +value; store.set("learnPart", learnPart); }
            else if (key === "scoreView") { scoreView = value; store.set("scoreView", value); }
            else if (key === "psalmsOnly") {
                psalmsOnly = value === "on";
                store.set("psalmsOnly", psalmsOnly);
                listScroll = 0;
            }
            else if (key === "shapeNotes") {
                shapeNotes = value;
                store.set("shapeNotes", value);
            }
            track("setting", { name: key, value });
        })
    );
    app.querySelector("#setting-instrument").addEventListener("change", (e) => {
        instrument = instrumentById(e.target.value);
        store.set("instrument", instrument.id);
        player.setInstrument(instrument.program);
        track("setting", { name: "instrument", value: instrument.id });
    });
}

// ---- Paste a list into favorites ------------------------------------------------
// Each pasted line is matched to its likeliest hymn (src/match.js). Lines it's
// sure of come ticked; the rest show the nearest hymns to choose from.

let pastedText = "";

/** `listId`: paste into that list of the singer's; without it, into favorites. */
async function showPaste(listId = null) {
    const own = listId ? listById(listId) : null;
    if (listId && !own) return location.replace("#/favorites");
    // Where the hymns go
    const into = own
        ? { name: own.name, has: (id) => holds(own.hymns, byId.get(id)), add: (id) => (own.hymns = withHymn(own.hymns, byId.get(id), true)), hash: listHash(own) }
        : { name: "favorites", has: (id) => isFavorite(byId.get(id)), add: (id) => setFavorite(byId.get(id), true), hash: "#/favorites" };
    const inName = own ? own.name : "your favorites";
    stopPlayer();
    setDownloadScope(null);
    backBtn.hidden = false;
    pageTitle.textContent = "Paste a list";
    document.title = "Paste a list · Let's Sing";
    const [hymns, { matchList }] = await Promise.all([hymnsPromise, import("./match.js")]);

    app.innerHTML = `
        <section class="paste">
            <h2>Add hymns to ${esc(own ? own.name : "favorites")}</h2>
            <p class="hint">Paste hymn titles, one per line &mdash; from a bulletin, an email or a spreadsheet.
               Numbers and bullets are fine, and so are first lines, tune names and psalm numbers
               (&ldquo;Psalm 23&rdquo;).</p>
            <textarea id="paste-text" rows="8" aria-label="Hymn list"
                      placeholder="Holy, Holy, Holy&#10;Psalm 100&#10;When I survey the wondrous cross">${esc(pastedText)}</textarea>
            <button type="button" class="btn" id="paste-match">Find these hymns</button>
            <div id="paste-results"></div>
        </section>`;

    const textEl = document.getElementById("paste-text");
    const results = document.getElementById("paste-results");
    const byId = new Map(hymns.map((h) => [h.id, h]));
    const label = (h) => [h.title, h.tune].filter(Boolean).join(" — ");
    const NOTES = {
        sure: "",
        likely: "Check this one",
    };

    // Play the chosen hymn where its parts first sing together (past any melody-only
    // introduction), to hear that it's the tune meant; one at a time, all four parts
    // at the hymn's own pace and key
    const LISTEN = { play: "M8 5v14l11-7z", stop: "M6 6h12v12H6z" };
    let listening = null, listenTimer = 0; // the row being played
    const chosen = (i) => byId.get(+results.querySelector(`[data-choice="${i}"]`).value);
    const paintListen = (i) => {
        const btn = results.querySelector(`[data-listen="${i}"]`);
        if (!btn) return;
        const on = listening === +i, h = chosen(i);
        // The tune spelled out too: on a phone the list cuts it off
        results.querySelector(`[data-tune="${i}"]`).textContent =
            [h?.tune && `Tune: ${h.tune}`, h?.composer].filter(Boolean).join(" · ");
        btn.disabled = !h?.midi;
        btn.setAttribute("aria-pressed", on);
        btn.setAttribute("aria-label", h?.midi ? `${on ? "Stop" : "Play"} ${label(h)}` : "No music for this hymn yet");
        btn.title = h?.midi ? (on ? "Stop" : "Play this tune") : "No music for this hymn yet";
        btn.querySelector("path").setAttribute("d", on ? LISTEN.stop : LISTEN.play);
    };
    const stopListening = () => {
        clearInterval(listenTimer);
        const was = listening;
        listening = null;
        // Once this screen is gone the player belongs to the hymn opened next
        if (was === null || !results.isConnected) return;
        player.stop();
        paintListen(was);
    };
    const listen = async (i) => {
        const was = listening;
        stopListening();
        if (was === i) return;
        const h = chosen(i);
        if (!h?.midi) return;
        listening = i;
        paintListen(i);
        try {
            if (!(await player.load(midiUrl(h))) || listening !== i) return;
            VOICES.forEach((_, v) => player.setVoiceVolume(v, 1));
            player.setTempo(1);
            player.setTranspose(0);
            const start = await player.harmonyStart();
            if (listening !== i) return;
            player.seek(start);
            await player.play();
            listenTimer = setInterval(() => {
                if (!results.isConnected || !player.isPlaying()) stopListening();
            }, 300);
        } catch {
            if (listening === i) stopListening();
            toast("Couldn't load that tune's music. Check your connection.", 2500);
        }
    };
    results.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-listen]");
        if (btn) listen(+btn.dataset.listen);
    });

    const find = () => {
        stopListening();
        pastedText = textEl.value;
        const all = matchList(pastedText, hymns);
        if (!all.length) {
            results.innerHTML = `<p class="hint">Nothing to look for yet &mdash; paste some hymn titles above.</p>`;
            return;
        }
        // Lines with no hymn close to them are only named, not offered
        const matches = all.filter((m) => m.confidence !== "none");
        const notFound = all
            .filter((m) => m.confidence === "none")
            .map((m) => `<p>Couldn't find &ldquo;${esc(m.line)}&rdquo;</p>`)
            .join("");
        if (!matches.length) {
            results.innerHTML = `<div class="not-found" role="status">${notFound}</div>`;
            return;
        }
        results.innerHTML = `
            <div class="not-found" role="status">${notFound}</div>
            <ul class="match-list">
                ${matches.map((m, i) => `
                    <li class="match is-${m.confidence}">
                        <input type="checkbox" id="pick-${i}" data-pick="${i}" checked
                               aria-label="Add the hymn for “${esc(m.line)}”">
                        <div class="match-body">
                            <label class="match-line" for="pick-${i}">${esc(m.line)}</label>
                            <div class="match-pick">
                                ${m.confidence === "sure"
                                    // Plainly this hymn on this tune: nothing to choose
                                    ? `<input type="hidden" data-choice="${i}" value="${m.candidates[0].hymn.id}">
                                       <span class="match-chosen">${esc(m.candidates[0].hymn.title)}</span>`
                                    : `<select data-choice="${i}" aria-label="Hymn for “${esc(m.line)}”">
                                        ${m.candidates.map((c) => `<option value="${c.hymn.id}">${esc(label(c.hymn))}</option>`).join("")}
                                    </select>`}
                                <button type="button" class="mini-btn" data-listen="${i}">
                                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="${LISTEN.play}"/></svg>
                                </button>
                            </div>
                            <span class="match-tune" data-tune="${i}"></span>
                            <span class="match-note" data-note="${i}"></span>
                        </div>
                    </li>`).join("")}
            </ul>
            <div class="paste-actions">
                <button type="button" class="btn" id="paste-add"></button>
            </div>`;
        const addBtn = document.getElementById("paste-add");
        const update = () => {
            matches.forEach((m, i) => {
                const id = +results.querySelector(`[data-choice="${i}"]`).value;
                results.querySelector(`[data-note="${i}"]`).innerHTML =
                    into.has(id) ? `Already in ${esc(inName)}`
                    : m.tunes && m.confidence === "likely" ? "Sung to more than one tune &mdash; pick the one you want"
                    : NOTES[m.confidence];
            });
            const n = results.querySelectorAll("[data-pick]:checked").length;
            addBtn.textContent = n ? `Add ${n} ${n === 1 ? "hymn" : "hymns"} to ${into.name}` : "Nothing ticked to add";
            addBtn.disabled = !n;
        };
        results.onchange = (e) => {
            // Choosing a hymn for a line means you want it
            const i = e.target.dataset.choice;
            if (i) {
                results.querySelector(`[data-pick="${i}"]`).checked = true;
                matches[i].confidence = "sure"; // their own pick needs no second look
                // Picking another hymn while one plays: play the new one instead
                if (listening === +i) {
                    stopListening();
                    listen(+i);
                } else paintListen(i);
            }
            update();
        };
        update();
        matches.forEach((_, i) => paintListen(i));
        addBtn.addEventListener("click", () => {
            const ids = [...results.querySelectorAll("[data-pick]:checked")].map(
                (box) => +results.querySelector(`[data-choice="${box.dataset.pick}"]`).value
            );
            const added = [...new Set(ids)].filter((id) => byId.has(id) && !into.has(id));
            added.forEach(into.add);
            if (own && added.length) saveLists(); // all at once, so they keep their order on other devices
            track(own ? "list_paste" : "favorites_paste", { lines: all.length, added: added.length });
            pastedText = "";
            location.hash = into.hash;
            toast(added.length ? `Added ${added.length} ${added.length === 1 ? "hymn" : "hymns"} to ${into.name}` : `Those are already in ${inName}`, 2500);
        });
        results.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    document.getElementById("paste-match").addEventListener("click", find);
    textEl.addEventListener("input", () => (pastedText = textEl.value));
    if (!pastedText) textEl.focus();
}

// ---- Offline downloads (top bar arrow) ---------------------------------------
// On a hymn's page the arrow saves that hymn; anywhere else, every hymn. Either
// way it opens a small panel that also removes what's saved. Fetching a file
// through the service worker stores it in its cache (the soundfont is in the
// app's own cache, always there), and what's saved is read back from that
// cache itself, so the arrow stays truthful after an update replaces it.

const CONTENT_CACHE = "lets-sing-content"; // as in sw-template.js
const downloadBtn = document.getElementById("download");
const downloadPanel = document.getElementById("download-panel");
const DOWNLOAD_ICONS = {
    todo: "M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z",
    done: "M5 20h14v-2H5v2zm4.6-5.6L5.4 10.2 6.8 8.8l2.8 2.8 7.6-7.6 1.4 1.4-9 9z",
};
let downloadHymn = null; // the hymn whose page is open, or null for all hymns
let downloading = false;

const absolute = (url) => new URL(url, location.href).href;
const hymnFiles = (h) =>
    [h.midi && midiUrl(h), h.score && scoreUrl(h), h.score && scoreMapUrl(h)].filter(Boolean).map(absolute);

async function offlineFiles() {
    const hymns = await hymnsPromise;
    return [...new Set(hymns.flatMap(hymnFiles))];
}

async function savedFiles() {
    const cache = await caches.open(CONTENT_CACHE);
    return new Set((await cache.keys()).map((req) => req.url));
}

// The hymns this page's arrow is about, and how many of them are saved
async function downloadScope() {
    const hymns = downloadHymn ? [downloadHymn] : (await hymnsPromise).filter((h) => h.midi);
    const saved = await savedFiles();
    const isSaved = (h) => hymnFiles(h).every((url) => saved.has(url));
    const missing = [...new Set(hymns.flatMap(hymnFiles))].filter((url) => !saved.has(url));
    return { hymns, saved, isSaved, missing, savedCount: hymns.filter(isSaved).length };
}

async function setDownloadState() {
    if (downloadBtn.hidden) return;
    const scope = await downloadScope();
    const state = downloading ? "busy" : scope.missing.length ? "todo" : "done";
    const label = downloadHymn
        ? { todo: "Save this hymn for offline use", busy: "Saving…", done: "This hymn is saved for offline use" }
        : { todo: "Download all hymns for offline use", busy: "Downloading hymns…", done: "All hymns downloaded for offline use" };
    downloadBtn.dataset.state = state;
    downloadBtn.setAttribute("aria-label", label[state]);
    downloadBtn.title = label[state];
    if (state !== "busy") downloadBtn.querySelector("path").setAttribute("d", DOWNLOAD_ICONS[state]);
}

// Drops saved copies of hymns no current hymn uses (an older version of a
// changed MIDI file, or a removed hymn), so the saved store doesn't grow.
async function pruneOldHymns() {
    const current = new Set(await offlineFiles());
    const cache = await caches.open(CONTENT_CACHE);
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

// Fetches the files six at a time (the service worker saves each one), calling
// onEach(done) after each; failures are left for the caller's re-check of the cache
async function fetchAll(files, onEach = () => {}) {
    const queue = [...files];
    let done = 0;
    const next = async () => {
        while (queue.length) {
            try { await fetch(queue.pop()); } catch { /* not saved: shows in the re-check */ }
            onEach(++done);
        }
    };
    await Promise.all(Array.from({ length: 6 }, next));
}

async function download() {
    if (!navigator.onLine) return toast("Connect to the internet to download.", 3000);
    protectStorage();
    const one = downloadHymn;
    const files = (await downloadScope()).missing;
    const total = files.length;
    downloading = true;
    setDownloadState();
    const progress = toast(one ? "Saving this hymn…" : "Downloading hymns…", 0);
    await fetchAll(files, (done) => {
        if (!one) progress.textContent = `Downloading hymns… ${done} of ${total}`;
    });
    progress.remove();
    downloading = false;
    const saved = await savedFiles();
    const failed = (one ? hymnFiles(one) : await offlineFiles()).filter((url) => !saved.has(url)).length;
    setDownloadState();
    track("offline_download", { scope: one ? "hymn" : "all", failed });
    if (failed) toast(`${failed} files didn't download. Check your connection and try again.`, 3500);
    else toast(one ? "Saved. This hymn now plays without internet." : "All hymns downloaded. The app now works offline.", 3500);
}

async function removeDownloads() {
    const one = downloadHymn;
    if (one) {
        // Keep files another saved hymn shares (hymns on one tune share its score)
        const { saved } = await downloadScope();
        const others = (await hymnsPromise).filter((h) => h !== one && hymnFiles(h).every((url) => saved.has(url)));
        const keep = new Set(others.flatMap(hymnFiles));
        const cache = await caches.open(CONTENT_CACHE);
        const shared = hymnFiles(one).filter((url) => keep.has(url));
        for (const url of hymnFiles(one)) if (!keep.has(url)) await cache.delete(url);
        if (shared.length === hymnFiles(one).length) {
            const sharer = others.find((h) => hymnFiles(h).some((url) => shared.includes(url)));
            setDownloadState();
            return toast(`This hymn's music is the same as “${sharer.title}”, which is saved, so it stays saved too.`, 4500);
        }
    } else {
        if (!confirm("Remove every downloaded hymn from this device? They'll download again as you play them.")) return;
        await caches.delete(CONTENT_CACHE);
    }
    track("offline_remove", { scope: one ? "hymn" : "all" });
    setDownloadState();
    toast(one ? "Removed this hymn's download." : "Removed all downloaded hymns.", 2500);
}

const fmtSize = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`);

async function openDownloadPanel() {
    const scope = await downloadScope();
    const all = !downloadHymn;
    const done = !scope.missing.length;
    const anySaved = all ? scope.saved.size > 0 : scope.hymns.some((h) => hymnFiles(h).some((url) => scope.saved.has(url)));
    let usage = "";
    if (all && anySaved) {
        const est = await navigator.storage?.estimate?.().catch(() => null);
        if (est?.usage) usage = ` The app uses about ${fmtSize(est.usage)} on this device.`;
    }
    const text = all
        ? done ? "Every hymn is downloaded, so the app works without internet."
        : `${scope.savedCount} of ${scope.hymns.length} hymns are downloaded for use without internet.`
        : done ? "This hymn is saved on this device, so it plays without internet."
        : "Save this hymn on this device so it plays without internet.";
    downloadPanel.innerHTML = `
        <div class="support-callout-arrow"></div>
        <p class="support-callout-title">${all ? "Offline use" : "Offline use: this hymn"}</p>
        <p class="support-callout-body">${esc(text + usage)}</p>
        <div class="support-callout-actions">
            ${done ? "" : `<button type="button" class="support-callout-btn support-callout-btn-primary" data-offline="download">
                ${all ? (scope.savedCount ? "Download the rest" : "Download all") : "Save this hymn"}</button>`}
            ${anySaved ? `<button type="button" class="support-callout-btn support-callout-btn-secondary" data-offline="remove">
                ${all ? "Remove all downloads" : "Remove from this device"}</button>` : ""}
            <button type="button" class="support-callout-btn support-callout-btn-text" data-offline="close">Close</button>
        </div>
        ${all ? "" : `<p class="download-hint">To download every hymn, use this button on the main page.</p>`}`;
    downloadPanel.classList.add("open");
    // Point the panel's arrow at the download button, however many buttons follow it
    const arrow = downloadPanel.querySelector(".support-callout-arrow");
    const btn = downloadBtn.getBoundingClientRect();
    arrow.style.right = `${Math.round(downloadPanel.getBoundingClientRect().right - (btn.left + btn.width / 2) - 6)}px`;
    setTimeout(() => document.addEventListener("click", downloadOutsideClick), 0);
}

function closeDownloadPanel() {
    downloadPanel.classList.remove("open");
    document.removeEventListener("click", downloadOutsideClick);
}

function downloadOutsideClick(e) {
    if (!downloadPanel.contains(e.target) && !downloadBtn.contains(e.target)) closeDownloadPanel();
}

downloadBtn.addEventListener("click", () => {
    if (downloading) return;
    if (downloadPanel.classList.contains("open")) closeDownloadPanel();
    else openDownloadPanel();
});
downloadPanel.addEventListener("click", (e) => {
    const action = e.target.closest("[data-offline]")?.dataset.offline;
    if (!action) return;
    closeDownloadPanel();
    if (action === "download") download();
    else if (action === "remove") removeDownloads();
});

/** Points the arrow at one hymn (its page) or at every hymn (null). */
function setDownloadScope(hymn) {
    downloadHymn = hymn;
    closeDownloadPanel();
    setDownloadState();
}

// Only offered once the service worker (production builds) is in control;
// on a first visit it takes over a moment after the page loads.
async function showDownloadButton() {
    downloadBtn.hidden = false;
    protectStorage();
    await pruneOldHymns();
    setDownloadState();
}
if (navigator.serviceWorker?.controller) showDownloadButton();
else navigator.serviceWorker?.addEventListener("controllerchange", showDownloadButton, { once: true });

// ---- Install the app (Android and computers) ----------------------------------
// Chrome, Edge and Samsung Internet announce when the site can be installed
// (beforeinstallprompt), on Android and on Windows/Mac/ChromeOS alike. We hold
// on to that and show a big Install button on the list screen, so nobody has to
// find "Install app" in the browser's menu. It never fires once the app is
// installed, or on iPhones (or in Firefox).

let installPrompt = null;
const INSTALL_SNOOZE_DAYS = 14;
// Phones and tablets get a home-screen icon; computers get a windowed app
const HANDHELD = navigator.userAgentData?.mobile || /Android|iPhone|iPad|Mobi/i.test(navigator.userAgent);
const WINDOWS = /Windows/i.test(navigator.userAgentData?.platform || navigator.userAgent);
const INSTALL_TEXT = HANDHELD
    ? {
          title: "Put Let's Sing on your phone",
          body: "Install it like any other app, with its own icon on your home screen.",
          done: "Let's Sing is installed. Look for its icon on your home screen.",
      }
    : {
          title: "Put Let's Sing on this computer",
          body: WINDOWS
              ? "Install it like any other program. It opens in its own window, from your Start menu or taskbar."
              : "Install it like any other program. It opens in its own window, with its own icon.",
          done: WINDOWS
              ? "Let's Sing is installed. Find it in your Start menu, or pin it to the taskbar."
              : "Let's Sing is installed. Find it with your other apps.",
      };

// iPhones and iPads have no install prompt: Apple leaves it to Safari's Share
// menu (behind the ••• button since iOS 26), so there we show a tip instead of
// a button. (iPads report themselves
// as a Mac, but a Mac has no touch screen.)
const IOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const IOS_TIP = IOS && !navigator.standalone && !document.documentElement.classList.contains("embed");
// Chrome on an iPhone keeps its Share button in the address bar instead.
const IOS_CHROME = /CriOS/i.test(navigator.userAgent);
// Apple's Share symbol (a box with an arrow pointing up), drawn inline in the tip.
const SHARE_ICON = `<svg class="share-icon" viewBox="0 0 24 24" role="img" aria-label="Share icon"
    fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 3v12M7.5 7.5 12 3l4.5 4.5"/><path d="M8 10H6.5A1.5 1.5 0 0 0 5 11.5v8A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-8a1.5 1.5 0 0 0-1.5-1.5H16"/></svg>`;

function renderInstallBanner() {
    const slot = document.getElementById("install-slot");
    if (!slot) return;
    const snoozed = Date.now() - store.get("installSnoozed", 0) < INSTALL_SNOOZE_DAYS * 864e5;
    if (IOS_TIP && !snoozed) {
        slot.innerHTML = `
        <div class="install-banner">
            <p class="install-title">Put Let's Sing on your ${/iPad/i.test(navigator.userAgent) || !/iPhone|iPod/i.test(navigator.userAgent) ? "iPad" : "iPhone"}</p>
            <p class="install-body">${IOS_CHROME
                ? `Tap the Share button ${SHARE_ICON} at the right end of the address bar (or <b>•••</b>, then <b>Share</b> ${SHARE_ICON}).`
                : `In Safari, tap the <b>•••</b> button beside the address bar, then <b>Share</b> ${SHARE_ICON}.`}
                Scroll down, tap <b>Add to Home Screen</b>, leave <b>Open as Web App</b> on, and tap <b>Add</b>.</p>
            <div class="install-actions">
                <button type="button" class="install-later" id="install-later">Not now</button>
            </div>
        </div>`;
        document.getElementById("install-later").addEventListener("click", () => {
            store.set("installSnoozed", Date.now());
            renderInstallBanner();
        });
        return;
    }
    if (!installPrompt || snoozed) return (slot.innerHTML = "");
    slot.innerHTML = `
        <div class="install-banner">
            <p class="install-title">${INSTALL_TEXT.title}</p>
            <p class="install-body">${INSTALL_TEXT.body}</p>
            <div class="install-actions">
                <button type="button" class="install-btn" id="install-app">Install app</button>
                <button type="button" class="install-later" id="install-later">Not now</button>
            </div>
        </div>`;
    document.getElementById("install-app").addEventListener("click", async () => {
        const prompt = installPrompt;
        installPrompt = null; // each prompt can only be shown once
        prompt.prompt();
        await prompt.userChoice;
        renderInstallBanner();
    });
    document.getElementById("install-later").addEventListener("click", () => {
        store.set("installSnoozed", Date.now());
        renderInstallBanner();
    });
}

window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault(); // we show our own button instead of Chrome's mini bar
    installPrompt = event;
    renderInstallBanner();
});
window.addEventListener("appinstalled", () => {
    installPrompt = null;
    renderInstallBanner();
    toast(INSTALL_TEXT.done, 4000);
});

// ---- Player screen ----------------------------------------------------------

let frame = 0;
let wakeLock = null;
let learner = null; // Learn mode's microphone, while it's on

/** How far behind the music the singer's voice reaches the app (microphone,
 *  pitch detection and its smoothing), in seconds: each reading is compared
 *  with the note then. */
const LEARN_LAG = 0.16;

const LEARN_ICONS = {
    idle: '<circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2"/>',
    good: '<circle cx="12" cy="12" r="9"/>',
    up: '<path d="M12 3l8 10h-5v8H9v-8H4z"/>',
    down: '<path d="M12 21l-8-10h5V3h6v8h5z"/>',
};

// Ends the hymn page's Learn run, saving its score; set by showHymn
let finishLearnRun = null;
// Ends a Learn lesson page (its microphone and exercise); set by showLessonPage
let leaveLesson = null;

function stopLearning() {
    learner?.stop();
    learner = null;
}

function stopPlayer() {
    cancelAnimationFrame(frame);
    finishLearnRun?.(false); // leaving the hymn: saved, nothing shown
    finishLearnRun = null;
    leaveLesson?.();
    leaveLesson = null;
    stopLearning();
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
    const byId = new Map(hymns.map((h) => [h.id, h]));
    const hymn = byId.get(id);
    stopPlayer();
    setDownloadScope(hymn ?? null);
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
            <div class="hymn-title-row">
                <h2>${esc(hymn.title)}</h2>
                ${starButton(hymn)}
                ${listButton(hymn)}
            </div>
            ${hymn.tunes && !EMBED ? `<div class="tune-pick" role="group" aria-label="Tune">
                <span class="tune-pick-label">Tune</span>
                ${hymn.tunes.map((id) => byId.get(id)).filter(Boolean).map((t) => `<button type="button" data-tune="${t.id}"
                    aria-pressed="${t.id === hymn.id}" title="Sing it to ${esc(t.tune || "this tune")}">${esc(t.tune || `Tune ${t.id}`)}</button>`).join("")}
            </div>` : hymn.tune ? `<p class="tune">${esc(hymn.tune)}</p>` : ""}
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

        ${hymn.score ? `<section class="card score" aria-label="Sheet music">
            <div class="score-head">
                <h3>Music</h3>
                <span class="score-verse" id="score-verse"></span>
                <button class="learn-btn" id="learn" aria-pressed="false"
                        title="Sing along and see how close you are to your part's notes">Learn</button>
                <div class="view-switch" role="group" aria-label="How the music is shown">
                    ${SCORE_VIEWS.map(
                        (v) => `<button data-view="${v.id}" aria-pressed="${v.id === scoreView}" title="${v.title}">${v.name}</button>`
                    ).join("")}
                </div>
            </div>
            <div class="learn-bar" id="learn-bar" hidden>
                <label>Your part
                    <select id="learn-part">
                        ${VOICES.map((v, i) => `<option value="${i}"${i === learnPart ? " selected" : ""}>${v}</option>`).join("")}
                    </select>
                </label>
                <span class="learn-readout" id="learn-readout" role="img"></span>
                <span class="learn-hint" id="learn-hint">Press play and sing</span>
                <span>Use headphones</span>
            </div>
            <div class="learn-result" id="learn-result" hidden></div>
            <div class="score-notation" id="score"></div>
        </section>` : ""}

        <section class="lyrics">
            <h3>Lyrics</h3>
            ${hymn.verses.map((v, i) => `<p data-verse="${i + 1}">${esc(v)}</p>`).join("")}
            ${hymn.credits ? `<p class="credits">${esc(hymn.credits)}</p>` : ""}
        </section>`;

    const $ = (sel) => app.querySelector(sel);
    // Another tune: remembered for this hymn, and opened in this tune's place (so Back
    // still goes to the list)
    app.querySelectorAll("[data-tune]").forEach((b) =>
        b.addEventListener("click", () => {
            const t = byId.get(+b.dataset.tune);
            chooseTune(hymn, t.id);
            if (t.id !== hymn.id) location.replace(`#/hymn/${t.id}`);
        })
    );
    $("[data-fav]").addEventListener("click", (e) => {
        const on = !isFavorite(hymn);
        setFavorite(hymn, on);
        paintStar(e.currentTarget, hymn);
        toast(on ? "Added to favorites" : "Removed from favorites");
    });
    wireListButton(hymn, () => paintStar($("[data-fav]"), hymn));
    const seekEl = $("#seek"), playBtn = $("#play"), stopBtn = $("#stop");
    const posEl = $("#pos"), durEl = $("#dur"), statusEl = $("#status"), playIcon = $("#play-icon");
    let dragging = false;

    // Sheet music: lit from the first press of Play until Stop, like the
    // #doreancon hymnal, so a hymn nobody has played doesn't look mid-phrase
    let score = null, started = false, shownVerse = null;
    app.querySelectorAll("[data-view]").forEach((b) =>
        b.addEventListener("click", () => {
            scoreView = b.dataset.view;
            store.set("scoreView", scoreView);
            app.querySelectorAll("[data-view]").forEach((x) => x.setAttribute("aria-pressed", x === b));
            score?.setView(scoreView);
            paintScore();
        })
    );
    const paintScore = (follow = false) => {
        if (!score) return;
        if (!started) {
            score.clear();
            return showVerse(null);
        }
        const now = player.position();
        score.paint(now, mix.on.map((on, i) => on && mix.volumes[i] > 0), follow);
        showVerse(score.verseAt(now));
        if (learner && player.isPlaying()) {
            let cents = score.trace(now - LEARN_LAG, learnPart, learner.read(), mix.pitch);
            // A note's let-off start isn't graded
            if (score.settling) (run ??= tally()).settle(now - LEARN_LAG), cents = null;
            else (run ??= tally()).add(now - LEARN_LAG, cents === null ? null : score.grade(cents), cents);
            showCents(cents);
        }
    };

    // Learn scores: a run lasts from the first note sung until Stop, the end of
    // the hymn, Learn turned off, another part picked, or leaving the hymn
    let run = null;
    const finishRun = (show = true) => {
        if (!run) return;
        const done = run;
        run = null;
        if (done.seconds() < MIN_SECONDS) {
            if (show) toast("Sing a little longer to get a score.");
            return;
        }
        const round = (v) => Math.round(v * 10) / 10;
        const rec = { hymn: hymn.id, title: hymn.title, part: learnPart, at: Date.now(),
            on: round(done.sums.on), flat: round(done.sums.flat), sharp: round(done.sums.sharp) };
        addRun(rec);
        track("learn_run", { part: PARTS[learnPart], on_pitch: shares(rec).on });
        if (show) showResult(rec);
    };
    finishLearnRun = finishRun;

    /** This run's score (when `rec` is given) and this part's history on this hymn. */
    const showResult = (rec = null) => {
        const box = $("#learn-result");
        if (!box) return;
        const history = loadRuns().filter((r) => r.hymn === hymn.id && r.part === learnPart);
        if (!rec && !history.length) return void (box.hidden = true);
        const ons = history.map((r) => shares(r).on);
        const best = Math.max(...ons);
        const s = rec && shares(rec);
        const isBest = rec && history.length > 1 && s.on >= best;
        box.innerHTML = `
            <div class="learn-result-head">
                <h4>${rec ? "Your score" : "Your progress"} · ${PARTS[learnPart]}</h4>
                <button type="button" class="link-btn" data-close-result>Close</button>
            </div>
            ${rec ? `<p class="learn-big">${s.on}%<span> on pitch${isBest ? " · your best yet" : ""}</span></p>${splitBar(rec)}` : ""}
            ${history.length ? `<p class="learn-sub">${history.length} ${history.length === 1 ? "run" : "runs"} on this hymn · best ${best}% · first ${ons[0]}%</p>` : ""}
            ${history.length > 1 ? `<div class="learn-chart"></div>` : ""}
            <a class="learn-more" href="#/learn">See all your scores and lessons</a>`;
        box.hidden = false;
        box.querySelector("[data-close-result]").addEventListener("click", () => (box.hidden = true));
        const chart = box.querySelector(".learn-chart");
        if (chart) onPitchChart(chart, history);
    };
    // How close the singer is: a green circle on pitch; otherwise an arrow the way
    // to go (up when flat, down when sharp), yellow when close and red when off
    let shownReadout = null;
    const showCents = (cents) => {
        const grade = cents === null ? "idle" : score.grade(cents);
        const key = grade === "learn-good" || grade === "idle" ? grade : `${grade} ${cents > 0 ? "down" : "up"}`;
        if (key === shownReadout) return;
        shownReadout = key;
        $("#learn-hint").hidden = true;
        const out = $("#learn-readout");
        out.className = `learn-readout ${grade}`;
        const [icon, label] =
            grade === "idle" ? [LEARN_ICONS.idle, "Listening"]
            : grade === "learn-good" ? [LEARN_ICONS.good, "On pitch"]
            : cents > 0 ? [LEARN_ICONS.down, "Sharp: sing lower"] : [LEARN_ICONS.up, "Flat: sing higher"];
        out.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>`;
        out.setAttribute("aria-label", label);
        out.title = label;
    };

    // Learn mode: listens through the microphone while it plays (scrolling view)
    $("#learn")?.addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        if (learner) {
            finishRun();
            stopLearning();
            score?.clearTrace();
        } else {
            try {
                const { listen } = await import("./learn.js");
                learner = await listen();
            } catch {
                return toast("Learn needs the microphone. Allow it for this site and try again.", 3500);
            }
            if (scoreView !== "scroll") app.querySelector('[data-view="scroll"]')?.click();
            toast("Wear headphones so the mic hears only you. Your voice stays on this device.", 4000);
            showResult();
        }
        btn.setAttribute("aria-pressed", !!learner);
        $("#learn-bar").hidden = !learner;
        shownReadout = null;
        $("#learn-readout").innerHTML = "";
        $("#learn-hint").hidden = false;
    });
    $("#learn-part")?.addEventListener("change", (e) => {
        finishRun(); // scored as the part it was sung as
        learnPart = +e.target.value;
        store.set("learnPart", learnPart);
        score?.clearTrace();
        if (!$("#learn-result .learn-big")) showResult();
    });
    const showVerse = (verse) => {
        if (verse === shownVerse) return;
        shownVerse = verse;
        // Only when the MIDI plays this hymn's verses one per time through the tune
        if (!hymn.scoreVerses) return;
        $("#score-verse").textContent =
            verse === null ? "" : verse === 0 ? "Introduction" : `Verse ${verse} of ${score.verseCount}`;
        // The lyrics below follow along too
        app.querySelectorAll(".lyrics [data-verse]").forEach((p) =>
            p.classList.toggle("is-current", +p.dataset.verse === verse)
        );
    };

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
        paintScore(player.isPlaying());
        if (player.isPlaying()) frame = requestAnimationFrame(tick);
        else {
            setPlayingUi(false);
            if (player.position() >= player.duration() - 0.25) finishRun(); // the hymn has ended
        }
    };

    $("#play").addEventListener("click", async () => {
        if (player.isPlaying()) {
            player.pause();
            run?.pause();
            setPlayingUi(false);
        } else {
            if (player.position() >= player.duration() - 0.05) player.seek(0);
            await player.play();
            started = true;
            setPlayingUi(true);
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(tick);
        }
    });
    stopBtn.addEventListener("click", () => {
        finishRun();
        player.stop();
        started = false;
        score?.clearTrace();
        paintScore();
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
        paintScore(true);
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
            paintScore();
        })
    );
    app.querySelectorAll("[data-voice]").forEach((el) =>
        el.addEventListener("input", () => {
            const i = +el.dataset.voice;
            mix.volumes[i] = +el.value;
            // Moving the slider of a part that's off turns it back on
            if (!mix.on[i]) $(`[data-toggle="${i}"]`).click();
            applyVoice(i);
            paintScore();
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

    if (hymn.score) {
        // Loaded only here, so the hymn list doesn't wait for the notation library
        import("./score.js")
            .then(({ loadScore }) =>
                loadScore($("#score"), scoreUrl(hymn), { words: hymn.scoreWords, verses: hymn.scoreVerses, view: scoreView, shapes: shapeNotes })
            )
            .then((s) => {
                if (location.hash !== `#/hymn/${id}`) return;
                score = s;
                paintScore();
                setDownloadState(); // opening a hymn saves its files
            })
            .catch(() => app.querySelector(".score")?.remove()); // the player works the same without it
    }

    if (!hymn.midi) {
        statusEl.textContent = "No music file for this hymn yet.";
        return;
    }
    try {
        const loaded = await player.load(midiUrl(hymn));
        if (!loaded || location.hash !== `#/hymn/${id}`) return; // navigated away while loading
        VOICES.forEach((_, i) => applyVoice(i));
        player.setTempo(mix.tempo / 100);
        player.setTranspose(mix.pitch);
        seekEl.max = player.duration();
        durEl.textContent = fmtTime(player.duration());
        seekEl.disabled = playBtn.disabled = stopBtn.disabled = false;
        statusEl.textContent = "";
        setDownloadState();
    } catch (err) {
        // fetch() throws a TypeError when the site can't be reached at all, which
        // happens with Wi-Fi "connected" too (no internet, or the server is down)
        const unreachable = !navigator.onLine || err instanceof TypeError;
        statusEl.textContent = unreachable
            ? "Couldn't reach the site to get this hymn's music, and it hasn't been downloaded for offline use yet."
            : `Couldn't load the music: ${err.message}`;
    }
}

// ---- Support callout (occasional, dismissible ask for financial support) -------
// Same cadence as DA Tool's and BibleSearch's: never on first visit; first
// appears once the app has actually been used (10 visits OR 3 distinct days),
// then resurfaces roughly every 24 days after "Maybe later". Stops popping up
// (the heart itself always stays) after 5 "Maybe later"s, or for good after
// "Don't ask again" or clicking through to support.

const SUPPORT_DAY_MS = 20 * 60 * 60 * 1000;
const SUPPORT_FIRST_VISITS_THRESHOLD = 10;
const SUPPORT_FIRST_DAYS_THRESHOLD = 3;
const SUPPORT_RESHOW_INTERVAL_DAYS = 24;
const SUPPORT_MAX_MAYBE_LATER = 5;
const supportCallout = document.getElementById("support-callout");
const supportLink = document.getElementById("support");

// Google Analytics event, if the GA script loaded (blockers, offline)
function track(name, params = {}) {
    if (typeof gtag === "function") gtag("event", name, params);
}

function trackSupportUsage() {
    if (store.get("supportDismissedForever", false) || store.get("supportActed", false)) return;

    const visits = store.get("supportVisits", 0) + 1;
    store.set("supportVisits", visits);

    let days = store.get("supportDaysUsed", 0);
    const today = new Date().toISOString().slice(0, 10);
    if (store.get("supportLastDayUsed", "") !== today) {
        days += 1;
        store.set("supportDaysUsed", days);
        store.set("supportLastDayUsed", today);
    }

    if (store.get("supportMaybeLaterCount", 0) >= SUPPORT_MAX_MAYBE_LATER) return;
    const lastShown = store.get("supportLastShown", 0);
    const due = lastShown === 0
        ? visits >= SUPPORT_FIRST_VISITS_THRESHOLD || days >= SUPPORT_FIRST_DAYS_THRESHOLD
        : Date.now() - lastShown >= SUPPORT_RESHOW_INTERVAL_DAYS * SUPPORT_DAY_MS;
    // A moment after opening, so it doesn't land on top of the app loading
    if (due) setTimeout(showSupportCallout, 1500);
}

function showSupportCallout() {
    supportCallout.classList.add("open");
    store.set("supportLastShown", Date.now());
    track("support_callout_shown");
    // Dismiss on outside click (doesn't count as "Maybe later" -- just closes it)
    setTimeout(() => document.addEventListener("click", supportOutsideClick), 0);
}

function supportOutsideClick(e) {
    if (supportCallout.contains(e.target) || supportLink.contains(e.target)) return;
    supportCallout.classList.remove("open");
    document.removeEventListener("click", supportOutsideClick);
}

function supportDismiss(mode) {
    supportCallout.classList.remove("open");
    document.removeEventListener("click", supportOutsideClick);
    if (mode === "forever") store.set("supportDismissedForever", true);
    else if (mode === "later") store.set("supportMaybeLaterCount", store.get("supportMaybeLaterCount", 0) + 1);
    else if (mode === "acted") store.set("supportActed", true);
    if (mode === "forever" || mode === "later") track("support_callout_dismiss", { choice: mode });
}

// The church copy (npm run build:church, sing.gracecommunityallentown.org) has no heart,
// and its Home button goes to the church's site.
if (CHURCH) {
    document.querySelector(".support-wrap").remove();
    const home = document.getElementById("home"); // home is the church's site
    home.href = "https://gracecommunityallentown.org/";
    home.title = "gracecommunityallentown.org";
    home.setAttribute("aria-label", "Home: gracecommunityallentown.org");
} else {
    supportLink.addEventListener("click", () => {
        track("support_click", { source: "heart" });
        supportDismiss("acted");
    });
    supportCallout.querySelector('[data-support="acted"]').addEventListener("click", () =>
        track("support_click", { source: "callout" })
    );
    supportCallout.querySelectorAll("[data-support]").forEach((el) =>
        el.addEventListener("click", () => supportDismiss(el.dataset.support))
    );
    if (!EMBED) trackSupportUsage(); // the host app has its own support button
}

// A hymn shouldn't keep singing after you leave the app (as on Android).
// Nor should the microphone stay on: while it is, Android keeps Bluetooth
// headphones in call mode, and other apps (a podcast) aren't heard in them.
document.addEventListener("visibilitychange", () => {
    if (!document.hidden) return;
    if (player.isPlaying()) player.pause();
    if (learner) document.getElementById("learn")?.click(); // Learn off on the hymn's page, its score saved
    leaveLesson?.(); // a lesson's exercise stopped and its mic off; Start opens it again
});

// ---- Embedded in another app (?embed) ------------------------------------------
// Family Worship shows a hymn's player in its own page with
//   <iframe src="https://.../lets-sing/?embed&theme=dark#/hymn/12">
// Only the hymn's page shows, without the top bar, the favorites star or the
// support ask, and Google Analytics isn't loaded (index.html). Any other route
// shows nothing: the host keeps one hidden frame like that to save hymns.
//
// Messages are { source: "lets-sing", type, ... }. To the host:
//   ready   {}                     loaded
//   reply   { re, saved, noMusic, offline }  answers a request: of the asked-for ids,
//                                  those saved on this device and those with no music
//                                  to save; offline = hymns can be saved here at all
//   progress { re, done, total }   files saved so far
// From the host, each with a request number `re`:
//   status { ids }   which of these hymn ids are saved on this device
//   save   { ids }   save these hymns for offline use, then reply as status does
// Hymn ids are strings in messages. Nothing here is private, and the requests only
// fetch Let's Sing's own files, so any page may embed it.

if (EMBED && window.parent !== window) {
    const tell = (msg, target = window.parent, origin = "*") => target.postMessage({ source: "lets-sing", ...msg }, origin);
    // The service worker saves hymns; on a first visit it takes over a moment after load
    const worker = navigator.serviceWorker?.controller ? Promise.resolve(true)
        : !import.meta.env.PROD || !navigator.serviceWorker ? Promise.resolve(false)
        : new Promise((resolve) => {
            navigator.serviceWorker.addEventListener("controllerchange", () => resolve(true), { once: true });
            setTimeout(() => resolve(!!navigator.serviceWorker.controller), 10000);
        });

    const hymnsOf = async (ids) => {
        const want = new Set(ids.map(String));
        return (await hymnsPromise).filter((h) => want.has(String(h.id)));
    };
    const status = async (ids) => {
        const hymns = await hymnsOf(ids);
        const offline = await worker;
        const saved = offline ? await savedFiles() : new Set();
        const has = (h) => hymnFiles(h).length > 0;
        return {
            saved: hymns.filter((h) => has(h) && hymnFiles(h).every((url) => saved.has(url))).map((h) => String(h.id)),
            noMusic: hymns.filter((h) => !has(h)).map((h) => String(h.id)),
            offline,
        };
    };

    window.addEventListener("message", async (e) => {
        const { source, type, re, ids } = e.data ?? {};
        if (source !== "lets-sing-host" || e.source !== window.parent || !Array.isArray(ids)) return;
        const reply = async () => tell({ type: "reply", re, ...(await status(ids)) }, e.source, e.origin);
        if (type === "save" && (await worker)) {
            protectStorage();
            const saved = await savedFiles();
            const missing = [...new Set((await hymnsOf(ids)).flatMap(hymnFiles))].filter((url) => !saved.has(url));
            await fetchAll(missing, (done) => tell({ type: "progress", re, done, total: missing.length }, e.source, e.origin));
        }
        if (type === "save" || type === "status") reply();
    });

    tell({ type: "ready" });
}

// ---- Router -----------------------------------------------------------------

function route() {
    const m = location.hash.match(/^#\/hymn\/(\d+)/);
    if (m) showHymn(+m[1]);
    else if (EMBED) {
        stopPlayer();
        app.innerHTML = "";
    }
    else if (location.hash === "#/favorites/paste") showPaste();
    else if (/^#\/lists\/[\w-]+(\/paste)?$/.test(location.hash)) {
        const [, , id, paste] = location.hash.split("/");
        if (paste && !listById(id)?.fixed) showPaste(id);
        else showList("list", id);
    }
    else if (location.hash === "#/settings") showSettings();
    else if (location.hash === "#/learn" || location.hash === "#/progress") {
        if (location.hash === "#/progress") history.replaceState(null, "", "#/learn");
        showLearn();
    }
    else if (/^#\/learn\/[a-z]+\/\d+$/.test(location.hash)) {
        const [, , trackId, n] = location.hash.split("/");
        showLessonPage(trackId, +n);
    }
    else showList(location.hash.startsWith("#/favorites") ? "favorites" : "all");
}
// Whether the previous history entry is a screen of this app. Opening a shared
// hymn link starts with it false, so Back goes to the list instead of
// leaving for the site the link came from.
let backStaysInApp = false;
window.addEventListener("hashchange", (e) => {
    backStaysInApp = true;
    if (!location.hash.startsWith("#/hymn/")) return route();
    // (Not from a hymn to another of its tunes: the list's place is kept)
    if (!/#\/hymn\//.test(e.oldURL)) listScroll = window.scrollY;
    route();
    window.scrollTo(0, 0);
});
backBtn.addEventListener("click", () => {
    if (backStaysInApp) history.back();
    else location.replace("#/");
});
route();

// ---- Offline support (production builds only) ---------------------------------

// A release installs a new service worker in the background, and it takes over
// at once (sw-template.js). But the open page keeps running the old code and
// hymn list until it reloads, and an installed app can stay open, or resume,
// for days. So when a new worker takes over from an old one, the page quietly
// reloads itself onto the new version. Reloading keeps favorites and settings
// (localStorage) and downloaded hymns (their own cache), so nobody has to clear
// anything.
const UPDATE_CHECK_MS = 30 * 60e3;
let updateWaiting = false;

// Not while someone is on a hymn or lesson (it could be mid-song) or pasting
// favorites; then it waits until they leave that screen or the app.
const busyScreen = () => document.visibilityState === "visible" &&
    /^#\/(hymn\/|learn\/|favorites\/paste|lists\/[\w-]+\/paste)/.test(location.hash);

function applyUpdate() {
    if (updateWaiting && !busyScreen()) location.reload();
}

if (import.meta.env.PROD && "serviceWorker" in navigator) {
    // The first worker only sets up offline use; any later one is an update
    let controlled = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
        updateWaiting = controlled;
        controlled = true;
        applyUpdate();
    });
    window.addEventListener("hashchange", applyUpdate);
    document.addEventListener("visibilitychange", applyUpdate);
    navigator.serviceWorker.register("./sw.js").then((reg) => {
        // Browsers look for a new version only when a page loads, so an app
        // left open (or resumed from the background) looks again itself.
        let lastCheck = Date.now();
        const check = () => {
            if (Date.now() - lastCheck < UPDATE_CHECK_MS || !navigator.onLine) return;
            lastCheck = Date.now();
            reg.update().catch(() => { /* offline or server busy: try next time */ });
        };
        document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && check());
        setInterval(check, UPDATE_CHECK_MS);
    }).catch((e) => console.warn("service worker:", e));
}

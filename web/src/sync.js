// Sign in with Google (optional) to keep favorites, Learn scores and lesson
// progress on every device. Everything still works signed out, kept on this device as
// before; signing in adds this device's progress to the account and brings in
// what other devices saved.
//
// In the cloud (Firestore, free plan), per person:
//   users/<uid>            { favorites: { <hymn id>: { on, at } }, lessons: <lesson progress>,
//                            cleared: <ms> }
//   users/<uid>/runs/<id>  one Learn score each, with t = when it reached the cloud
// Each sync reads only the scores that arrived since the last one, so a long
// history isn't downloaded again on every visit.
import { loadRuns, replaceRuns, runId } from "./progress.js";

const ACCOUNT = "syncAccount"; // { uid, name, email } while signed in; { pending: true } mid-redirect
const LESSONS = "learnLessons"; // src/learnui.js
const FAVORITES = "favorites"; // hymn ids in the order they were added (src/main.js)
const FAV_LOG = "favoritesLog"; // { <hymn id>: { on, at } }: when each was last starred or unstarred
const metaKey = (uid) => `syncMeta:${uid}`;
const RUN_FIELDS = ["hymn", "title", "part", "at", "on", "flat", "sharp"];

const read = (key, fallback) => {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
};
const write = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode / full */ }
};
const drop = (key) => {
    try { localStorage.removeItem(key); } catch { /* nothing to drop */ }
};

/** The signed-in account ({ uid, name, email }), or null. */
export const account = () => {
    const a = read(ACCOUNT, null);
    return a?.uid ? a : null;
};

let fb = null;
const firebase = async () => (fb ??= await import("./firebase.js"));

// "idle" (signed out) | "syncing" | "synced" | "offline" | "error"
let status = "idle";
let lastSynced = 0;
const listeners = new Set();
export const syncStatus = () => ({ account: account(), status, lastSynced });
/** `fn({ account, status, lastSynced, changed })` after every sync; `changed` when this device's data changed. */
export function onSync(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}
const emit = (changed = false) => listeners.forEach((fn) => fn({ ...syncStatus(), changed }));

function setAccount(user) {
    write(ACCOUNT, { uid: user.uid, name: user.displayName ?? "", email: user.email ?? "" });
}

// ---- Signing in and out --------------------------------------------------------

/** Opens Google's sign-in. Resolves true once signed in, false if the singer closed it. */
export async function signIn() {
    const f = await firebase();
    const provider = new f.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    try {
        const cred = await f.signInWithPopup(f.auth, provider);
        setAccount(cred.user);
    } catch (e) {
        if (e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request") return false;
        // Where a popup can't open, go to Google and come back (finished in sync())
        if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") {
            write(ACCOUNT, { pending: true });
            await f.signInWithRedirect(f.auth, provider);
            return false;
        }
        throw e;
    }
    await sync();
    return true;
}

/** Signs out. With `removeHere`, also takes the scores and lesson progress off this device. */
export async function signOut(removeHere = false) {
    const uid = account()?.uid;
    clearTimeout(timer);
    const f = await firebase();
    await f.signOut(f.auth);
    drop(ACCOUNT);
    if (removeHere) {
        replaceRuns([]);
        drop(LESSONS);
        drop(FAVORITES);
        drop(FAV_LOG);
        if (uid) drop(metaKey(uid));
    }
    status = "idle";
    emit(removeHere);
}

// ---- Keeping in step -----------------------------------------------------------

let timer;
/** Something was saved on this device: send it up shortly (a burst of changes goes as one). */
export function changed() {
    if (!account()) return;
    clearTimeout(timer);
    timer = setTimeout(sync, 2000);
}

/** All scores were cleared here: clear them in the account (and so on the other devices) too. */
export function cleared() {
    const a = account();
    if (!a) return;
    write(metaKey(a.uid), { ...read(metaKey(a.uid), {}), cleared: Date.now(), clearPending: true, sent: [] });
    changed();
}

// ---- Favorites ------------------------------------------------------------------
// Each hymn's latest star or unstar wins, so removing a favorite on one device
// removes it on the others too, and the list keeps the order hymns were added.

/** The log of stars, started from this device's list (in its order) the first time. */
function favoritesLog() {
    const log = read(FAV_LOG, {});
    // Any hymn on the list the log hasn't seen counts as starred long ago, in list order
    read(FAVORITES, []).forEach((id, i) => (log[id] ??= { on: true, at: i + 1 }));
    return log;
}

/** The favorites list was changed here to `list`: note what was starred and unstarred. */
export function favoritesChanged(list) {
    // (Not favoritesLog(): `list` is already saved, and its new stars are new, not old)
    const log = read(FAV_LOG, {});
    let at = Date.now();
    const now = new Set(list.map(String));
    for (const [id, e] of Object.entries(log)) if (e.on && !now.has(id)) log[id] = { on: false, at };
    // A millisecond apart, so hymns starred together keep their order
    for (const id of now) if (!log[id]?.on) log[id] = { on: true, at: at++ };
    write(FAV_LOG, log);
    changed();
}

/** Two logs as one: for each hymn, whichever change came last. */
export function mergeFavorites(here, there) {
    const out = { ...there };
    for (const [id, e] of Object.entries(here ?? {})) if (!out[id] || e.at > out[id].at) out[id] = e;
    return out;
}

/** The favorites list a log gives: starred hymns, in the order they were starred. */
const favoritesFrom = (log) => Object.entries(log)
    .filter(([, e]) => e.on).sort((a, b) => a[1].at - b[1].at).map(([id]) => Number(id));

let running = null, again = false;
/** Brings this device and the account into step. Safe to call any time; does nothing signed out. */
export function sync() {
    // Not inside another app's page (?embed): the sign-in there isn't this app's
    if (!read(ACCOUNT, null) || document.documentElement.classList.contains("embed")) return Promise.resolve();
    if (running) {
        again = true;
        return running;
    }
    running = (async () => {
        do {
            again = false;
            await syncOnce();
        } while (again);
    })().finally(() => (running = null));
    return running;
}

async function syncOnce() {
    if (!navigator.onLine) {
        status = "offline";
        return emit();
    }
    status = "syncing";
    emit();
    try {
        const f = await firebase();
        await f.auth.authStateReady();
        const user = f.auth.currentUser;
        if (!user) {
            // Signed out elsewhere, or a sign-in that didn't finish
            drop(ACCOUNT);
            status = "idle";
            return emit();
        }
        if (user.uid !== account()?.uid) setAccount(user); // back from a redirect sign-in
        await syncWith(f, user.uid);
    } catch (e) {
        console.warn("sync:", e);
        status = navigator.onLine ? "error" : "offline";
        emit();
    }
}

/** One sync against Firestore functions `f` (exported for tests, with a stand-in `f`). */
export async function syncWith(f, uid) {
    const meta = { pulled: 0, sent: [], cleared: 0, clearPending: false, ...read(metaKey(uid), {}) };
    const userRef = f.doc(f.db, "users", uid);
    const runsRef = f.collection(userRef, "runs");
    const snap = await f.getDoc(userRef);
    const cloud = snap.exists() ? snap.data() : {};
    let changedHere = false;

    // Scores cleared here (cleared in the account now) or on another device (cleared here too)
    if (meta.clearPending) {
        const old = await f.getDocs(f.query(runsRef, f.where("at", "<=", meta.cleared)));
        await commit(f, old.docs.map((d) => (batch) => batch.delete(d.ref)));
        await f.setDoc(userRef, { cleared: meta.cleared }, { merge: true });
        meta.clearPending = false;
    } else if ((cloud.cleared ?? 0) > meta.cleared) {
        meta.cleared = cloud.cleared;
    }
    let runs = loadRuns();
    const before = runs.length;
    runs = runs.filter((r) => r.at > meta.cleared);
    if (runs.length !== before) changedHere = true;

    // Scores that reached the account since the last sync. A minute's overlap
    // catches any that landed out of order; ones already here are skipped.
    const have = new Set(runs.map(runId));
    const sent = new Set(meta.sent);
    const since = f.Timestamp.fromMillis(Math.max(0, meta.pulled - 60_000));
    const fresh = await f.getDocs(f.query(runsRef, f.where("t", ">", since), f.orderBy("t")));
    for (const d of fresh.docs) {
        const { t, ...run } = d.data();
        if (t) meta.pulled = Math.max(meta.pulled, t.toMillis());
        sent.add(d.id);
        if (run.at > meta.cleared && !have.has(d.id)) {
            runs.push(run);
            have.add(d.id);
            changedHere = true;
        }
    }
    if (changedHere) {
        runs.sort((a, b) => a.at - b.at);
        replaceRuns(runs);
    }

    // This device's scores the account doesn't have yet
    const unsent = runs.filter((r) => !sent.has(runId(r)));
    await commit(f, unsent.map((r) => (batch) => batch.set(f.doc(runsRef, runId(r)), {
        ...Object.fromEntries(RUN_FIELDS.map((k) => [k, r[k]])),
        t: f.serverTimestamp(),
    })));
    unsent.forEach((r) => sent.add(runId(r)));
    meta.sent = runs.map(runId).filter((id) => sent.has(id));

    // Favorites
    const favLog = mergeFavorites(favoritesLog(), cloud.favorites ?? {});
    const favs = favoritesFrom(favLog);
    if (stable(favs) !== stable(read(FAVORITES, []))) {
        write(FAVORITES, favs);
        changedHere = true;
    }
    write(FAV_LOG, favLog);
    if (stable(favLog) !== stable(cloud.favorites ?? {})) await f.setDoc(userRef, { favorites: favLog }, { merge: true });

    // Lesson progress: the best of both
    const local = read(LESSONS, null);
    const merged = mergeLessons(local, cloud.lessons ?? null);
    if (merged) {
        if (stable(merged) !== stable(local)) {
            write(LESSONS, merged);
            changedHere = true;
        }
        // The last track looked at belongs to each device
        const { track, ...shared } = merged;
        if (stable(shared) !== stable(cloud.lessons ?? null)) await f.setDoc(userRef, { lessons: shared }, { merge: true });
    }

    write(metaKey(uid), meta);
    status = "synced";
    lastSynced = Date.now();
    emit(changedHere);
}

/** Runs batched writes (Firestore takes up to 500 per batch). */
async function commit(f, ops) {
    for (let i = 0; i < ops.length; i += 400) {
        const batch = f.writeBatch(f.db);
        ops.slice(i, i + 400).forEach((op) => op(batch));
        await batch.commit();
    }
}

/**
 * Two devices' lesson progress as one: each exercise's best score and whether
 * it was ever passed, every lesson opened on either, the more recently set
 * vocal range, and this device's last-viewed track.
 */
export function mergeLessons(here, there) {
    if (!here) return there;
    if (!there) return here;
    const best = { ...there.best };
    for (const [k, v] of Object.entries(here.best ?? {})) {
        const w = best[k];
        best[k] = w ? { on: Math.max(v.on ?? 0, w.on ?? 0), passed: !!(v.passed || w.passed) } : v;
    }
    const newerRange = (there.rangeAt ?? 0) > (here.rangeAt ?? 0) ? there : here;
    const out = { ...there, ...here, best, open: { ...there.open, ...here.open } };
    if (newerRange.range) {
        out.range = newerRange.range;
        out.rangeAt = newerRange.rangeAt ?? 0;
    }
    return out;
}

/** JSON with keys in order, so the same progress always compares equal. */
function stable(v) {
    if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
    if (v && typeof v === "object") {
        return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
    }
    return JSON.stringify(v ?? null);
}

// Catch up when the app comes back to the screen or back online
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && Date.now() - lastSynced > 60_000) sync();
});
addEventListener("online", () => sync());

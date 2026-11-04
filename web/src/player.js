// Playback engine: the web counterpart of audio/MidiEngine.kt + native-lib.cpp.
// SpessaSynth renders the MIDI through the trimmed soundfont in an
// AudioWorklet (its own audio thread). Channel mapping is the app's usual
// 0=Soprano, 1=Alto, 2=Tenor, 3=Bass.
import { WorkletSynthesizer, Sequencer } from "spessasynth_lib";
import processorUrl from "spessasynth_lib/dist/spessasynth_processor.min.js?url";

export const VOICES = ["Soprano", "Alto", "Tenor", "Bass"];

// General MIDI programs; keep in step with PROGRAMS in scripts/build-soundfont.mjs
export const INSTRUMENTS = [
    { id: "piano", name: "Piano", program: 0 },
    { id: "organ", name: "Organ", program: 19 },
    { id: "guitar", name: "Guitar", program: 24 },
    { id: "choir", name: "Choir", program: 52 },
];
const DRUM_CHANNEL = 9;

let ctx, synth, seq;
let initPromise;
let program = INSTRUMENTS[0].program;
let soundfont; // kept so a rebuilt engine needn't fetch it again
// What the loaded song is set to, so a rebuilt engine can carry on the same
let song = null, tempo = 1, transpose = 0;
const gains = [];
// Set when the microphone turned on or off (see renewOutput)
let stale = false;
// Whether the app wants sound now: a rebuild finishing late mustn't restart a stopped hymn
let wanted = false;

// Created on first use: browsers only allow audio to start from a user action,
// and the soundfont download is skipped entirely for people who only browse.
function init() {
    initPromise ??= (async () => {
        // iPhones otherwise treat web audio like a ringtone: silent whenever
        // the ring/silent switch is on silent (Safari 17+ understands this)
        if (navigator.audioSession) navigator.audioSession.type = "playback";
        ctx = new AudioContext();
        await ctx.audioWorklet.addModule(processorUrl);
        synth = new WorkletSynthesizer(ctx);
        synth.connect(ctx.destination);
        soundfont ??= await (await fetch("./soundfont/instruments.sf2")).arrayBuffer();
        await synth.soundBankManager.addSoundBank(soundfont.slice(0), "instruments");
        await synth.isReady;
        seq = new Sequencer(synth, { skipToFirstNoteOn: false });
        seq.loopCount = 0;
        if (import.meta.env.DEV) window.__engine = { ctx, synth, seq };
    })();
    return initPromise;
}

let loading = Promise.resolve();
let latestLoad = 0;

/** Loads a hymn's MIDI file (its URL from midiUrl() in main.js), paused at the start.
 *  Resolves false when another hymn was opened before this one got its turn. */
export function load(url) {
    // One at a time: two songs loading at once would answer each other's
    // "loaded" event, and a hymn could show the other one's length.
    const ticket = ++latestLoad;
    const run = loading.then(async () => {
        if (ticket !== latestLoad) return false;
        await init();
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Couldn't load the music (${res.status})`);
        const binary = await res.arrayBuffer();
        if (ticket !== latestLoad) return false;
        song = { binary, url };
        await loadSong(0);
        return true;
    });
    loading = run.catch(() => {});
    return run;
}

// Puts `song` into the sequencer, paused at `at` seconds, with its settings
async function loadSong(at) {
    const loaded = new Promise((resolve) =>
        seq.eventHandler.addEvent("songChange", "load", () => resolve())
    );
    seq.loadNewSongList([{ binary: song.binary.slice(0), fileName: song.url }]);
    await loaded;
    seq.pause();
    seq.currentTime = at;
    applyInstrument();
    gains.forEach((g, c) => g !== undefined && synth.midiChannels[c]?.setSystemParameter("gain", g));
    seq.playbackRate = tempo;
    synth.setSystemParameter("keyShift", transpose);
}

/** Call when the microphone turns on or off. On Android, Bluetooth headphones
 *  switch between music and phone-call mode then, and the audio output
 *  already open can stay silent from that point on, even for ordinary hymns.
 *  The engine is built afresh on whatever route is current: now if a hymn is
 *  playing, else on the next play. */
export async function renewOutput() {
    if (!ctx) return;
    if (!isPlaying()) {
        stale = true;
        return;
    }
    stale = false;
    await rebuild();
    if (!wanted) return; // paused or left while it was being rebuilt
    await ctx.resume().catch(() => {});
    seq.play();
}

// A new AudioContext and synthesizer, carrying on from the same place in the same song
function rebuild() {
    const run = loading.then(async () => {
        const at = position();
        seq?.pause();
        await ctx?.close().catch(() => {});
        ctx = synth = seq = undefined;
        initPromise = null;
        await init();
        if (song) await loadSong(at);
    });
    loading = run.catch(() => {});
    return run;
}

/** Plays every part on one instrument (a GM program from INSTRUMENTS). */
export function setInstrument(gmProgram) {
    program = gmProgram;
    applyInstrument();
}

// Every file's own program changes (mostly Grand Piano) are overridden: the
// preset lock makes each channel ignore them until we unlock it here.
function applyInstrument() {
    if (!synth) return;
    synth.midiChannels.forEach((channel, i) => {
        if (i === DRUM_CHANNEL) return;
        channel.setSystemParameter("presetLock", false);
        synth.programChange(i, program);
        channel.setSystemParameter("presetLock", true);
    });
}

export async function play() {
    wanted = true;
    await init();
    await ctx.resume().catch(() => {});
    // Stale after the microphone changed, or stuck after the system took the audio away
    if (stale || ctx.state !== "running") {
        stale = false;
        await rebuild();
        await ctx.resume().catch(() => {});
    }
    seq.play();
}

export function pause() {
    wanted = false;
    seq?.pause();
}

export function stop() {
    wanted = false;
    if (!seq) return;
    seq.pause();
    seq.currentTime = 0;
}

export const isPlaying = () => !!seq && !seq.paused && !seq.isFinished;
export const duration = () => seq?.duration ?? 0;
export const position = () => (seq ? Math.min(seq.currentHighResolutionTime, seq.duration) : 0);

export function seek(seconds) {
    if (seq) seq.currentTime = seconds;
}

/** Seconds into the loaded hymn where the parts first sing together: past
 *  an introduction played on the melody alone. 0 when it starts in harmony. */
export async function harmonyStart() {
    const midi = await seq.getMIDI();
    const onsets = new Map(); // tick -> SATB channels starting a note there
    const first = []; // each part's first note
    for (const track of midi.tracks) {
        for (const e of track.events) {
            const ch = e.statusByte & 0x0f;
            if ((e.statusByte & 0xf0) !== 0x90 || ch > 3 || !e.data[1]) continue;
            (onsets.get(e.ticks) ?? onsets.set(e.ticks, new Set()).get(e.ticks)).add(ch);
            first[ch] = Math.min(first[ch] ?? Infinity, e.ticks);
        }
    }
    const parts = first.filter((t) => t !== undefined).length;
    if (parts < 2) return 0;
    // The first chord with (nearly) every part in it; failing that, where the last part comes in
    const needed = Math.min(3, parts);
    const chord = [...onsets].filter(([, chs]) => chs.size >= needed).map(([t]) => t);
    const tick = chord.length ? Math.min(...chord) : Math.max(...first.filter((t) => t !== undefined));
    return tick > 0 ? midi.midiTicksToSeconds(tick) : 0;
}

/** volume: 0..1 for one SATB voice (channel gain, so the file's own CC7 can't override it).
 *  0 silences the part immediately, including notes already sounding. */
export function setVoiceVolume(voice, volume) {
    gains[voice] = volume;
    synth?.midiChannels[voice]?.setSystemParameter("gain", volume);
}

/** scale: 0.5..1.5, symbolic tempo change -- pitch is unaffected. */
export function setTempo(scale) {
    tempo = scale;
    if (seq) seq.playbackRate = scale;
}

/** semitones: -6..6 from the hymn's own key. */
export function setTranspose(semitones) {
    transpose = semitones;
    synth?.setSystemParameter("keyShift", semitones);
}

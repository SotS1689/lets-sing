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

// Created on first use: browsers only allow audio to start from a user action,
// and the soundfont download is skipped entirely for people who only browse.
function init() {
    initPromise ??= (async () => {
        ctx = new AudioContext();
        await ctx.audioWorklet.addModule(processorUrl);
        synth = new WorkletSynthesizer(ctx);
        synth.connect(ctx.destination);
        const sf = await (await fetch("./soundfont/instruments.sf2")).arrayBuffer();
        await synth.soundBankManager.addSoundBank(sf, "instruments");
        await synth.isReady;
        seq = new Sequencer(synth, { skipToFirstNoteOn: false });
        seq.loopCount = 0;
        if (import.meta.env.DEV) window.__engine = { ctx, synth, seq };
    })();
    return initPromise;
}

/** Loads a hymn's MIDI file, paused at the start. */
export async function load(midiFile) {
    await init();
    const res = await fetch(`./midi/${encodeURIComponent(midiFile)}`);
    if (!res.ok) throw new Error(`Couldn't load the music (${res.status})`);
    const binary = await res.arrayBuffer();
    const loaded = new Promise((resolve) =>
        seq.eventHandler.addEvent("songChange", "load", () => resolve())
    );
    seq.loadNewSongList([{ binary, fileName: midiFile }]);
    await loaded;
    seq.pause();
    seq.currentTime = 0;
    applyInstrument();
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
    await init();
    await ctx.resume();
    seq.play();
}

export function pause() {
    seq?.pause();
}

export function stop() {
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

/** volume: 0..1 for one SATB voice (channel gain, so the file's own CC7 can't override it).
 *  0 silences the part immediately, including notes already sounding. */
export function setVoiceVolume(voice, volume) {
    synth?.midiChannels[voice]?.setSystemParameter("gain", volume);
}

/** scale: 0.5..1.5, symbolic tempo change -- pitch is unaffected. */
export function setTempo(scale) {
    if (seq) seq.playbackRate = scale;
}

/** semitones: -6..6 from the hymn's own key. */
export function setTranspose(semitones) {
    synth?.setSystemParameter("keyShift", semitones);
}

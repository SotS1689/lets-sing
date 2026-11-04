// Learn mode: listens to the singer through the microphone and says what pitch
// they're on, many times a second. Everything happens on this device: the
// audio is analysed in the browser and never stored or sent anywhere.
// Pitch detection is pitchy (MIT, github.com/ianprime0509/pitchy), the McLeod
// pitch method, which is quick enough for a tuner.
import { PitchDetector } from "pitchy";
import { renewOutput } from "./player.js";

/** Samples looked at for each reading: about 43 ms at 48 kHz, enough for a bass's low notes. */
const WINDOW = 2048;
/** Below this, pitchy isn't sure it heard a note (a breath, an "s", the room). */
const MIN_CLARITY = 0.85;
/** Below this loudness (RMS) it's taken as silence. */
const MIN_LEVEL = 0.01;
/** Smoothing: the middle of this many readings (drops a stray octave or
 *  consonant), then each reading moves the line this share of the way. */
const MEDIAN_OF = 7, EASE = 0.2;
/** A jump bigger than this (semitones) is a new note: the line follows at once. */
const NEW_NOTE = 1.5;
/** Up to this many unclear readings in a row (a consonant, a wobble) keep the
 *  line going where it was; more is a breath or a rest. */
const GAP = 4;

/** On Android with Bluetooth headphones, the phone's own microphone. Chrome's
 *  default there is the headphones' mic, which puts them in phone-call mode,
 *  and then nothing the app plays is heard in them. The phone's mics
 *  ("Speakerphone", "Headset earpiece") leave them playing music.
 *  Null elsewhere, or before the microphone is allowed (names are hidden). */
async function phoneMicId() {
    if (!/Android/i.test(navigator.userAgent)) return null;
    try {
        const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
        if (!inputs.some((d) => /bluetooth/i.test(d.label))) return null;
        const phone = inputs.find((d) => /speakerphone/i.test(d.label))
            ?? inputs.find((d) => /earpiece/i.test(d.label));
        return phone?.deviceId || null;
    } catch {
        return null;
    }
}

/** Asks for the microphone and starts listening. Rejects when it's refused or there is none. */
export async function listen() {
    // The browser's own call-cleaning bends and gates a singing voice
    const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    const open = (id) => navigator.mediaDevices.getUserMedia({ audio: id ? { ...audio, deviceId: { exact: id } } : audio });
    let phoneMic = await phoneMicId();
    let stream = await open(phoneMic).catch(() => open(null));
    // Microphone names are only known once it's allowed: on the first time, look again
    if (!phoneMic && (phoneMic = await phoneMicId())) {
        const phone = await open(phoneMic).catch(() => null);
        if (phone) {
            stream.getTracks().forEach((t) => t.stop());
            stream = phone;
        }
    }
    renewOutput(); // the audio route may have changed
    const ctx = new AudioContext();
    await ctx.resume().catch(() => {}); // started suspended when not opened by a tap
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = WINDOW;
    source.connect(analyser);
    const input = new Float32Array(WINDOW);
    const detector = PitchDetector.forFloat32Array(WINDOW);
    let recent = [], smooth = null, misses = 0;

    return {
        /** The pitch being sung now as a MIDI note number with fraction (60 = middle C,
         *  60.5 = a quarter-tone sharp of it), or null when nothing clear is heard. */
        read() {
            const raw = this.raw();
            if (raw === null) {
                if (++misses <= GAP) return smooth;
                recent = [];
                return (smooth = null);
            }
            misses = 0;
            recent.push(raw);
            if (recent.length > MEDIAN_OF) recent.shift();
            const middle = [...recent].sort((a, b) => a - b)[recent.length >> 1];
            smooth = smooth === null || Math.abs(middle - smooth) > NEW_NOTE ? middle : smooth + (middle - smooth) * EASE;
            return smooth;
        },
        /** One reading, unsmoothed. */
        raw() {
            analyser.getFloatTimeDomainData(input);
            let sum = 0;
            for (const v of input) sum += v * v;
            if (Math.sqrt(sum / WINDOW) < MIN_LEVEL) return null;
            const [hz, clarity] = detector.findPitch(input, ctx.sampleRate);
            // Voices sing from about 70 Hz (a low bass D) to 1100 Hz (a high soprano C)
            if (clarity < MIN_CLARITY || hz < 60 || hz > 1200) return null;
            return 69 + 12 * Math.log2(hz / 440);
        },
        stop() {
            stream.getTracks().forEach((t) => t.stop());
            ctx.close().catch(() => {});
            renewOutput(); // and back to music mode
        },
    };
}

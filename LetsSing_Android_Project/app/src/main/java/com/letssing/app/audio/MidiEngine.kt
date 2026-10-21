package com.letssing.app.audio

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Kotlin-facing wrapper around a small TinySoundFont/TinyMidiLoader JNI
 * bridge (see cpp/native-lib.cpp). One MidiEngine == one synth instance +
 * one loaded MIDI file, with its own real-time AAudio playback loop.
 *
 * Voice/channel mapping: OpenHymnal's ABC source assigns SATB voices to
 * MIDI channels 0-3 in this fixed order -- confirmed two ways: (1) against
 * the raw ABC `V:` headers (S1V1=soprano, S1V2=alto, S2V1=tenor,
 * S2V2=bass), and (2) empirically, by inspecting a real downloaded file
 * (Abide_With_Me-Eventide.mid) and checking each channel's average note
 * pitch -- channel 0 was highest (67.3), descending to channel 3 lowest
 * (48.3), exactly S/A/T/B order. Only checked on that one file; worth a
 * spot-check on a few more before fully trusting it across all 338 hymns.
 */
class MidiEngine {

    enum class Voice(val channel: Int) {
        SOPRANO(0), ALTO(1), TENOR(2), BASS(3)
    }

    private var handle: Long = 0L

    private val _isPlaying = MutableStateFlow(false)
    val isPlaying: StateFlow<Boolean> = _isPlaying

    /** 0.0..1.0 fraction through the current file. Updated by [pollPosition]. */
    private val _progress = MutableStateFlow(0f)
    val progress: StateFlow<Float> = _progress

    /**
     * Must be called once, off the main thread, before load()/play().
     * [soundfontPath] is an absolute filesystem path -- copy the .sf2/.sf3
     * asset to internal storage first (the underlying tsf_load_filename
     * call needs a real file path, not an AssetManager stream). See
     * MainActivity's asset-copy helper.
     */
    fun init(soundfontPath: String) {
        handle = nativeInit(soundfontPath)
        check(handle != 0L) { "Audio engine failed to initialize with soundfont: $soundfontPath" }
    }

    /** [midiPath] is likewise an absolute filesystem path (copied from assets/midi/). */
    fun load(midiPath: String): Boolean {
        stop()
        return nativeLoadMidi(handle, midiPath)
    }

    fun play() {
        nativePlay(handle)
        _isPlaying.value = true
    }

    fun pause() {
        nativePause(handle)
        _isPlaying.value = false
    }

    fun stop() {
        nativeStop(handle)
        _isPlaying.value = false
        _progress.value = 0f
    }

    fun seekFraction(fraction: Float) {
        val total = nativeGetDurationMillis(handle)
        if (total <= 0) return
        nativeSeek(handle, (fraction.coerceIn(0f, 1f) * total).toInt())
    }

    /**
     * Sets one voice part's volume via a live MIDI CC7 (channel volume)
     * message -- this is the mechanism behind each SATB slider.
     * [volume] is 0..127 (standard MIDI CC range); the UI slider should
     * map its 0f..1f range onto this before calling.
     */
    fun setVoiceVolume(voice: Voice, volume: Int) {
        nativeSetChannelVolume(handle, voice.channel, volume.coerceIn(0, 127))
    }

    /**
     * Sets absolute playback tempo as a multiplier on the file's own
     * pace: 1.0 = the hymn's own notated speed, 0.5 = half speed, 1.5 =
     * one-and-a-half speed. This is symbolic MIDI-timeline scaling, not
     * audio time-stretching -- zero pitch artifacts at any scale.
     */
    fun setTempoScale(scale: Double) {
        nativeSetTempoScale(handle, scale)
    }

    /**
     * Transposes playback by [semitones] (positive = higher, negative =
     * lower), independent of tempo. Applied at the note-key level, so it's
     * exact and artifact-free -- this is a MIDI synth, not recorded audio.
     */
    fun setTranspose(semitones: Int) {
        nativeSetTranspose(handle, semitones)
    }

    /** Call periodically (e.g. every 250ms) from a UI-driven coroutine to update [progress]. */
    fun pollPosition() {
        val total = nativeGetDurationMillis(handle)
        if (total <= 0) return
        val current = nativeGetCurrentMillis(handle)
        _progress.value = (current.toFloat() / total.toFloat()).coerceIn(0f, 1f)
        _isPlaying.value = nativeIsPlaying(handle)
    }

    fun release() {
        nativeRelease(handle)
        handle = 0L
    }

    // ---- JNI bridge (see cpp/native-lib.cpp) ----
    private external fun nativeInit(soundfontPath: String): Long
    private external fun nativeLoadMidi(handle: Long, midiPath: String): Boolean
    private external fun nativePlay(handle: Long)
    private external fun nativePause(handle: Long)
    private external fun nativeStop(handle: Long)
    private external fun nativeSeek(handle: Long, millis: Int)
    private external fun nativeSetChannelVolume(handle: Long, channel: Int, volume: Int)
    private external fun nativeSetTempoScale(handle: Long, scale: Double)
    private external fun nativeSetTranspose(handle: Long, semitones: Int)
    private external fun nativeGetDurationMillis(handle: Long): Int
    private external fun nativeGetCurrentMillis(handle: Long): Int
    private external fun nativeIsPlaying(handle: Long): Boolean
    private external fun nativeRelease(handle: Long)

    companion object {
        init {
            System.loadLibrary("letssing_audio")
        }
    }
}

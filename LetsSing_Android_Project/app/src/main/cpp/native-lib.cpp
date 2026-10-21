// native-lib.cpp
//
// Audio engine for Let's Sing, built on:
//   - TinySoundFont (tsf.h): SoundFont synthesis, single header, MIT license
//   - TinyMidiLoader (tml.h): SMF parsing, single header, MIT license
//   - AAudio (NDK, API 26+): low-latency audio output
//
// No external dependencies to build or vendor beyond the two headers
// above -- see CMakeLists.txt for why this replaced an earlier
// FluidSynth-based plan.
//
// We own the entire playback loop (rather than relying on a library's
// built-in "player"), which is what makes tempo control simple and
// precise: tempo is just a multiplier on how fast we advance through
// the MIDI message timeline relative to real audio time. No absolute
// BPM bookkeeping needed on the Kotlin side.
//
// SATB channel volume: TML_CONTROL_CHANGE messages and our own explicit
// tsf_channel_midi_control(..., 7, volume) calls both go through the
// same standard MIDI CC7 "channel volume" mechanism.

#include <jni.h>
#include <aaudio/AAudio.h>
#include <android/log.h>
#include <mutex>
#include <atomic>
#include <cstring>

#define TSF_IMPLEMENTATION
#include "tsf.h"
#define TML_IMPLEMENTATION
#include "tml.h"

#define LOG_TAG "LetsSingAudio"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace {

constexpr int kChannelCount = 2; // stereo output
constexpr int kMaxVoices = 64;
// Acoustic Grand Piano (GM program 0) -- explicitly forced on every channel at
// load time regardless of what the file's own Program Change events say.
// (OpenHymnal's files default to program 0 / Grand Piano; we keep it as piano).
// Change this constant to try a different default instrument.
constexpr int kDefaultGmProgram = 0;

struct EngineState {
    tsf* synth = nullptr;
    tml_message* midiHead = nullptr;
    tml_message* nextMessage = nullptr;

    std::mutex mutex; // guards synth + message-list state, shared with the audio callback

    std::atomic<bool> isPlaying{false};
    std::atomic<unsigned int> songTimeMs{0};
    std::atomic<float> tempoScale{1.0f};
    std::atomic<int> transposeSemitones{0};
    unsigned int totalDurationMs = 0;

    AAudioStream* stream = nullptr;
    int32_t sampleRate = 44100;
};

EngineState* asState(jlong handle) {
    return reinterpret_cast<EngineState*>(handle);
}

/** Applies all pending messages up to targetMs. If [audible] is false, no
 *  audio is rendered for this span -- used when seeking, so we arrive at
 *  the target position with correct voice/channel state but without
 *  producing sound for the skipped-over span. Caller must hold state->mutex. */
void advanceMessagesLocked(EngineState* state, unsigned int targetMs) {
    int transpose = state->transposeSemitones.load();
    while (state->nextMessage && state->nextMessage->time <= targetMs) {
        tml_message* msg = state->nextMessage;
        switch (msg->type) {
            case TML_NOTE_ON: {
                // Transpose applied at the key level (rather than via
                // pitch-bend) so it doesn't fight with the file's own
                // TML_PITCH_BEND events, and note-off below matches by
                // shifting the same way.
                int key = msg->key + transpose;
                if (key >= 0 && key <= 127) {
                    tsf_channel_note_on(state->synth, msg->channel, key, msg->velocity / 127.0f);
                }
                break;
            }
            case TML_NOTE_OFF: {
                int key = msg->key + transpose;
                if (key >= 0 && key <= 127) {
                    tsf_channel_note_off(state->synth, msg->channel, key);
                }
                break;
            }
            case TML_CONTROL_CHANGE:
                tsf_channel_midi_control(state->synth, msg->channel, msg->control, msg->control_value);
                break;
            case TML_PITCH_BEND:
                tsf_channel_set_pitchwheel(state->synth, msg->channel, msg->pitch_bend);
                break;
            case TML_PROGRAM_CHANGE:
                // Intentionally ignored -- see kDefaultGmProgram above.
                break;
            default:
                break;
        }
        state->nextMessage = msg->next;
    }
}

aaudio_data_callback_result_t audioDataCallback(
    AAudioStream* /*stream*/, void* userData, void* audioData, int32_t numFrames) {

    auto* state = static_cast<EngineState*>(userData);
    auto* out = static_cast<short*>(audioData);

    std::lock_guard<std::mutex> lock(state->mutex);

    if (!state->isPlaying.load() || !state->synth) {
        std::memset(out, 0, sizeof(short) * numFrames * kChannelCount);
        return AAUDIO_CALLBACK_RESULT_CONTINUE;
    }

    double frameMs = 1000.0 * numFrames / state->sampleRate;
    unsigned int newSongTimeMs = state->songTimeMs.load() +
        static_cast<unsigned int>(frameMs * state->tempoScale.load());

    advanceMessagesLocked(state, newSongTimeMs);
    state->songTimeMs.store(newSongTimeMs);

    tsf_render_short(state->synth, out, numFrames, 0);

    if (!state->nextMessage && newSongTimeMs >= state->totalDurationMs) {
        state->isPlaying.store(false); // reached end of hymn
    }

    return AAUDIO_CALLBACK_RESULT_CONTINUE;
}

} // namespace

extern "C" JNIEXPORT jlong JNICALL
Java_com_letssing_app_audio_MidiEngine_nativeInit(JNIEnv* env, jobject, jstring jSoundfontPath) {
    auto* state = new EngineState();

    const char* soundfontPath = env->GetStringUTFChars(jSoundfontPath, nullptr);
    state->synth = tsf_load_filename(soundfontPath);
    env->ReleaseStringUTFChars(jSoundfontPath, soundfontPath);

    if (!state->synth) {
        LOGE("Failed to load soundfont");
        delete state;
        return 0;
    }
    tsf_set_max_voices(state->synth, kMaxVoices);

    // --- Open the AAudio stream first, so we know the real negotiated
    //     sample rate before configuring tsf's output. ---
    AAudioStreamBuilder* builder = nullptr;
    if (AAudio_createStreamBuilder(&builder) != AAUDIO_OK || !builder) {
        LOGE("Failed to create AAudio stream builder");
        tsf_close(state->synth);
        delete state;
        return 0;
    }

    AAudioStreamBuilder_setFormat(builder, AAUDIO_FORMAT_PCM_I16);
    AAudioStreamBuilder_setChannelCount(builder, kChannelCount);
    AAudioStreamBuilder_setPerformanceMode(builder, AAUDIO_PERFORMANCE_MODE_LOW_LATENCY);
    AAudioStreamBuilder_setDataCallback(builder, audioDataCallback, state);

    aaudio_result_t openResult = AAudioStreamBuilder_openStream(builder, &state->stream);
    AAudioStreamBuilder_delete(builder);

    if (openResult != AAUDIO_OK || !state->stream) {
        LOGE("Failed to open AAudio stream: %d", openResult);
        tsf_close(state->synth);
        delete state;
        return 0;
    }

    state->sampleRate = AAudioStream_getSampleRate(state->stream);
    tsf_set_output(state->synth, TSF_STEREO_INTERLEAVED, state->sampleRate, 0.0f);

    AAudioStream_requestStart(state->stream);
    // Stream runs continuously from here on; audioDataCallback outputs
    // silence whenever isPlaying is false, rather than stopping/starting
    // the stream per play/pause (simpler, avoids AAudio start-latency
    // hiccups -- costs a small amount of idle battery use).

    return reinterpret_cast<jlong>(state);
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_letssing_app_audio_MidiEngine_nativeLoadMidi(JNIEnv* env, jobject, jlong handle, jstring jMidiPath) {
    auto* state = asState(handle);
    if (!state) return JNI_FALSE;

    const char* midiPath = env->GetStringUTFChars(jMidiPath, nullptr);
    tml_message* messages = tml_load_filename(midiPath);
    env->ReleaseStringUTFChars(jMidiPath, midiPath);

    if (!messages) {
        LOGE("Failed to load MIDI file");
        return JNI_FALSE;
    }

    std::lock_guard<std::mutex> lock(state->mutex);

    if (state->midiHead) {
        tml_free(state->midiHead);
    }
    state->midiHead = messages;
    state->nextMessage = messages;
    state->songTimeMs.store(0);

    int usedChannels = 0, usedPrograms = 0, totalNotes = 0;
    unsigned int timeFirstNote = 0, timeLength = 0;
    tml_get_info(messages, &usedChannels, &usedPrograms, &totalNotes, &timeFirstNote, &timeLength);
    state->totalDurationMs = timeLength;

    // Silence any voices left over from a previously loaded hymn, and
    // force every SATB channel (0-3) onto our chosen default instrument
    // -- see kDefaultGmProgram.
    for (int ch = 0; ch < 16; ch++) {
        tsf_channel_sounds_off_all(state->synth, ch);
    }
    for (int ch = 0; ch < 4; ch++) {
        tsf_channel_set_presetnumber(state->synth, ch, kDefaultGmProgram, 0);
    }

    return JNI_TRUE;
}

extern "C" JNIEXPORT void JNICALL
Java_com_letssing_app_audio_MidiEngine_nativePlay(JNIEnv*, jobject, jlong handle) {
    auto* state = asState(handle);
    if (state) state->isPlaying.store(true);
}

extern "C" JNIEXPORT void JNICALL
Java_com_letssing_app_audio_MidiEngine_nativePause(JNIEnv*, jobject, jlong handle) {
    auto* state = asState(handle);
    if (state) state->isPlaying.store(false); // songTimeMs is left as-is -- true pause, not stop
}

extern "C" JNIEXPORT void JNICALL
Java_com_letssing_app_audio_MidiEngine_nativeStop(JNIEnv*, jobject, jlong handle) {
    auto* state = asState(handle);
    if (!state) return;

    std::lock_guard<std::mutex> lock(state->mutex);
    state->isPlaying.store(false);
    state->songTimeMs.store(0);
    state->nextMessage = state->midiHead;
    for (int ch = 0; ch < 16; ch++) {
        tsf_channel_sounds_off_all(state->synth, ch);
    }
}

extern "C" JNIEXPORT void JNICALL
Java_com_letssing_app_audio_MidiEngine_nativeSeek(JNIEnv*, jobject, jlong handle, jint targetMs) {
    auto* state = asState(handle);
    if (!state) return;

    std::lock_guard<std::mutex> lock(state->mutex);
    unsigned int target = targetMs < 0 ? 0
        : (static_cast<unsigned int>(targetMs) > state->totalDurationMs ? state->totalDurationMs
                                                                          : static_cast<unsigned int>(targetMs));

    if (target < state->songTimeMs.load()) {
        // Seeking backward: replay from the start so channel/voice state
        // (which notes are sounding, any CC changes) is correct at the
        // target position. This does not produce audible output for the
        // skipped span -- see advanceMessagesLocked doc comment.
        for (int ch = 0; ch < 16; ch++) {
            tsf_channel_sounds_off_all(state->synth, ch);
        }
        state->nextMessage = state->midiHead;
    }
    advanceMessagesLocked(state, target);
    state->songTimeMs.store(target);
}

extern "C" JNIEXPORT void JNICALL
Java_com_letssing_app_audio_MidiEngine_nativeSetChannelVolume(JNIEnv*, jobject, jlong handle, jint channel, jint volume) {
    auto* state = asState(handle);
    if (!state) return;
    std::lock_guard<std::mutex> lock(state->mutex);
    // CC7 = standard MIDI "channel volume" controller (0-127).
    tsf_channel_midi_control(state->synth, channel, 7, volume);
}

extern "C" JNIEXPORT void JNICALL
Java_com_letssing_app_audio_MidiEngine_nativeSetTempoScale(JNIEnv*, jobject, jlong handle, jdouble scale) {
    auto* state = asState(handle);
    if (state) state->tempoScale.store(static_cast<float>(scale));
}

extern "C" JNIEXPORT void JNICALL
Java_com_letssing_app_audio_MidiEngine_nativeSetTranspose(JNIEnv*, jobject, jlong handle, jint semitones) {
    auto* state = asState(handle);
    if (!state) return;
    std::lock_guard<std::mutex> lock(state->mutex);
    state->transposeSemitones.store(semitones);
    // Silence currently-sounding notes rather than let them ring at the old
    // pitch until their (now key-mismatched) note-off arrives.
    for (int ch = 0; ch < 16; ch++) {
        tsf_channel_sounds_off_all(state->synth, ch);
    }
}

extern "C" JNIEXPORT jint JNICALL
Java_com_letssing_app_audio_MidiEngine_nativeGetDurationMillis(JNIEnv*, jobject, jlong handle) {
    auto* state = asState(handle);
    return state ? static_cast<jint>(state->totalDurationMs) : 0;
}

extern "C" JNIEXPORT jint JNICALL
Java_com_letssing_app_audio_MidiEngine_nativeGetCurrentMillis(JNIEnv*, jobject, jlong handle) {
    auto* state = asState(handle);
    return state ? static_cast<jint>(state->songTimeMs.load()) : 0;
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_letssing_app_audio_MidiEngine_nativeIsPlaying(JNIEnv*, jobject, jlong handle) {
    auto* state = asState(handle);
    return (state && state->isPlaying.load()) ? JNI_TRUE : JNI_FALSE;
}

extern "C" JNIEXPORT void JNICALL
Java_com_letssing_app_audio_MidiEngine_nativeRelease(JNIEnv*, jobject, jlong handle) {
    auto* state = asState(handle);
    if (!state) return;

    if (state->stream) {
        AAudioStream_requestStop(state->stream);
        AAudioStream_close(state->stream);
    }
    if (state->midiHead) tml_free(state->midiHead);
    if (state->synth) tsf_close(state->synth);
    delete state;
}

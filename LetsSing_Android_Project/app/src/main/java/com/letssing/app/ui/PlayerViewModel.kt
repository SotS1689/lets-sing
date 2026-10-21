package com.letssing.app.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.lifecycle.viewModelScope
import com.letssing.app.audio.AssetFileCopier
import com.letssing.app.audio.MidiEngine
import com.letssing.app.data.Hymn
import com.letssing.app.data.HymnRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Tempo slider range, as a percentage of each hymn's own notated pace.
 * 100% is passed to the engine as a scale factor of 1.0 -- no absolute
 * BPM tracking needed on this side; the native engine advances through
 * the MIDI timeline at (real_time * scale), so "100%" is correct for
 * every hymn automatically, whatever its own tempo actually is.
 */
private const val TEMPO_MIN_PERCENT = 50
private const val TEMPO_MAX_PERCENT = 150

/** Pitch slider range, in semitones from the hymn's own notated key. */
private const val PITCH_MIN_SEMITONES = -6
private const val PITCH_MAX_SEMITONES = 6

data class PlayerUiState(
    val hymn: Hymn? = null,
    val isLoading: Boolean = true,
    val isPlaying: Boolean = false,
    val progress: Float = 0f,
    val sopranoVolume: Int = 100,   // 0..127, MIDI CC7 range
    val altoVolume: Int = 100,
    val tenorVolume: Int = 100,
    val bassVolume: Int = 100,
    val tempoPercent: Int = 100,    // 50..150, relative to baseline
    val pitchSemitones: Int = 0,    // -6..6, relative to the hymn's own key
    val error: String? = null,
)

class PlayerViewModel(application: Application) : AndroidViewModel(application) {

    private val repository = HymnRepository(application)
    private val engine = MidiEngine()
    private var engineInitialized = false

    private val _uiState = MutableStateFlow(PlayerUiState())
    val uiState: StateFlow<PlayerUiState> = _uiState.asStateFlow()

    // The AAudio stream runs continuously once started (see native-lib.cpp),
    // so nothing stops audible playback on its own when the user leaves the
    // app -- pause explicitly whenever the whole process goes to the
    // background (Home, app switcher, screen off), so a hymn doesn't keep
    // singing after you've left.
    private val backgroundPauseObserver = object : DefaultLifecycleObserver {
        override fun onStop(owner: LifecycleOwner) {
            if (_uiState.value.isPlaying) {
                engine.pause()
                _uiState.value = _uiState.value.copy(isPlaying = false)
            }
        }
    }

    init {
        ProcessLifecycleOwner.get().lifecycle.addObserver(backgroundPauseObserver)
    }

    fun loadHymn(hymnId: Long) {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, error = null)
            try {
                val hymn = repository.getById(hymnId)
                if (hymn == null) {
                    _uiState.value = _uiState.value.copy(isLoading = false, error = "Hymn not found")
                    return@launch
                }

                withContext(Dispatchers.IO) {
                    val context = getApplication<android.app.Application>()

                    if (!engineInitialized) {
                        val soundfontPath = AssetFileCopier.copyAssetToInternalStorage(
                            context, "soundfonts/default.sf2"
                        )
                        engine.init(soundfontPath)
                        engineInitialized = true
                    }

                    val midiPath = AssetFileCopier.copyAssetToInternalStorage(
                        context, "midi/${hymn.midiFileName}"
                    )
                    engine.load(midiPath)

                    // Apply current slider state to the freshly loaded file
                    // (sliders persist across hymns in this simple version --
                    // change to per-hymn defaults if that's not desired).
                    val s = _uiState.value
                    engine.setVoiceVolume(MidiEngine.Voice.SOPRANO, s.sopranoVolume)
                    engine.setVoiceVolume(MidiEngine.Voice.ALTO, s.altoVolume)
                    engine.setVoiceVolume(MidiEngine.Voice.TENOR, s.tenorVolume)
                    engine.setVoiceVolume(MidiEngine.Voice.BASS, s.bassVolume)
                    engine.setTempoScale(s.tempoPercent / 100.0)
                    engine.setTranspose(s.pitchSemitones)
                }

                _uiState.value = _uiState.value.copy(hymn = hymn, isLoading = false)
                startPositionPolling()
            } catch (e: Exception) {
                _uiState.value = _uiState.value.copy(isLoading = false, error = e.message ?: "Playback error")
            }
        }
    }

    private fun startPositionPolling() {
        viewModelScope.launch {
            while (true) {
                engine.pollPosition()
                _uiState.value = _uiState.value.copy(
                    isPlaying = engine.isPlaying.value,
                    progress = engine.progress.value,
                )
                delay(250)
            }
        }
    }

    fun togglePlayPause() {
        if (_uiState.value.isPlaying) engine.pause() else engine.play()
    }

    fun stop() = engine.stop()

    fun seekTo(fraction: Float) = engine.seekFraction(fraction)

    fun setSopranoVolume(v: Int) {
        _uiState.value = _uiState.value.copy(sopranoVolume = v)
        engine.setVoiceVolume(MidiEngine.Voice.SOPRANO, v)
    }

    fun setAltoVolume(v: Int) {
        _uiState.value = _uiState.value.copy(altoVolume = v)
        engine.setVoiceVolume(MidiEngine.Voice.ALTO, v)
    }

    fun setTenorVolume(v: Int) {
        _uiState.value = _uiState.value.copy(tenorVolume = v)
        engine.setVoiceVolume(MidiEngine.Voice.TENOR, v)
    }

    fun setBassVolume(v: Int) {
        _uiState.value = _uiState.value.copy(bassVolume = v)
        engine.setVoiceVolume(MidiEngine.Voice.BASS, v)
    }

    fun setTempoPercent(percent: Int) {
        val clamped = percent.coerceIn(TEMPO_MIN_PERCENT, TEMPO_MAX_PERCENT)
        _uiState.value = _uiState.value.copy(tempoPercent = clamped)
        engine.setTempoScale(clamped / 100.0)
    }

    fun setPitchSemitones(semitones: Int) {
        val clamped = semitones.coerceIn(PITCH_MIN_SEMITONES, PITCH_MAX_SEMITONES)
        _uiState.value = _uiState.value.copy(pitchSemitones = clamped)
        engine.setTranspose(clamped)
    }

    override fun onCleared() {
        ProcessLifecycleOwner.get().lifecycle.removeObserver(backgroundPauseObserver)
        engine.release()
        super.onCleared()
    }
}

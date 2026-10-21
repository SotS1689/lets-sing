package com.letssing.app.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel

/**
 * Player screen: SATB volume sliders + tempo/pitch sliders + transport + lyrics.
 * Lyrics are shown as plain static text for Phase 1 -- karaoke-style
 * timed highlighting is intentionally deferred (see project notes).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HymnDetailScreen(
    hymnId: Long,
    onBack: () -> Unit,
    viewModel: PlayerViewModel = viewModel(),
) {
    val state by viewModel.uiState.collectAsState()

    LaunchedEffect(hymnId) {
        viewModel.loadHymn(hymnId)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(state.hymn?.title ?: "Loading…") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.Default.ArrowBack, contentDescription = "Back")
                    }
                }
            )
        }
    ) { padding ->
        when {
            state.isLoading -> {
                Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
            }
            state.error != null -> {
                Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                    Text("Error: ${state.error}")
                }
            }
            state.hymn != null -> {
                HymnPlayerContent(
                    state = state,
                    onTogglePlayPause = viewModel::togglePlayPause,
                    onStop = viewModel::stop,
                    onSeek = viewModel::seekTo,
                    onSopranoChange = viewModel::setSopranoVolume,
                    onAltoChange = viewModel::setAltoVolume,
                    onTenorChange = viewModel::setTenorVolume,
                    onBassChange = viewModel::setBassVolume,
                    onTempoChange = viewModel::setTempoPercent,
                    onPitchChange = viewModel::setPitchSemitones,
                    modifier = Modifier.padding(padding),
                )
            }
        }
    }
}

@Composable
private fun HymnPlayerContent(
    state: PlayerUiState,
    onTogglePlayPause: () -> Unit,
    onStop: () -> Unit,
    onSeek: (Float) -> Unit,
    onSopranoChange: (Int) -> Unit,
    onAltoChange: (Int) -> Unit,
    onTenorChange: (Int) -> Unit,
    onBassChange: (Int) -> Unit,
    onTempoChange: (Int) -> Unit,
    onPitchChange: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    val hymn = state.hymn!!

    LazyColumn(modifier = modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        item {
            Spacer(Modifier.height(8.dp))
            Text(hymn.tune, style = MaterialTheme.typography.titleMedium)
            if (hymn.author.isNotBlank()) {
                Text("Author: ${hymn.author}", style = MaterialTheme.typography.bodySmall)
            }
            if (hymn.composerArranger.isNotBlank()) {
                Text("Composer: ${hymn.composerArranger}", style = MaterialTheme.typography.bodySmall)
            }
            Spacer(Modifier.height(16.dp))
        }

        // --- Transport ---
        item {
            Slider(
                value = state.progress,
                onValueChange = onSeek,
                modifier = Modifier.fillMaxWidth(),
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.Center,
            ) {
                IconButton(onClick = onTogglePlayPause) {
                    Icon(
                        if (state.isPlaying) Icons.Default.Pause else Icons.Default.PlayArrow,
                        contentDescription = if (state.isPlaying) "Pause" else "Play",
                        modifier = Modifier.size(48.dp),
                    )
                }
                IconButton(onClick = onStop) {
                    Icon(Icons.Default.Stop, contentDescription = "Stop", modifier = Modifier.size(48.dp))
                }
            }
            Spacer(Modifier.height(24.dp))
        }

        // --- SATB volume sliders ---
        item {
            Text("Voice Parts", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(8.dp))
            VoiceSlider(label = "Soprano", value = state.sopranoVolume, onChange = onSopranoChange)
            VoiceSlider(label = "Alto", value = state.altoVolume, onChange = onAltoChange)
            VoiceSlider(label = "Tenor", value = state.tenorVolume, onChange = onTenorChange)
            VoiceSlider(label = "Bass", value = state.bassVolume, onChange = onBassChange)
            Spacer(Modifier.height(16.dp))
        }

        // --- Tempo slider ---
        item {
            Text("Tempo", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("${state.tempoPercent}%", modifier = Modifier.width(56.dp))
                Slider(
                    value = state.tempoPercent.toFloat(),
                    onValueChange = { onTempoChange(it.toInt()) },
                    valueRange = 50f..150f,
                    steps = 19, // 5% increments across the 50-150 range
                    modifier = Modifier.weight(1f),
                )
            }
            Spacer(Modifier.height(24.dp))
        }

        // --- Pitch slider ---
        item {
            Text("Pitch", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                val label = when {
                    state.pitchSemitones > 0 -> "+${state.pitchSemitones}"
                    else -> "${state.pitchSemitones}"
                }
                Text(label, modifier = Modifier.width(56.dp))
                Slider(
                    value = state.pitchSemitones.toFloat(),
                    onValueChange = { onPitchChange(it.toInt()) },
                    valueRange = -6f..6f,
                    steps = 11, // 1-semitone increments across the -6..+6 range
                    modifier = Modifier.weight(1f),
                )
            }
            Spacer(Modifier.height(24.dp))
        }

        // --- Lyrics (static; karaoke-style timed sync deferred) ---
        item {
            Text("Lyrics", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(8.dp))
        }
        items(hymn.verses) { verse ->
            Text(verse, modifier = Modifier.padding(bottom = 12.dp))
        }

        item {
            Spacer(Modifier.height(8.dp))
            Text(
                hymn.credits,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(32.dp))
        }
    }
}

@Composable
private fun VoiceSlider(label: String, value: Int, onChange: (Int) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(label, modifier = Modifier.width(80.dp))
        Slider(
            value = value.toFloat(),
            onValueChange = { onChange(it.toInt()) },
            valueRange = 0f..127f,
            modifier = Modifier.weight(1f),
        )
    }
}

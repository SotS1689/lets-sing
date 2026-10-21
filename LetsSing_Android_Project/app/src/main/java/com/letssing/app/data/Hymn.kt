package com.letssing.app.data

import androidx.room.Entity
import androidx.room.PrimaryKey

/**
 * One hymn's metadata + content.
 *
 * `midiFileName` is the file name (not full path) expected under
 * `assets/midi/`. `verses` and `credits` are stored as-is from the
 * source dataset (verses joined with a line-break delimiter since Room
 * doesn't store List<String> natively without a TypeConverter -- kept
 * simple here on purpose for Phase 1).
 */
@Entity(tableName = "hymns")
data class Hymn(
    @PrimaryKey(autoGenerate = true)
    val id: Long = 0,

    val title: String,
    val tune: String,
    val author: String,
    val composerArranger: String,
    val credits: String,

    // Relative file names -- resolved against assets/midi/ and assets/mp3/
    // at playback time. MIDI is the primary playback source (see MidiEngine);
    // MP3 is kept only as a fallback / preview reference.
    val midiFileName: String,
    val mp3FileName: String,

    // Verses joined with "\n\n" between stanzas. A dedicated VerseDao/
    // TypeConverter can replace this later if per-verse timing data
    // (karaoke sync) needs its own table.
    val versesJoined: String,

    // Alphabetical sort key (lowercased, articles not stripped -- simple
    // on purpose; refine later if "The"/"A" leading-article sorting matters).
    val sortTitle: String,
) {
    val verses: List<String>
        get() = versesJoined.split("\n\n").filter { it.isNotBlank() }
}

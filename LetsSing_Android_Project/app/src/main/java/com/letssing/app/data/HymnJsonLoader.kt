package com.letssing.app.data

import android.content.Context
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Mirrors the shape of the hymns_data.json produced by the Phase 0/1
 * content pipeline (see project notes): one object per hymn with
 * title / tune / composer_arranger / midi_url / mp3_url / verses / credits.
 *
 * NOTE: midi_url / mp3_url in that JSON are the original openhymnal.org
 * download URLs. The app does not fetch them at runtime -- instead it
 * expects the *file names* (last path segment) to exist locally under
 * assets/midi/ and assets/mp3/, since you already have the MIDI files
 * downloaded. See fileNameFromUrl() below.
 */
@Serializable
data class HymnJson(
    val id: Int,
    val title: String = "",
    val tune: String = "",
    @SerialName("Author") val author: String = "",
    @SerialName("Composer") val composer: String = "",
    // Open Hymnal-sourced entries name the composer here instead of "Composer"
    val composer_arranger: String = "",
    val midi_url: String = "",
    val mp3_url: String = "",
    val verses: List<String> = emptyList(),
    val credits: String = "",
)

object HymnJsonLoader {

    private val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
    }

    /** Extracts "Amazing_Grace-New_Britain.mid" from a full openhymnal.org URL. */
    private fun fileNameFromUrl(url: String): String =
        url.substringAfterLast('/').trim()

    // Strips leading punctuation (e.g. the apostrophe in "'Tis So Sweet")
    // so it sorts alongside plain letters instead of before them -- a bare
    // lowercase() leaves '\'' (code point 39) sorting ahead of 'a' (97) in
    // SQLite's default text comparison.
    private fun sortKey(title: String): String =
        title.lowercase().trim().dropWhile { !it.isLetterOrDigit() }

    /**
     * Reads assets/hymns_data.json and inserts every hymn into Room.
     * Safe to call every launch -- it's a no-op if the DB is already
     * populated (see MainActivity / HymnRepository).
     */
    suspend fun importFromAssets(context: Context, dao: HymnDao) {
        val text = context.assets.open("hymns_data.json").bufferedReader().use { it.readText() }
        val parsed = json.decodeFromString<List<HymnJson>>(text)

        val hymns = parsed.map { h ->
            Hymn(
                title = h.title,
                tune = h.tune,
                author = h.author,
                composerArranger = h.composer.ifBlank { h.composer_arranger },
                credits = h.credits,
                midiFileName = fileNameFromUrl(h.midi_url),
                mp3FileName = fileNameFromUrl(h.mp3_url),
                versesJoined = h.verses.joinToString("\n\n"),
                sortTitle = sortKey(h.title),
            )
        }
        dao.insertAll(hymns)
    }
}

package com.letssing.app.audio

import android.content.Context
import java.io.File

/**
 * TinySoundFont's C API takes filesystem paths, not Android's AssetManager
 * streams -- so bundled MIDI files and the soundfont get copied to
 * internal storage once, then played from there.
 */
object AssetFileCopier {

    /**
     * Copies assets/[assetRelativePath] to internal storage if not already
     * present, returning the absolute filesystem path either way.
     *
     * Skips the copy on repeat calls (checked by file existence), so this
     * is cheap to call every time a hymn is opened -- unless the app has
     * been installed/updated since the copy was made, in which case the
     * asset may have changed (e.g. a corrected MIDI file) and is copied
     * again. Without that check an update could never replace a MIDI file
     * a user had already opened once. Copies to a temp file
     * and renames into place only once the copy fully succeeds, so a
     * process death mid-copy (e.g. low storage, backgrounded during the
     * first-launch soundfont copy) can't leave a truncated file that looks
     * "already copied" on the next launch.
     */
    fun copyAssetToInternalStorage(context: Context, assetRelativePath: String): String {
        val outFile = File(context.filesDir, assetRelativePath)
        outFile.parentFile?.mkdirs()

        if (!outFile.exists() || outFile.lastModified() < appUpdateTime(context)) {
            val tempFile = File(outFile.parentFile, "${outFile.name}.tmp")
            context.assets.open(assetRelativePath).use { input ->
                tempFile.outputStream().use { output ->
                    input.copyTo(output)
                }
            }
            check(tempFile.renameTo(outFile)) {
                "Failed to finalize copied asset: $assetRelativePath"
            }
        }
        return outFile.absolutePath
    }

    /** When this APK was last installed or updated (ms since epoch). */
    private fun appUpdateTime(context: Context): Long =
        context.packageManager.getPackageInfo(context.packageName, 0).lastUpdateTime
}

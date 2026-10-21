package com.letssing.app.data

import android.content.Context
import androidx.room.withTransaction
import kotlinx.coroutines.flow.Flow

class HymnRepository(private val context: Context) {

    private val db = HymnDatabase.get(context)
    private val dao = db.hymnDao()

    /**
     * Populates the DB from assets/hymns_data.json on first run, and again
     * whenever the app has been installed/updated since the last import --
     * otherwise an update's corrected or added hymns would never replace
     * what an existing install already imported. The table holds only
     * bundled content (no user data), so it is simply rebuilt.
     */
    suspend fun ensureSeeded() {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val updateTime = context.packageManager
            .getPackageInfo(context.packageName, 0).lastUpdateTime
        if (dao.count() == 0 || prefs.getLong(KEY_SEEDED_FOR, -1L) != updateTime) {
            db.withTransaction {
                dao.deleteAll()
                HymnJsonLoader.importFromAssets(context, dao)
            }
            prefs.edit().putLong(KEY_SEEDED_FOR, updateTime).apply()
        }
    }

    fun observeAll(): Flow<List<Hymn>> = dao.observeAllAlphabetical()

    fun search(query: String): Flow<List<Hymn>> = dao.search(query)

    suspend fun getById(id: Long): Hymn? = dao.getById(id)

    private companion object {
        const val PREFS = "hymn_seed"
        const val KEY_SEEDED_FOR = "seeded_for_update_time"
    }
}

package com.letssing.app.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

@Dao
interface HymnDao {

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(hymns: List<Hymn>)

    @Query("SELECT COUNT(*) FROM hymns")
    suspend fun count(): Int

    @Query("DELETE FROM hymns")
    suspend fun deleteAll()

    @Query("SELECT * FROM hymns ORDER BY sortTitle ASC")
    fun observeAllAlphabetical(): Flow<List<Hymn>>

    // Title/tune/author/composer matches are ranked above lyric-only
    // matches (CASE ... THEN 0 ELSE 1), alphabetical within each group.
    @Query(
        """
        SELECT * FROM hymns
        WHERE title LIKE '%' || :query || '%'
           OR tune LIKE '%' || :query || '%'
           OR author LIKE '%' || :query || '%'
           OR composerArranger LIKE '%' || :query || '%'
           OR versesJoined LIKE '%' || :query || '%'
        ORDER BY
            CASE
                WHEN title LIKE '%' || :query || '%'
                  OR tune LIKE '%' || :query || '%'
                  OR author LIKE '%' || :query || '%'
                  OR composerArranger LIKE '%' || :query || '%'
                THEN 0 ELSE 1
            END,
            sortTitle ASC
        """
    )
    fun search(query: String): Flow<List<Hymn>>

    @Query("SELECT * FROM hymns WHERE id = :id")
    suspend fun getById(id: Long): Hymn?
}

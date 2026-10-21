package com.letssing.app.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(entities = [Hymn::class], version = 2, exportSchema = false)
abstract class HymnDatabase : RoomDatabase() {
    abstract fun hymnDao(): HymnDao

    companion object {
        @Volatile private var INSTANCE: HymnDatabase? = null

        fun get(context: Context): HymnDatabase =
            INSTANCE ?: synchronized(this) {
                INSTANCE ?: Room.databaseBuilder(
                    context.applicationContext,
                    HymnDatabase::class.java,
                    "letssing.db"
                ).fallbackToDestructiveMigration().build().also { INSTANCE = it }
            }
    }
}

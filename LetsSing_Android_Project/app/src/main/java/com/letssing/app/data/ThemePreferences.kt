package com.letssing.app.data

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.themeDataStore by preferencesDataStore(name = "theme_preferences")
private val DARK_THEME_KEY = booleanPreferencesKey("dark_theme")

/** Persists the user's light/dark mode choice across app launches. */
class ThemePreferences(private val context: Context) {

    /** True = dark, false = light, null = not set yet (follow system default). */
    val isDarkTheme: Flow<Boolean?> = context.themeDataStore.data.map { it[DARK_THEME_KEY] }

    suspend fun setDarkTheme(isDark: Boolean) {
        context.themeDataStore.edit { it[DARK_THEME_KEY] = isDark }
    }
}

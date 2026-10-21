package com.letssing.app.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.letssing.app.data.ThemePreferences
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/**
 * Exposes the saved dark-mode preference. `null` means the user hasn't chosen yet,
 * in which case the UI should fall back to the system setting.
 */
class SettingsViewModel(application: Application) : AndroidViewModel(application) {

    private val preferences = ThemePreferences(application)

    val isDarkTheme: StateFlow<Boolean?> = preferences.isDarkTheme
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), null)

    fun setDarkTheme(isDark: Boolean) {
        viewModelScope.launch {
            preferences.setDarkTheme(isDark)
        }
    }
}

package com.letssing.app.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.letssing.app.data.Hymn
import com.letssing.app.data.HymnRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class HymnListViewModel(application: Application) : AndroidViewModel(application) {

    private val repository = HymnRepository(application)

    private val _query = MutableStateFlow("")
    val query: StateFlow<String> = _query.asStateFlow()

    private val _isSeeding = MutableStateFlow(true)
    val isSeeding: StateFlow<Boolean> = _isSeeding.asStateFlow()

    val hymns: StateFlow<List<Hymn>> = _query
        .flatMapLatest { q ->
            if (q.isBlank()) repository.observeAll() else repository.search(q)
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    init {
        viewModelScope.launch {
            repository.ensureSeeded()
            _isSeeding.value = false
        }
    }

    fun onQueryChange(newQuery: String) {
        _query.value = newQuery
    }
}

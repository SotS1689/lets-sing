package com.letssing.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.DarkMode
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.LightMode
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.letssing.app.data.Hymn
import com.letssing.app.ui.theme.AppIconRed

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HymnListScreen(
    onHymnClick: (Long) -> Unit,
    isDarkTheme: Boolean,
    onToggleDarkTheme: (Boolean) -> Unit,
    viewModel: HymnListViewModel = viewModel(),
) {
    val hymns by viewModel.hymns.collectAsState()
    val query by viewModel.query.collectAsState()
    val isSeeding by viewModel.isSeeding.collectAsState()
    val uriHandler = LocalUriHandler.current

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Let's Sing") },
                actions = {
                    IconButton(onClick = { onToggleDarkTheme(!isDarkTheme) }) {
                        Icon(
                            if (isDarkTheme) Icons.Default.LightMode else Icons.Default.DarkMode,
                            contentDescription = if (isDarkTheme) "Switch to light mode" else "Switch to dark mode",
                        )
                    }
                    IconButton(onClick = { uriHandler.openUri("https://buymeacoffee.com/reformedretrieval") }) {
                        Icon(Icons.Default.Favorite, contentDescription = "Support", tint = AppIconRed)
                    }
                }
            )
        }
    ) { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize()) {
            OutlinedTextField(
                value = query,
                onValueChange = viewModel::onQueryChange,
                modifier = Modifier.fillMaxWidth().padding(16.dp),
                placeholder = { Text("Search title, tune, or composer") },
                leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
                trailingIcon = {
                    if (query.isNotEmpty()) {
                        IconButton(onClick = { viewModel.onQueryChange("") }) {
                            Icon(Icons.Default.Clear, contentDescription = "Clear search")
                        }
                    }
                },
                singleLine = true,
            )

            when {
                isSeeding -> {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            CircularProgressIndicator()
                            Spacer(Modifier.height(12.dp))
                            Text("Loading hymnal…")
                        }
                    }
                }
                hymns.isEmpty() -> {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Text("No hymns match \"$query\"")
                    }
                }
                else -> {
                    LazyColumn {
                        items(hymns, key = { it.id }) { hymn ->
                            HymnRow(hymn = hymn, onClick = { onHymnClick(hymn.id) })
                            Divider()
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun HymnRow(hymn: Hymn, onClick: () -> Unit) {
    ListItem(
        headlineContent = { Text(hymn.title) },
        supportingContent = { Text(hymn.tune) },
        modifier = Modifier.clickable(onClick = onClick),
    )
}

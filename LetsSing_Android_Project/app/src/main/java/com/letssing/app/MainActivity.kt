package com.letssing.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.letssing.app.ui.HymnDetailScreen
import com.letssing.app.ui.HymnListScreen
import com.letssing.app.ui.SettingsViewModel
import com.letssing.app.ui.theme.LetsSingTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            LetsSingApp()
        }
    }
}

private const val ROUTE_LIST = "list"
private const val ROUTE_DETAIL = "detail/{hymnId}"

@Composable
fun LetsSingApp(settingsViewModel: SettingsViewModel = viewModel()) {
    val savedDarkTheme by settingsViewModel.isDarkTheme.collectAsState()
    val isDarkTheme = savedDarkTheme ?: isSystemInDarkTheme()

    LetsSingTheme(darkTheme = isDarkTheme) {
        Surface(modifier = Modifier) {
            val navController = rememberNavController()

            NavHost(navController = navController, startDestination = ROUTE_LIST) {
                composable(ROUTE_LIST) {
                    HymnListScreen(
                        onHymnClick = { id -> navController.navigate("detail/$id") },
                        isDarkTheme = isDarkTheme,
                        onToggleDarkTheme = settingsViewModel::setDarkTheme,
                    )
                }
                composable(
                    route = ROUTE_DETAIL,
                    arguments = listOf(navArgument("hymnId") { type = NavType.LongType })
                ) { backStackEntry ->
                    val hymnId = backStackEntry.arguments?.getLong("hymnId") ?: return@composable
                    HymnDetailScreen(
                        hymnId = hymnId,
                        onBack = { navController.popBackStack() },
                    )
                }
            }
        }
    }
}

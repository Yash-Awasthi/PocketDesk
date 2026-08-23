package com.yasha.pocketdesk

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Build
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import com.yasha.pocketdesk.ui.ConnectScreen
import com.yasha.pocketdesk.ui.SessionsScreen
import com.yasha.pocketdesk.ui.TerminalScreen
import com.yasha.pocketdesk.ui.ToolsScreen

sealed interface Screen {
    data object Connect : Screen
    data object Tools : Screen
    data object Sessions : Screen
    data class Terminal(val sessionId: String) : Screen
}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                Root()
            }
        }
    }
}

@Composable
private fun Root() {
    val ws = remember { WsClient() }
    var screen by remember { mutableStateOf<Screen>(Screen.Connect) }
    DisposableEffect(Unit) { onDispose { ws.close() } }

    val connected = ws.status == Status.Connected
    BackHandler(enabled = connected && screen != Screen.Sessions) {
        screen = Screen.Sessions
    }

    Scaffold(
        bottomBar = {
            if (connected && screen !is Screen.Terminal) {
                NavigationBar {
                    NavigationBarItem(
                        selected = screen == Screen.Tools,
                        onClick = { screen = Screen.Tools },
                        icon = { Icon(Icons.Filled.Build, contentDescription = null) },
                        label = { Text("Tools") },
                    )
                    NavigationBarItem(
                        selected = screen == Screen.Sessions,
                        onClick = { screen = Screen.Sessions },
                        icon = { Icon(Icons.AutoMirrored.Filled.List, contentDescription = null) },
                        label = { Text("Sessions") },
                    )
                }
            }
        },
    ) { pad ->
        Box(Modifier.fillMaxSize().padding(pad)) {
            when (val s = screen) {
                Screen.Connect -> ConnectScreen(ws) { screen = Screen.Sessions }
                Screen.Tools -> ToolsScreen(ws)
                Screen.Sessions -> SessionsScreen(ws, openTerminal = { screen = Screen.Terminal(it) })
                is Screen.Terminal -> TerminalScreen(ws, s.sessionId, onClose = { screen = Screen.Sessions })
            }
        }
    }
}

package com.yasha.pocketdesk

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.unit.dp
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import com.yasha.pocketdesk.ui.ChatScreen
import com.yasha.pocketdesk.ui.DesktopScreen
import com.yasha.pocketdesk.ui.ConnectScreen
import com.yasha.pocketdesk.ui.FreebuffScreen
import com.yasha.pocketdesk.ui.SessionsScreen
import com.yasha.pocketdesk.ui.SshScreen
import com.yasha.pocketdesk.ui.TerminalScreen
import com.yasha.pocketdesk.ui.ToolsScreen

sealed interface Screen {
    data object Connect : Screen
    data object Tools : Screen
    data object Sessions : Screen
    data object Chats : Screen
    data object Freebuff : Screen
    data object Desktop : Screen
    data object Ssh : Screen
    data class Terminal(val sessionId: String) : Screen
}

private val ScreenSaver = Saver<Screen, String>(
    save = { if (it is Screen.Terminal) "terminal:" + it.sessionId else it.toString() },
    restore = { s ->
        if (s.startsWith("terminal:")) Screen.Terminal(s.removePrefix("terminal:"))
        else listOf(Screen.Connect, Screen.Tools, Screen.Sessions, Screen.Chats, Screen.Freebuff, Screen.Desktop, Screen.Ssh)
            .firstOrNull { it.toString() == s } ?: Screen.Connect
    },
)

class MainActivity : ComponentActivity() {

    private var locked by mutableStateOf(false)
    private lateinit var lock: AppLock

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Notifier.ensureChannel(this)
        lock = AppLock(this) { locked = false }
        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                Root()
            }
        }
    }

    override fun onStart() {
        super.onStart()
        foreground = true
        if (lock.shouldLock()) {
            locked = true
            lock.prompt()
        }
    }

    override fun onStop() {
        super.onStop()
        foreground = false
        lock.onStop()
    }

    @Composable
    private fun Root() {
        val client = Link.client
        LaunchedEffect(client.status) {
            LinkService.sync(applicationContext, client.status != Status.Disconnected)
        }
        LaunchedEffect(client.issuedToken) {
            val (url, token) = client.issuedToken ?: return@LaunchedEffect
            val book = ServerBook(applicationContext)
            book.save(book.load().map { if (it.url == url) it.copy(token = token) else it })
        }
        // Declared before the lock gate so a re-lock keeps navigation and notifications.
        var screen by rememberSaveable(stateSaver = ScreenSaver) { mutableStateOf<Screen>(Screen.Connect) }

        LaunchedEffect(Unit) {
            client.events.collect { ev ->
                if (ev is RhEvent.Exit && !foreground) {
                    Notifier.sessionEnded(applicationContext, ev.harnessId, ev.code)
                }
            }
        }

        if (locked) {
            Box(Modifier.fillMaxSize(), contentAlignment = androidx.compose.ui.Alignment.Center) {
                androidx.compose.material3.Button(onClick = { lock.prompt() }) { Text("Unlock") }
            }
            return
        }

        val connected = client.status == Status.Connected
        BackHandler(enabled = connected && screen != Screen.Sessions && screen != Screen.Chats) {
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
                        NavigationBarItem(
                            selected = screen == Screen.Chats,
                            onClick = { screen = Screen.Chats },
                            icon = { Icon(Icons.Filled.Email, contentDescription = null) },
                            label = { Text("Chats") },
                        )
                        NavigationBarItem(
                            selected = screen == Screen.Freebuff,
                            onClick = { screen = Screen.Freebuff },
                            icon = { Icon(Icons.Filled.Settings, contentDescription = null) },
                            label = { Text("Freebuff") },
                        )
                        NavigationBarItem(
                            selected = screen == Screen.Desktop,
                            onClick = { screen = Screen.Desktop },
                            icon = { Icon(Icons.Filled.Build, contentDescription = null) },
                            label = { Text("Desktop") },
                        )
                    }
                }
            },
        ) { pad ->
            Box(Modifier.fillMaxSize().padding(pad)) {
                // Connection state banner (surfaces Reconnecting — previously
                // the app dropped to a bare "disconnected" with no hint).
                when (client.status) {
                    Status.Reconnecting -> Text(
                        "⟳ reconnecting…",
                        color = androidx.compose.material3.MaterialTheme.colorScheme.onErrorContainer,
                        modifier = Modifier
                            .align(androidx.compose.ui.Alignment.TopCenter)
                            .background(androidx.compose.material3.MaterialTheme.colorScheme.errorContainer)
                            .padding(horizontal = 12.dp, vertical = 4.dp),
                    )
                    Status.Connecting -> Text(
                        "connecting…",
                        color = androidx.compose.material3.MaterialTheme.colorScheme.onErrorContainer,
                        modifier = Modifier
                            .align(androidx.compose.ui.Alignment.TopCenter)
                            .background(androidx.compose.material3.MaterialTheme.colorScheme.errorContainer)
                            .padding(horizontal = 12.dp, vertical = 4.dp),
                    )
                    else -> {}
                }
                when (val s = if (client.status == Status.Disconnected) Screen.Connect else screen) {
                    Screen.Connect -> ConnectScreen(client) { screen = Screen.Sessions }
                    Screen.Tools -> ToolsScreen(
                        client,
                        openDesktop = { screen = Screen.Desktop },
                        openTerminal = { screen = Screen.Terminal(it) },
                        openSsh = { screen = Screen.Ssh },
                        lock = lock,
                    )
                    Screen.Sessions -> SessionsScreen(client, openTerminal = { screen = Screen.Terminal(it) })
                    Screen.Chats -> ChatScreen(client)
                    Screen.Freebuff -> FreebuffScreen(client)
                    Screen.Desktop -> DesktopScreen(client, onClose = { screen = Screen.Sessions })
                    Screen.Ssh -> SshScreen(client, onClose = { screen = Screen.Tools })
                    is Screen.Terminal -> TerminalScreen(client, s.sessionId, onClose = { screen = Screen.Sessions })
                }
            }
        }
    }

    companion object {
        @Volatile
        var foreground: Boolean = true
    }
}

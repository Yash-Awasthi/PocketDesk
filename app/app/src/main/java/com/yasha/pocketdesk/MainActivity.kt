package com.yasha.pocketdesk

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.ui.platform.compositionContext
import androidx.compose.ui.platform.createLifecycleAwareWindowRecomposer
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.unit.dp
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ExitToApp
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
import com.yasha.pocketdesk.ui.FilesScreen
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
    data object Files : Screen
    data object Ssh : Screen
    data class Terminal(val sessionId: String) : Screen
}

private val ScreenSaver = Saver<Screen, String>(
    save = { if (it is Screen.Terminal) "terminal:" + it.sessionId else it.toString() },
    restore = { s ->
        if (s.startsWith("terminal:")) Screen.Terminal(s.removePrefix("terminal:"))
        else listOf(Screen.Connect, Screen.Tools, Screen.Sessions, Screen.Chats, Screen.Freebuff, Screen.Desktop, Screen.Files, Screen.Ssh)
            .firstOrNull { it.toString() == s } ?: Screen.Connect
    },
)

private object NoMotion : androidx.compose.ui.MotionDurationScale {
    override val scaleFactor = 0f
}

class MainActivity : ComponentActivity() {

    private var locked by mutableStateOf(false)
    private lateinit var lock: AppLock

    @OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class, androidx.compose.ui.InternalComposeUiApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        lock = AppLock(this) { locked = false }
        takePairing(intent)
        // Every Compose animation (ripples, visibility, scrolling, text fields) runs at zero duration.
        window.decorView.compositionContext = window.decorView.createLifecycleAwareWindowRecomposer(NoMotion, lifecycle)
        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                Root()
            }
        }
    }

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        takePairing(intent)
    }

    private fun takePairing(intent: android.content.Intent?) {
        val link = intent?.dataString ?: return
        Pairing.parse(link).takeIf { it.isNotEmpty() }?.let { Link.pendingPair = it }
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
        LaunchedEffect(client.issuedToken) {
            val (url, token) = client.issuedToken ?: return@LaunchedEffect
            val book = ServerBook(applicationContext)
            book.save(book.load().map { if (it.url == url || it.fallback == url) it.copy(token = token) else it })
        }
        LaunchedEffect(client) {
            client.events.collect { ev ->
                if (ev is RhEvent.PowerDone) android.widget.Toast.makeText(
                    this@MainActivity,
                    if (ev.ok) "PC: ${ev.action} sent" else "PC: ${ev.action} failed: ${ev.error}",
                    android.widget.Toast.LENGTH_SHORT,
                ).show()
            }
        }
        // Declared before the lock gate so a re-lock keeps navigation.
        var screen by rememberSaveable(stateSaver = ScreenSaver) { mutableStateOf<Screen>(Screen.Connect) }
        var desktopFullscreen by rememberSaveable { mutableStateOf(false) }
        var desktopKeys by rememberSaveable { mutableStateOf(false) }
        LaunchedEffect(screen) { if (screen != Screen.Desktop) desktopFullscreen = false }
        com.yasha.pocketdesk.ui.DesktopFullscreenEffect(desktopFullscreen)

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
                // The desktop keyboard needs the room, so the tabs step aside while it is open.
                if (connected && screen !is Screen.Terminal && !desktopFullscreen && !(screen == Screen.Desktop && desktopKeys)) {
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
                            selected = screen == Screen.Files,
                            onClick = { screen = Screen.Files },
                            icon = { Icon(com.yasha.pocketdesk.ui.FolderIcon, contentDescription = null) },
                            label = { Text("Files") },
                        )
                        NavigationBarItem(
                            selected = screen == Screen.Desktop,
                            onClick = { screen = Screen.Desktop },
                            icon = { Icon(com.yasha.pocketdesk.ui.MonitorIcon, contentDescription = null) },
                            label = { Text("Desktop") },
                        )
                        // Disconnects and shows the saved PCs, to switch to another one.
                        NavigationBarItem(
                            selected = false,
                            onClick = { client.close(); screen = Screen.Connect },
                            icon = { Icon(Icons.AutoMirrored.Filled.ExitToApp, contentDescription = null) },
                            label = { Text("PCs") },
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
                        openFreebuff = { screen = Screen.Freebuff },
                        lock = lock,
                    )
                    Screen.Sessions -> SessionsScreen(client, openTerminal = { screen = Screen.Terminal(it) })
                    Screen.Chats -> ChatScreen(client)
                    Screen.Files -> FilesScreen(client)
                    Screen.Freebuff -> FreebuffScreen(client, openDesktop = { screen = Screen.Desktop })
                    Screen.Desktop -> DesktopScreen(
                        client,
                        onClose = { screen = Screen.Sessions },
                        fullscreen = desktopFullscreen,
                        onFullscreen = { desktopFullscreen = it },
                        showKeys = desktopKeys,
                        onShowKeys = { desktopKeys = it },
                    )
                    Screen.Ssh -> SshScreen(client, onClose = { screen = Screen.Tools })
                    is Screen.Terminal -> TerminalScreen(client, s.sessionId, onClose = { screen = Screen.Sessions })
                }
                if (client.status != Status.Disconnected) {
                    com.yasha.pocketdesk.ui.ApprovalCard(client, Modifier.align(androidx.compose.ui.Alignment.TopCenter))
                }
            }
        }
    }

    companion object {
        @Volatile
        var foreground: Boolean = true
    }
}

package com.yasha.pocketdesk

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.platform.compositionContext
import androidx.compose.ui.platform.createLifecycleAwareWindowRecomposer
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.navigation3.runtime.NavKey
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.runtime.rememberNavBackStack
import androidx.navigation3.ui.NavDisplay
import com.yasha.pocketdesk.ui.AgentScreen
import com.yasha.pocketdesk.ui.ChatScreen
import com.yasha.pocketdesk.ui.DesktopScreen
import com.yasha.pocketdesk.ui.ConnectScreen
import com.yasha.pocketdesk.ui.FilesScreen
import com.yasha.pocketdesk.ui.FreebuffScreen
import com.yasha.pocketdesk.ui.SessionsScreen
import com.yasha.pocketdesk.ui.SshScreen
import com.yasha.pocketdesk.ui.TerminalScreen
import com.yasha.pocketdesk.ui.ToolsScreen
import androidx.savedstate.serialization.SavedStateConfiguration
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable
import kotlinx.serialization.modules.SerializersModule
import kotlinx.serialization.modules.polymorphic

@Serializable
sealed interface Screen : NavKey {
    @Serializable data object Connect : Screen
    @Serializable data object Tools : Screen
    @Serializable data object Sessions : Screen
    @Serializable data object Chats : Screen
    @Serializable data object Freebuff : Screen
    @Serializable data object Desktop : Screen
    @Serializable data object Files : Screen
    @Serializable data object Ssh : Screen
    @Serializable data class Terminal(val sessionId: String) : Screen
    @Serializable data class Agent(val id: String) : Screen
}

// Generated serializers per subclass, so a saved back stack survives R8 renaming without reflection.
@OptIn(ExperimentalSerializationApi::class)
val ScreenSerializers = SerializersModule {
    polymorphic(NavKey::class) { subclassesOfSealed<Screen>() }
}

private val NavConfig = SavedStateConfiguration { serializersModule = ScreenSerializers }

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
        com.yasha.pocketdesk.hub.ClipSync.onForeground(this, true)
        if (lock.shouldLock()) {
            locked = true
            lock.prompt()
        }
    }

    override fun onStop() {
        super.onStop()
        foreground = false
        com.yasha.pocketdesk.hub.ClipSync.onForeground(this, false)
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
        LaunchedEffect(client.irohUpdate) {
            val (url, fallback) = client.irohUpdate ?: return@LaunchedEffect
            val book = ServerBook(applicationContext)
            book.save(book.load().map { if (it.url == url) it.copy(fallback = fallback) else it })
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
        val backStack = rememberNavBackStack(NavConfig, Screen.Connect)
        val screen = backStack.lastOrNull() ?: Screen.Connect
        // Sessions and Chats are roots, so back from them leaves the app; other tabs return to Sessions.
        fun showTab(tab: Screen) {
            backStack.clear()
            if (tab != Screen.Sessions && tab != Screen.Chats) backStack.add(Screen.Sessions)
            backStack.add(tab)
        }
        fun open(next: Screen) = backStack.add(next)
        fun back() = if (backStack.size > 1) backStack.removeAt(backStack.lastIndex) else showTab(Screen.Sessions)
        var desktopFullscreen by rememberSaveable { mutableStateOf(false) }
        var desktopKeys by rememberSaveable { mutableStateOf(false) }
        // Fullscreen and the desktop keyboard are per visit: the Desktop tab opens with neither.
        LaunchedEffect(screen) { if (screen != Screen.Desktop) { desktopFullscreen = false; desktopKeys = false } }
        com.yasha.pocketdesk.ui.DesktopFullscreenEffect(desktopFullscreen)

        if (locked) {
            Box(Modifier.fillMaxSize(), contentAlignment = androidx.compose.ui.Alignment.Center) {
                androidx.compose.material3.Button(onClick = { lock.prompt() }) { Text("Unlock") }
            }
            return
        }

        val connected = client.status == Status.Connected

        Scaffold(
            // Fullscreen desktop reaches every edge, cutout included.
            contentWindowInsets = if (desktopFullscreen) androidx.compose.foundation.layout.WindowInsets(0)
                else androidx.compose.material3.ScaffoldDefaults.contentWindowInsets,
            bottomBar = {
                // The desktop keyboard needs the room, so the tabs step aside while it is open.
                if (connected && screen !is Screen.Terminal && !desktopFullscreen && !(screen == Screen.Desktop && desktopKeys)) {
                    NavigationBar {
                        NavigationBarItem(
                            selected = screen == Screen.Tools,
                            onClick = { showTab(Screen.Tools) },
                            icon = { Icon(Icons.Filled.Build, contentDescription = null) },
                            label = { Text("Tools") },
                        )
                        NavigationBarItem(
                            selected = screen == Screen.Sessions,
                            onClick = { showTab(Screen.Sessions) },
                            icon = { Icon(Icons.AutoMirrored.Filled.List, contentDescription = null) },
                            label = { Text("Sessions") },
                        )
                        NavigationBarItem(
                            selected = screen == Screen.Chats,
                            onClick = { showTab(Screen.Chats) },
                            icon = { Icon(Icons.Filled.Email, contentDescription = null) },
                            label = { Text("Chats") },
                        )
                        NavigationBarItem(
                            selected = screen == Screen.Files,
                            onClick = { showTab(Screen.Files) },
                            icon = { Icon(com.yasha.pocketdesk.ui.FolderIcon, contentDescription = null) },
                            label = { Text("Files") },
                        )
                        NavigationBarItem(
                            selected = screen == Screen.Desktop,
                            onClick = { showTab(Screen.Desktop) },
                            icon = { Icon(com.yasha.pocketdesk.ui.MonitorIcon, contentDescription = null) },
                            label = { Text("Desktop") },
                        )
                        // Disconnects and shows the saved PCs, to switch to another one.
                        NavigationBarItem(
                            selected = false,
                            onClick = { client.close(); backStack.clear(); backStack.add(Screen.Connect) },
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
                        "⟳ reconnecting… tap to stop",
                        color = androidx.compose.material3.MaterialTheme.colorScheme.onErrorContainer,
                        modifier = Modifier
                            .align(androidx.compose.ui.Alignment.TopCenter)
                            .clickable { client.close() }
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
                if (client.status == Status.Disconnected) {
                    ConnectScreen(client) { showTab(Screen.Sessions) }
                } else NavDisplay(
                    backStack = backStack,
                    onBack = { back() },
                    entryProvider = entryProvider {
                        entry<Screen.Connect> { ConnectScreen(client) { showTab(Screen.Sessions) } }
                        entry<Screen.Tools> {
                            ToolsScreen(
                                client,
                                openDesktop = { open(Screen.Desktop) },
                                openTerminal = { open(Screen.Terminal(it)) },
                                openSsh = { open(Screen.Ssh) },
                                openFreebuff = { open(Screen.Freebuff) },
                                openAgent = { open(Screen.Agent(it)) },
                                openChats = { showTab(Screen.Chats) },
                                lock = lock,
                            )
                        }
                        entry<Screen.Sessions> { SessionsScreen(client, openTerminal = { open(Screen.Terminal(it)) }) }
                        entry<Screen.Chats> { ChatScreen(client, openTerminal = { open(Screen.Terminal(it)) }) }
                        entry<Screen.Files> { FilesScreen(client) }
                        entry<Screen.Freebuff> { FreebuffScreen(client, openDesktop = { open(Screen.Desktop) }) }
                        entry<Screen.Desktop> {
                            DesktopScreen(
                                client,
                                onClose = { back() },
                                fullscreen = desktopFullscreen,
                                onFullscreen = { desktopFullscreen = it },
                                showKeys = desktopKeys,
                                onShowKeys = { desktopKeys = it },
                            )
                        }
                        entry<Screen.Ssh> { SshScreen(client, onClose = { back() }) }
                        entry<Screen.Agent> { AgentScreen(client, it.id, onClose = { back() }, openChats = { showTab(Screen.Chats) }) }
                        entry<Screen.Terminal> { TerminalScreen(client, it.sessionId, onClose = { back() }) }
                    },
                )
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

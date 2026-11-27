package com.yasha.pocketdesk.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.captureRoboImage
import com.yasha.pocketdesk.WsClient
import java.io.File
import java.util.Locale
import java.util.TimeZone
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Golden images of the five screens, rendered on the JVM.
 *
 * Roborazzi runs on Robolectric's runtime, and the iroh link layer has a JVM actual in
 * `src/test/.../IrohLink.kt` that never loads the native library, so no phone or emulator is
 * needed: these are the same five screens `ScreensRenderTest` checks on a device, captured as
 * pixels instead of text.
 *
 * The device config below is part of the golden: changing it changes every image. A plain
 * `testDebugUnitTest` compares against `docs/screenshots/golden/` and fails naming the PNG;
 * `./gradlew :app:recordRoborazziDebug` rewrites them when a design change is intended.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "en-rUS-w412dp-h915dp-port-notnight-xxhdpi")
class ScreensGoldenTest {

    @get:Rule
    val compose = createComposeRule()

    @Before
    fun pinLocaleZoneAndClock() {
        Locale.setDefault(Locale.US)
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"))
    }

    private fun render(screen: @Composable () -> Unit) {
        // An unconnected client is the state a phone draws before it reaches a PC, and it is
        // the only state a host-side test can reach without a PC to talk to.
        compose.setContent { MaterialTheme { screen() } }
        compose.waitForIdle()
    }

    /**
     * Captures the composed screen to [name] under the golden directory.
     *
     * Roborazzi compares in verify mode and writes in record mode; the wrapper names the PNG
     * in the failure so a red run says which screen moved, not only that a byte differed.
     */
    private fun golden(name: String) {
        val dir = System.getProperty("golden.dir")
            ?: error("golden.dir is not set; run the task from Gradle, not the IDE")
        val file = File(dir, name)
        try {
            compose.onRoot().captureRoboImage(file.path)
        } catch (t: Throwable) {
            throw AssertionError("golden screenshots/$name differs from docs/screenshots/golden/$name", t)
        }
    }

    @Test
    fun connect() {
        render { ConnectScreen(WsClient(), onConnected = {}) }
        golden("connect.png")
    }

    @Test
    fun sessions() {
        render { SessionsScreen(WsClient(), openTerminal = {}) }
        golden("sessions.png")
    }

    @Test
    fun chat() {
        render { ChatScreen(WsClient(), openTerminal = {}) }
        golden("chat.png")
    }

    @Test
    fun ssh() {
        render { SshScreen(WsClient(), onClose = {}) }
        golden("ssh.png")
    }

    @Test
    fun deck() {
        render { DeckScreen(WsClient(), onClose = {}) }
        golden("deck.png")
    }
}


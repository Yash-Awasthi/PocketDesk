package com.yasha.pocketdesk

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.yasha.pocketdesk.ui.ChatScreen
import com.yasha.pocketdesk.ui.ConnectScreen
import com.yasha.pocketdesk.ui.DeckScreen
import com.yasha.pocketdesk.ui.SessionsScreen
import com.yasha.pocketdesk.ui.SshScreen
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The five screens a phone lands on, composed for real so layout mistakes fail here
 * instead of on a handset.
 *
 * Every screen is given an unconnected [WsClient]: that is the state a phone is in before it
 * reaches a PC, and it has to draw something recognisable rather than a blank frame or a
 * crash. This runs on the emulator in CI (`.github/workflows/ci.yml`, job
 * `android-emulator`).
 *
 * It is instrumented rather than Robolectric on purpose: these screens pull in iroh's native
 * library, which the JVM test runtime cannot load (`UnsatisfiedLinkError: no iroh_ffi`), so a
 * host-side renderer would test everything except the code that matters.
 */
@RunWith(AndroidJUnit4::class)
class ScreensRenderTest {

    @get:Rule
    val compose = createComposeRule()

    private fun render(screen: @Composable () -> Unit) {
        compose.setContent { MaterialTheme { screen() } }
        compose.waitForIdle()
    }

    /**
     * Waits for [text] to appear, then asserts it is really on screen.
     *
     * An emulator under load can take seconds to lay out the first frame; asserting straight
     * after [render] failed once that way (`No compose hierarchies found in the app`), so every
     * text assertion goes through this wait first.
     */
    private fun assertShown(text: String) {
        val deadline = System.currentTimeMillis() + 20_000
        var last: Throwable? = null
        while (System.currentTimeMillis() < deadline) {
            try {
                if (compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()) {
                    compose.onNodeWithText(text).assertIsDisplayed()
                    return
                }
            } catch (e: IllegalStateException) {
                // "No compose hierarchies found": the host activity has not drawn its first frame yet.
                last = e
            }
            Thread.sleep(200)
        }
        throw AssertionError("\"$text\" never appeared" + (last?.let { " (last: ${it.message})" } ?: ""))
    }

    @Test
    fun connectScreenOffersBothWaysIn() {
        render { ConnectScreen(WsClient(), onConnected = {}) }
        assertShown("Scan QR")
        assertShown("Phone to phone")
    }

    @Test
    fun sessionsScreenOffersANewSession() {
        render { SessionsScreen(WsClient(), openTerminal = {}) }
        assertShown("New session")
    }

    @Test
    fun chatScreenSaysWhenThereAreNoChats() {
        render { ChatScreen(WsClient(), openTerminal = {}) }
        assertShown("Chats")
        assertShown("No active chats")
    }

    @Test
    fun sshScreenDrawsItsToolbar() {
        render { SshScreen(WsClient(), onClose = {}) }
        assertShown("SSH")
    }

    @Test
    fun deckScreenDrawsItsToolbar() {
        render { DeckScreen(WsClient(), onClose = {}) }
        assertShown("Deck")
    }

    @Test
    fun anUnconnectedClientReportsDisconnectedAndTheScreenStillDraws() {
        val client = WsClient()
        render { SessionsScreen(client, openTerminal = {}) }
        assertTrue(
            "expected a disconnected status, got ${client.status}",
            client.status.toString().contains("isconnect", ignoreCase = true),
        )
        assertTrue(
            "the screen drew more than an empty frame",
            compose.onAllNodesWithText("New session").fetchSemanticsNodes().isNotEmpty(),
        )
    }
}

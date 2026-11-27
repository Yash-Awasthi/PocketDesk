package com.yasha.pocketdesk.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.yasha.pocketdesk.RhEvent
import com.yasha.pocketdesk.WsClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * The restart affordance: nothing while the PTY is live, one row after it exits, a confirmation
 * before the request, and both daemon answers drawn.
 */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [34], qualifiers = "en-rUS-w412dp-h915dp-port-notnight-xxhdpi")
class RestartSessionTest {

    @get:Rule
    val compose = createComposeRule()

    private val sent = mutableListOf<String>()

    private fun screen(ws: WsClient) {
        compose.setContent {
            MaterialTheme {
                SessionsScreen(ws, openTerminal = {}, send = { sent += it; true })
            }
        }
        compose.waitForIdle()
    }

    private fun showRestartRow() {
        compose.onNodeWithTag("sessions.list").performScrollToNode(hasTestTag("sessionRestart"))
        compose.waitForIdle()
    }

    @Test
    fun `hidden while live, then shown with the old shell note once the pty exits`() {
        val ws = WsClient()
        screen(ws)
        compose.onNodeWithTag("sessionRestart").assertDoesNotExist()

        ws.events.tryEmit(RhEvent.Exit("s7", "node", 0))
        compose.waitForIdle()
        showRestartRow()

        compose.onNodeWithTag("sessionRestart").assertExists()
        compose.onNodeWithTag("sessionRestart.ask").assertExists()
        compose.onNodeWithTag("sessionRestart.what")
            .assertTextContains("The old shell is gone", substring = true)
            .assertTextContains("against a new shell", substring = true)
    }

    @Test
    fun `the action asks first and only then sends the resume`() {
        val ws = WsClient()
        screen(ws)
        ws.events.tryEmit(RhEvent.Exit("s8", "node", 1))
        compose.waitForIdle()
        showRestartRow()

        compose.onNodeWithTag("sessionRestart.ask").performClick()
        compose.waitForIdle()
        assertTrue("the request must wait for the confirmation", sent.isEmpty())
        compose.onNodeWithTag("sessionRestart.confirm").assertExists()
        compose.onNodeWithTag("sessionRestart.cancel").performClick()
        compose.waitForIdle()
        assertTrue("cancel must not send", sent.isEmpty())

        compose.onNodeWithTag("sessionRestart.ask").performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("sessionRestart.confirm").performClick()
        compose.waitForIdle()

        assertEquals(listOf(sessionResumeMessage("s8")), sent)
        compose.onNodeWithTag("sessionRestart.requested").assertExists()
    }

    @Test
    fun `an expired answer renders as the window having passed`() {
        val ws = WsClient()
        screen(ws)
        ws.events.tryEmit(RhEvent.Exit("s9", "node", 0))
        compose.waitForIdle()
        showRestartRow()
        compose.onNodeWithTag("sessionRestart.ask").performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("sessionRestart.confirm").performClick()
        compose.waitForIdle()

        ws.events.tryEmit(RhEvent.Failure("session_resume: expired: s9"))
        compose.waitForIdle()
        compose.onNodeWithTag("sessionRestart.outcome")
            .assertTextContains("restart window has passed", substring = true)
    }

    @Test
    fun `a resumed session renders as restarted`() {
        compose.setContent {
            MaterialTheme { SessionRestartCard("s10", 0, RestartPhase.Resumed, onRestart = {}) }
        }
        compose.waitForIdle()
        compose.onNodeWithTag("sessionRestart.outcome")
            .assertTextContains("Restarted", substring = true)
            .assertTextContains("old shell is gone", substring = true)
    }

    @Test
    fun `the resume message names the session and nothing else`() {
        assertEquals("""{"type":"session_resume","id":"s3"}""", sessionResumeMessage("s3"))
    }
}
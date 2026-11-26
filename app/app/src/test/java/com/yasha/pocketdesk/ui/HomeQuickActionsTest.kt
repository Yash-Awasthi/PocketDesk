package com.yasha.pocketdesk.ui

import android.content.Context
import android.content.SharedPreferences
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.yasha.pocketdesk.Screen
import com.yasha.pocketdesk.ServerEntry
import com.yasha.pocketdesk.quickActionDestination
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The per-PC quick-action grid on the home screen: each action opens its surface for that PC,
 * and the saved order and hidden set survive the screen being recreated.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "en-rUS-w412dp-h915dp-port-notnight-xxhdpi")
class HomeQuickActionsTest {

    @get:Rule
    val compose = createComposeRule()

    private val pc = ServerEntry("Desk", "wss://desk.example:8765/ws", "token")

    private lateinit var prefs: SharedPreferences
    private var round = mutableIntStateOf(0)

    private val store get() = QuickActionsStore(prefs)

    @Before
    fun freshPreferences() {
        prefs = ApplicationProvider.getApplicationContext<Context>()
            .getSharedPreferences("home-quick-actions-test", Context.MODE_PRIVATE)
        prefs.edit().clear().commit()
        round = mutableIntStateOf(0)
    }

    private fun render(onAction: (QuickAction, ServerEntry) -> Unit = { _, _ -> }) {
        val grid = QuickActionsStore(prefs)
        compose.setContent {
            MaterialTheme {
                // A new key throws away the grid's remembered state the way an activity recreation does.
                key(round.intValue) {
                    QuickActionsGrid(entry = pc, store = grid, enabled = true, onAction = onAction)
                }
            }
        }
    }

    private fun recreate() {
        compose.runOnUiThread { round.intValue++ }
        compose.waitForIdle()
    }

    private fun bounds(tag: String) = compose.onNodeWithTag(tag).fetchSemanticsNode().boundsInRoot

    @Test
    fun `each quick action opens its screen for that pc`() {
        val opened = mutableListOf<Pair<QuickAction, String>>()
        render { action, entry -> opened += action to entry.url }

        val expected = mapOf(
            QuickAction.Chat to Screen.Chats,
            QuickAction.Terminal to Screen.Sessions,
            QuickAction.Files to Screen.Files,
            QuickAction.Desktop to Screen.Desktop,
        )
        for (action in QuickAction.entries) {
            compose.onNodeWithTag("quick-action-" + action.id).assertIsDisplayed().performClick()
            assertEquals(expected[action], quickActionDestination(action))
        }
        assertEquals(QuickAction.entries.map { it to pc.url }, opened)
    }

    @Test
    fun `reorder persists when the screen is recreated`() {
        render()
        compose.onNodeWithTag("quick-actions-edit").performClick()
        compose.onNodeWithTag("action-up-files").performClick()
        assertEquals(listOf("chat", "files", "terminal", "desktop"), store.load().order)

        recreate()

        assertEquals(listOf("chat", "files", "terminal", "desktop"), store.load().order)
        val chat = bounds("quick-action-chat")
        val files = bounds("quick-action-files")
        assertEquals(chat.top, files.top, 0.5f)
        assertTrue(files.left > chat.left)
    }

    @Test
    fun `hiding persists and the hidden action is not drawn`() {
        render()
        compose.onNodeWithTag("quick-actions-edit").performClick()
        compose.onNodeWithTag("action-toggle-files").performClick()
        compose.onNodeWithTag("quick-actions-edit").performClick()
        compose.onNodeWithTag("quick-action-files").assertDoesNotExist()
        assertEquals(listOf("files"), store.load().hidden)

        recreate()

        compose.onNodeWithTag("quick-action-files").assertDoesNotExist()
        compose.onNodeWithTag("quick-actions-edit").performClick()
        compose.onNodeWithTag("action-toggle-files").performClick()
        compose.onNodeWithTag("quick-actions-edit").performClick()
        compose.onNodeWithTag("quick-action-files").assertIsDisplayed()
        assertTrue(store.load().hidden.isEmpty())
    }

    @Test
    fun `reset restores the default order and shows every action`() {
        store.save(QuickActionsLayout.default().moved(QuickAction.Desktop, -3).toggled(QuickAction.Chat))
        render()
        compose.onNodeWithTag("quick-actions-edit").performClick()
        compose.onNodeWithTag("quick-actions-reset").performClick()
        assertEquals(QuickActionsLayout.default(), store.load())

        compose.onNodeWithTag("quick-actions-edit").performClick()
        for (action in QuickAction.entries) {
            compose.onNodeWithTag("quick-action-" + action.id).assertIsDisplayed()
        }
        val chat = bounds("quick-action-chat")
        val terminal = bounds("quick-action-terminal")
        val files = bounds("quick-action-files")
        assertEquals(chat.top, terminal.top, 0.5f)
        assertTrue(terminal.left > chat.left)
        assertTrue(files.top > chat.top)
    }

    @Test
    fun `every quick action and edit control is at least 48 dp`() {
        val min = 48f * ApplicationProvider.getApplicationContext<Context>().resources.displayMetrics.density
        render()
        for (action in QuickAction.entries) {
            assertTarget("quick-action-" + action.id, min)
        }
        compose.onNodeWithTag("quick-actions-edit").performClick()
        for (tag in listOf(
            "quick-actions-edit",
            "action-up-files",
            "action-down-files",
            "action-toggle-files",
            "quick-actions-reset",
        )) {
            assertTarget(tag, min)
        }
    }

    private fun assertTarget(tag: String, min: Float) {
        val size = compose.onNodeWithTag(tag).fetchSemanticsNode().size
        assertTrue(
            tag + " target is " + size.width + "x" + size.height + " px, under " + min + " px (48 dp)",
            size.width >= min - 1f && size.height >= min - 1f,
        )
    }
}
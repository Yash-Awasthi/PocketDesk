package com.yasha.pocketdesk.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.MutableState
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertWidthIsAtLeast
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.captureRoboImage
import com.yasha.pocketdesk.Manifest
import com.yasha.pocketdesk.SessionSummary
import com.yasha.pocketdesk.ToolInfo
import com.yasha.pocketdesk.WsClient
import java.io.File
import java.util.Locale
import java.util.TimeZone
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The sessions screen at the three widths it meets: a compact phone, a tablet, and a foldable
 * with a hinge. The helper decides the panes; these tests pin what is composed and where the
 * pane boundary lands, so a layout that ignores the width fails by width.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34])
class SessionsLayoutTest {

    @get:Rule
    val compose = createComposeRule()

    @Before
    fun pinLocaleAndZone() {
        Locale.setDefault(Locale.US)
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"))
    }

    /**
     * The PC fills a client over the link and its setters are private, so a host test has no
     * public way to hand it a session. This writes the Compose state the screen reads, the same
     * value a "welcome" frame would have put there.
     */
    private fun WsClient.fill(name: String, value: Any) {
        val cls = WsClient::class.java
        val delegated = runCatching { cls.getDeclaredField("$name\$delegate") }.getOrNull()
        if (delegated != null) {
            delegated.isAccessible = true
            @Suppress("UNCHECKED_CAST")
            (delegated.get(this) as MutableState<Any?>).value = value
            return
        }
        val setter = cls.getDeclaredMethod("set" + name.replaceFirstChar { it.uppercaseChar() }, value.javaClass)
        setter.isAccessible = true
        setter.invoke(this, value)
    }

    private fun client() = WsClient().apply {
        fill("tools", listOf(ToolInfo(Manifest("claude", "Claude", "claude"), installed = true, version = "2.1", installing = false)))
        fill("sessions", listOf(SessionSummary("pd-1", "claude", "/home/yash/proj")))
        recordings = listOf("2026-11-26T10-00-00.cast")
    }
    private fun render(foldAt: Dp? = null) {
        val ws = client()
        compose.setContent { MaterialTheme { SessionsScreen(ws, openTerminal = {}, foldAt = foldAt) } }
        compose.waitForIdle()
    }

    /**
     * The row actions are the smallest targets on the screen. Material draws InkWell-sized boxes
     * below 48 dp, so this asserts the box the row lays out, which is what a thumb meets.
     */
    private fun assertTouchTargets(width: String) {
        for (tag in listOf("sessions.attach", "sessions.kill")) {
            val node = compose.onNodeWithTag(tag)
            node.assertExists()
            try {
                node.assertWidthIsAtLeast(MinTouchTarget)
                node.assertHeightIsAtLeast(MinTouchTarget)
            } catch (t: Throwable) {
                throw AssertionError("$width: $tag does not clear $MinTouchTarget", t)
            }
        }
    }

    private fun pxToDp(px: Float): Float =
        px / RuntimeEnvironment.getApplication().resources.displayMetrics.density

    private fun boundsDp(tag: String): Pair<Float, Float> {
        val b = compose.onNodeWithTag(tag).fetchSemanticsNode().boundsInRoot
        return pxToDp(b.left) to pxToDp(b.right)
    }

    private fun golden(name: String) {
        val dir = System.getProperty("golden.dir")
            ?: error("golden.dir is not set; run the task from Gradle, not the IDE")
        try {
            compose.onRoot().captureRoboImage(File(dir, name).path)
        } catch (t: Throwable) {
            throw AssertionError("golden screenshots/$name differs from docs/screenshots/golden/$name", t)
        }
    }

    @Test
    @Config(qualifiers = "en-rUS-w412dp-h915dp-port-notnight-xxhdpi")
    fun `412dp compact phone shows the list and no detail pane`() {
        render()
        compose.onNodeWithTag("sessions.list").assertExists()
        compose.onNodeWithTag("sessions.detail").assertDoesNotExist()
        assertEquals(SessionPanes.Single, sessionsLayout(412.dp).panes)
        // 600 dp is the first width that fits both panes.
        assertEquals(SessionPanes.Single, sessionsLayout(600.dp - 1.dp).panes)
        assertEquals(SessionPanes.SideBySide, sessionsLayout(600.dp).panes)
        assertTouchTargets("412dp")
    }

    @Test
    @Config(qualifiers = "en-rUS-w800dp-h1280dp-port-notnight-xxhdpi")
    fun `800dp tablet shows the list and the detail pane together`() {
        render()
        val layout = sessionsLayout(800.dp)
        assertEquals("800dp is a tablet width", SessionPanes.SideBySide, layout.panes)
        assertEquals(320.dp, layout.listWidth)
        compose.onNodeWithTag("sessions.list").assertExists()
        compose.onNodeWithTag("sessions.detail").assertExists()
        val (listLeft, listRight) = boundsDp("sessions.list")
        val (detailLeft, detailRight) = boundsDp("sessions.detail")
        assertEquals("800dp: the list starts at the left edge", 0f, listLeft, 1f)
        assertEquals("800dp: the divider sits on the list's right edge", 320f, listRight, 1.5f)
        assertTrue("800dp: the detail pane starts after the divider", detailLeft >= 320f)
        assertTrue(
            "800dp: the detail pane keeps a pane's width, got ${detailRight - detailLeft}dp",
            detailRight - detailLeft >= MinPaneWidth.value,
        )
        assertTouchTargets("800dp")
    }

    @Test
    @Config(qualifiers = "en-rUS-w673dp-h841dp-port-notnight-xxhdpi")
    fun `673dp foldable puts the pane boundary on the hinge`() {
        val fold = 336.dp
        render(foldAt = fold)
        val layout = sessionsLayout(673.dp, fold)
        assertEquals(SessionPanes.SideBySide, layout.panes)
        assertEquals(fold, layout.boundary)
        compose.onNodeWithTag("sessions.detail").assertExists()
        val (listLeft, listRight) = boundsDp("sessions.list")
        val (detailLeft, _) = boundsDp("sessions.detail")
        assertEquals("673dp: the list starts at the fold's left edge", 0f, listLeft, 1f)
        assertTrue("673dp: the list ends at the hinge, not across it, got ${listRight}dp", listRight <= fold.value + 1f)
        assertTrue("673dp: the detail starts at the hinge, not across it, got ${detailLeft}dp", detailLeft >= fold.value)
        assertTouchTargets("673dp")

        // A hinge 120 dp from the edge leaves a sliver: draw on the wider side only.
        val sliver = sessionsLayout(700.dp, 120.dp)
        assertEquals(SessionPanes.Confined, sliver.panes)
        assertNull("700dp with a 120dp hinge: no divider to cross the fold", sliver.boundary)
        assertEquals(120.dp, sliver.start)
        assertEquals(580.dp, sliver.listWidth)
    }

    @Test
    @Config(qualifiers = "en-rUS-w800dp-h1280dp-port-notnight-xxhdpi")
    fun `tablet golden`() {
        render()
        golden("sessions-tablet.png")
    }

    @Test
    @Config(qualifiers = "en-rUS-w673dp-h841dp-port-notnight-xxhdpi")
    fun `foldable golden`() {
        render(foldAt = 336.dp)
        golden("sessions-foldable.png")
    }
}

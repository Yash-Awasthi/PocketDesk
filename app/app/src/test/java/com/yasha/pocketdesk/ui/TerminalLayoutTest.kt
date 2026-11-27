package com.yasha.pocketdesk.ui

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertWidthIsAtLeast
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.captureRoboImage
import java.io.File
import java.util.Locale
import java.util.TimeZone
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
 * The terminal at the three widths it meets: a compact phone, a tablet, and a foldable with a
 * hinge. The helper decides the arrangement; these tests pin what is composed and where the
 * boundary lands, so a layout that ignores the width fails by width.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34])
class TerminalLayoutTest {

    @get:Rule
    val compose = createComposeRule()

    @Before
    fun pinLocaleAndZone() {
        Locale.setDefault(Locale.US)
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"))
    }

    private fun prefs() =
        RuntimeEnvironment.getApplication().getSharedPreferences("terminal-layout", Context.MODE_PRIVATE)

    /**
     * The same chrome, keys and preview the screen draws, so a golden shows the arrangement rather
     * than only the numbers: the terminal body is the preview's own declared cell.
     */
    private fun render(width: Dp, foldAt: Dp? = null, fontPx: Int = TerminalFont.DEFAULT_PX) {
        compose.setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
                    val layout = terminalLayout(width, foldAt)
                    TerminalFrame(
                        layout = layout,
                        chrome = {
                            TerminalChrome(
                                sessionId = "pd-7f3c",
                                fontPx = fontPx,
                                ctrl = false,
                                alt = false,
                                enabled = true,
                                onFontSmaller = {},
                                onFontLarger = {},
                                onCopy = {},
                                onKey = {},
                                onClose = {},
                                onKill = {},
                                keysBeside = layout.keysBeside,
                            )
                        },
                        keys = {
                            TerminalKeyPanel(
                                ctrl = false,
                                alt = false,
                                enabled = true,
                                onKey = {},
                                perRow = keysPerRow(layout.keysWidth),
                                modifier = Modifier.width(layout.keysWidth).fillMaxHeight(),
                            )
                        },
                        body = { fill -> TerminalFontPreview(fontPx, fill.testTag("terminal.body")) },
                    )
                }
            }
        }
        compose.waitForIdle()
    }

    private fun pxToDp(px: Float): Float =
        px / RuntimeEnvironment.getApplication().resources.displayMetrics.density

    /** left, top, right, bottom in dp. */
    private fun rect(tag: String): FloatArray {
        val b = compose.onNodeWithTag(tag).fetchSemanticsNode().boundsInRoot
        return floatArrayOf(pxToDp(b.left), pxToDp(b.top), pxToDp(b.right), pxToDp(b.bottom))
    }

    /** Every extra key is a thumb target at every width and in every arrangement. */
    private fun assertEveryKeyClears48(width: String) {
        for (key in ExtraKey.ROW) {
            val node = compose.onNodeWithTag("terminalKey.${key.label}")
            node.assertExists()
            try {
                node.assertWidthIsAtLeast(48.dp)
                node.assertHeightIsAtLeast(48.dp)
            } catch (t: Throwable) {
                throw AssertionError("$width: ${key.label} does not clear 48 dp", t)
            }
        }
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
    fun `412dp compact keeps one column with the key row over the text`() {
        val layout = terminalLayout(412.dp)
        assertEquals(TerminalPanes.Single, layout.panes)
        assertFalse("412dp: no key column beside the text", layout.keysBeside)
        assertEquals(0.dp, layout.start)
        assertEquals(412.dp, layout.terminalWidth)
        assertNull("412dp: no divider to draw", layout.boundary)

        render(412.dp)
        compose.onNodeWithTag("terminal.keys").assertDoesNotExist()
        val keys = rect("terminalKey.Ctrl")
        val body = rect("terminal.body")
        assertTrue("412dp: the key row stays over the text, not beside it", keys[3] <= body[1] + 1f)
        assertEquals("412dp: one column starts at the left edge", 0f, body[0], 1f)
        assertEquals("412dp: the column fills the phone", 412f, body[2], 1.5f)
        assertEveryKeyClears48("412dp")
    }

    @Test
    @Config(qualifiers = "en-rUS-w800dp-h1280dp-port-notnight-xxhdpi")
    fun `800dp tablet puts the key column beside the terminal`() {
        assertEquals(
            "800dp must pick the tablet layout",
            TerminalPanes.SideBySide,
            terminalLayout(800.dp).panes,
        )
        assertEquals(
            "one dp below 800dp is still one column",
            TerminalPanes.Single,
            terminalLayout(800.dp - 1.dp).panes,
        )
        val layout = terminalLayout(800.dp)
        assertEquals(KeyColumnWidth, layout.keysWidth)
        assertEquals(KeyColumnWidth, layout.terminalStart)
        assertEquals(800.dp - KeyColumnWidth, layout.terminalWidth)
        assertTrue("800dp: the terminal keeps a usable width", layout.terminalWidth >= TerminalMinWidth)

        render(800.dp)
        compose.onNodeWithTag("terminal.keys").assertExists()
        val keys = rect("terminal.keys")
        val body = rect("terminal.body")
        assertEquals("800dp: the key column is one key wide", 112f, keys[2] - keys[0], 1.5f)
        assertTrue(
            "800dp: the key column ends at the divider, got ${keys[2]}dp",
            keys[2] <= body[0] + 1.5f,
        )
        assertEquals("800dp: the terminal starts after the key column", 112f, body[0], 1.5f)
        val shared = minOf(keys[3], body[3]) - maxOf(keys[1], body[1])
        assertTrue("800dp: the keys share the terminal's rows, overlap ${shared}dp", shared > 48f)
        assertEveryKeyClears48("800dp")
    }

    @Test
    @Config(qualifiers = "en-rUS-w673dp-h841dp-port-notnight-xxhdpi")
    fun `673dp foldable leaves the hinge empty`() {
        val fold = 336.dp
        val layout = terminalLayout(673.dp, fold)
        assertEquals(TerminalPanes.SideBySide, layout.panes)
        assertEquals(fold, layout.boundary)
        assertTrue(
            "673dp: the terminal side keeps a usable width, got ${layout.terminalWidth}",
            layout.terminalWidth >= TerminalMinWidth,
        )

        render(673.dp, fold)
        val body = rect("terminal.body")
        val keys = rect("terminal.keys")
        assertTrue("673dp: the terminal ends at the hinge, got ${body[2]}dp", body[2] <= 337f)
        assertTrue("673dp: the keys start at the hinge, got ${keys[0]}dp", keys[0] >= 335f)
        assertTrue(
            "673dp: the terminal keeps ${TerminalMinWidth}, got ${body[2] - body[0]}dp",
            body[2] - body[0] >= TerminalMinWidth.value,
        )
        assertEveryKeyClears48("673dp")
    }

    @Test
    @Config(qualifiers = "en-rUS-w700dp-h1280dp-port-notnight-xxhdpi")
    fun `a hinge near the edge confines the screen to the wider side`() {
        val sliver = terminalLayout(700.dp, 120.dp)
        assertEquals(TerminalPanes.Confined, sliver.panes)
        assertNull("700dp: no divider to cross the fold", sliver.boundary)
        assertEquals(120.dp, sliver.start)
        assertEquals(580.dp, sliver.width)
        assertFalse("700dp: the key row is under the text", sliver.keysBeside)

        render(700.dp, 120.dp)
        val body = rect("terminal.body")
        val keys = rect("terminalKey.Ctrl")
        assertTrue("700dp: nothing is drawn on the narrow side, got ${body[0]}dp", body[0] >= 119f)
        assertTrue("700dp: the terminal stops at the window edge, got ${body[2]}dp", body[2] <= 700f)
        assertTrue("700dp: the key row moves to the wider side too, got ${keys[0]}dp", keys[0] >= 119f)
        assertTrue("700dp: the key row stays over the text", keys[3] <= body[1] + 1f)
        assertEveryKeyClears48("700dp")
    }

    @Test
    @Config(qualifiers = "en-rUS-w800dp-h1280dp-port-notnight-xxhdpi")
    fun `the remembered font size still reaches the tablet terminal`() {
        val prefs = prefs()
        prefs.edit().clear().commit()
        TerminalFont.save(prefs, TerminalFont.larger(TerminalFont.DEFAULT_PX))
        val px = TerminalFont.load(prefs())
        assertEquals("a saved size survives into the tablet layout", 17, px)

        render(800.dp, fontPx = px)
        compose.onNodeWithText("17px").assertExists()
        val cell = TerminalFont.metrics(px)
        compose.onNodeWithText("font 17px, cell ${cell.widthPx}x${cell.heightPx}px").assertExists()
        assertEquals("window.termFont(17,11,21)", TerminalFont.pageScript(px))
        assertTrue("the same declared cell, not only the glyphs", cell.widthPx == 11 && cell.heightPx == 21)
    }

    @Test
    @Config(qualifiers = "en-rUS-w800dp-h1280dp-port-notnight-xxhdpi")
    fun `tablet golden`() {
        render(800.dp)
        golden("terminal-tablet.png")
    }

    @Test
    @Config(qualifiers = "en-rUS-w673dp-h841dp-port-notnight-xxhdpi")
    fun `foldable golden`() {
        render(673.dp, 336.dp)
        golden("terminal-foldable.png")
    }
}

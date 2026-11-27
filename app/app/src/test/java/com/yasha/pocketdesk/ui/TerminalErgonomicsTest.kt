package com.yasha.pocketdesk.ui

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertWidthIsAtLeast
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.captureRoboImage
import java.io.File
import java.util.Locale
import java.util.TimeZone
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Terminal ergonomics: a remembered bounded font size whose cell follows, selection copy that
 * leaves the selection in place, and one-handed extra keys with 48 dp targets.
 *
 * The goldens are the reviewable half: the same chrome and the same declared cell at the default
 * and the largest step, so a font change that only moved the text would show up as identical
 * images with a different label.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "en-rUS-w412dp-h915dp-port-notnight-xxhdpi")
class TerminalErgonomicsTest {

    @get:Rule
    val compose = createComposeRule()

    @Before
    fun pinLocaleZoneAndClock() {
        Locale.setDefault(Locale.US)
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"))
    }

    private fun prefs() =
        RuntimeEnvironment.getApplication().getSharedPreferences("terminal-test", Context.MODE_PRIVATE)

    @Test
    fun `font size preference persists and changes the declared cell size`() {
        val prefs = prefs()
        prefs.edit().clear().commit()
        assertEquals(
            "a fresh terminal starts at the default size",
            TerminalFont.DEFAULT_PX,
            TerminalFont.load(prefs),
        )

        TerminalFont.save(prefs, TerminalFont.larger(TerminalFont.DEFAULT_PX))
        val reopened = prefs()
        assertEquals(
            "a saved font size must survive a new terminal screen",
            17,
            TerminalFont.load(reopened),
        )

        // A stale value from before the control existed still opens at a readable size.
        prefs.edit().putInt(TerminalFont.PREF_KEY, 4).commit()
        assertEquals(
            "a stored size below the readable minimum must not open tiny",
            TerminalFont.STEPS.first(),
            TerminalFont.load(prefs),
        )
        prefs.edit().putInt(TerminalFont.PREF_KEY, 400).commit()
        assertEquals(TerminalFont.STEPS.last(), TerminalFont.load(prefs))

        val small = TerminalFont.metrics(TerminalFont.STEPS.first())
        val large = TerminalFont.metrics(TerminalFont.STEPS.last())
        assertEquals(
            "the cell must grow with the font, not only the glyphs",
            true,
            large.widthPx > small.widthPx && large.heightPx > small.heightPx,
        )
        assertEquals(8, small.widthPx)
        assertEquals(16, small.heightPx)
        assertEquals(14, large.widthPx)
        assertEquals(27, large.heightPx)
        assertTrue("the declared row is never shorter than 1.2 em", large.lineHeight >= 1.2f)
        assertTrue(
            "a larger cell must fit fewer columns in the same viewport",
            large.cols(1080) < small.cols(1080),
        )
        assertEquals("window.termFont(22,14,27)", TerminalFont.pageScript(TerminalFont.STEPS.last()))
    }

    @Test
    fun `font size steps are three, ordered and never below the readable minimum`() {
        assertEquals(3, TerminalFont.STEPS.size)
        assertEquals(TerminalFont.STEPS.sorted(), TerminalFont.STEPS)
        assertTrue(TerminalFont.STEPS.first() >= TerminalFont.MIN_PX)
        assertEquals(TerminalFont.STEPS.first(), TerminalFont.smaller(TerminalFont.STEPS.first()))
        assertEquals(TerminalFont.STEPS.last(), TerminalFont.larger(TerminalFont.STEPS.last()))
        assertEquals(17, TerminalFont.larger(TerminalFont.STEPS.first()))
        assertEquals(17, TerminalFont.smaller(TerminalFont.STEPS.last()))
    }

    @Test
    fun `selection copy writes the exact text and leaves the selection in place`() {
        val selected = "line one\r\n  tab\there: \u00e9\u2713 \"quoted\""
        val terminal = FakeTerminal(selected)
        val copied = mutableListOf<String>()
        var confirmations = 0

        val done = copySelection(terminal::selection, ClipboardSink { copied += it }) { confirmations++ }

        assertTrue("a non-empty selection is copyable", done)
        assertEquals("the clipboard must hold exactly the selected text", listOf(selected), copied)
        assertEquals("copying must not steal the selection", selected, terminal.selection())
        assertEquals("one confirmation per copy", 1, confirmations)
        assertEquals(0, terminal.clears)
    }

    @Test
    fun `an empty selection copies nothing and confirms nothing`() {
        val terminal = FakeTerminal("")
        var writes = 0
        var confirmations = 0
        val done = copySelection(terminal::selection, ClipboardSink { writes++ }) { confirmations++ }
        assertFalse(done)
        assertEquals(0, writes)
        assertEquals(0, confirmations)
        assertEquals("", terminal.selection())
    }

    @Test
    fun `the page's JSON selection is unquoted, newlines and all`() {
        assertEquals("a\nb", jsString("\"a\\nb\""))
        assertEquals("say \"hi\"", jsString("\"say \\\"hi\\\"\""))
        assertEquals("", jsString("\"\""))
        assertEquals(null, jsString("null"))
        assertEquals(null, jsString("undefined"))
    }

    @Test
    fun `each extra key sends its own byte sequence`() {
        assertEquals("\u001b", ExtraKey.ESC.bytes)
        assertEquals("\t", ExtraKey.TAB.bytes)
        assertEquals("\u001b[A", ExtraKey.UP.bytes)
        assertEquals("\u001b[B", ExtraKey.DOWN.bytes)
        assertEquals("\u001b[D", ExtraKey.LEFT.bytes)
        assertEquals("\u001b[C", ExtraKey.RIGHT.bytes)
        assertEquals(
            listOf(ExtraKey.CTRL, ExtraKey.ALT, ExtraKey.ESC, ExtraKey.TAB, ExtraKey.UP, ExtraKey.DOWN, ExtraKey.LEFT, ExtraKey.RIGHT),
            ExtraKey.ROW,
        )
        assertTrue(ExtraKey.CTRL.isModifier && ExtraKey.ALT.isModifier)
        assertTrue(!ExtraKey.ESC.isModifier)
    }

    @Test
    fun `an armed Ctrl or Alt changes exactly the next character on the wire`() {
        val armer = ModifierArmer()
        armer.toggle(ExtraKey.CTRL)
        assertTrue(armer.ctrl)
        assertEquals("Ctrl+c is ^C", "\u0003", armer.apply("c"))
        assertFalse("Ctrl is one-shot", armer.ctrl)
        assertEquals("plain typing after that", "c", armer.apply("c"))

        armer.toggle(ExtraKey.ALT)
        assertEquals("Alt+x is ESC x", "\u001bx", armer.apply("x"))
        assertFalse(armer.alt)

        armer.toggle(ExtraKey.CTRL)
        armer.toggle(ExtraKey.ALT)
        assertEquals("Ctrl+Alt+d is ESC ^D", "\u001b\u0004", armer.apply("d"))

        armer.toggle(ExtraKey.ALT)
        assertEquals("an arrow keeps its own encoding", "\u001b[A", armer.apply("\u001b[A"))
        assertFalse("the arming is spent, not stacked", armer.alt)

        armer.toggle(ExtraKey.CTRL)
        assertEquals(
            "the bridge sends the control byte, not the letter",
            b64("\u0003"),
            armedInput(b64("c"), armer),
        )
    }

    @Test
    fun `every extra key target is at least 48 dp`() {
        compose.setContent {
            MaterialTheme {
                TerminalKeyRow(ctrl = false, alt = false, enabled = true, onKey = {})
            }
        }
        compose.waitForIdle()
        for (key in ExtraKey.ROW) {
            val node = compose.onNodeWithTag("terminalKey.${key.label}")
            node.assertExists()
            node.assertHeightIsAtLeast(48.dp)
            node.assertWidthIsAtLeast(48.dp)
        }
    }

    @Test
    fun `default font golden`() {
        renderTerminal(TerminalFont.STEPS.first())
        golden("terminal-default.png")
    }

    @Test
    fun `large font golden`() {
        renderTerminal(TerminalFont.STEPS.last())
        golden("terminal-large-font.png")
    }

    private fun renderTerminal(fontPx: Int) {
        compose.setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
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
                    )
                    TerminalFontPreview(fontPx, Modifier.weight(1f))
                }
            }
        }
        compose.waitForIdle()
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

    /** A terminal that only ever hands out its selection; nothing here can clear it. */
    private class FakeTerminal(private val selected: String) {
        var clears = 0
        fun selection(): String = selected
    }
}
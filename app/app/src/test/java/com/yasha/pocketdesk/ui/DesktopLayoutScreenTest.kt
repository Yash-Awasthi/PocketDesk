package com.yasha.pocketdesk.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.yasha.pocketdesk.WsClient
import java.util.Locale
import java.util.TimeZone
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The desktop viewer at the three widths it meets: a compact phone, a tablet, and a foldable with
 * a hinge. [desktopLayout] decides the panes; these tests pin what is composed and where the rail
 * lands, so a layout that ignores the width fails by width.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34])
class DesktopLayoutScreenTest {

    @get:Rule
    val compose = createComposeRule()

    @Before
    fun pinLocaleZoneAndClock() {
        Locale.setDefault(Locale.US)
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"))
    }

    private fun render(foldAt: Dp? = null) {
        // An unconnected client draws the paused desktop, so no PC is needed.
        val ws = WsClient()
        compose.setContent {
            MaterialTheme {
                DesktopScreen(
                    ws,
                    onClose = {},
                    fullscreen = false,
                    onFullscreen = {},
                    showKeys = false,
                    onShowKeys = {},
                    foldAt = foldAt,
                )
            }
        }
        compose.waitForIdle()
    }

    private class Bounds(val left: Float, val top: Float, val right: Float, val bottom: Float) {
        val width: Float get() = right - left
        val height: Float get() = bottom - top
    }

    private fun boundsDp(node: SemanticsNodeInteraction): Bounds {
        val b = node.fetchSemanticsNode().boundsInRoot
        val d = RuntimeEnvironment.getApplication().resources.displayMetrics.density
        return Bounds(b.left / d, b.top / d, b.right / d, b.bottom / d)
    }

    private fun boundsDp(tag: String): Bounds = boundsDp(compose.onNodeWithTag(tag))

    @Test
    @Config(qualifiers = "en-rUS-w412dp-h915dp-port-notnight-xxhdpi")
    fun `412dp compact keeps the controls under the picture`() {
        render()
        compose.onNodeWithTag("desktop.rail").assertDoesNotExist()
        compose.onNodeWithTag("desktop.picture").assertExists()
        compose.onNodeWithTag("desktop.controls").assertExists()

        val picture = boundsDp("desktop.picture")
        assertEquals("412dp compact: the picture starts at the left edge, got ${picture.left} dp", 0f, picture.left, 1.5f)
        assertEquals("412dp compact: the picture spans the 412 dp window, got right ${picture.right} dp", 412f, picture.right, 1.5f)
        assertEquals("412dp compact: the picture is 412 dp wide, got ${picture.width} dp", 412f, picture.width, 1.5f)

        val controls = boundsDp("desktop.controls")
        assertTrue(
            "412dp compact: the controls sit under the picture, got top ${controls.top} dp and picture bottom ${picture.bottom} dp",
            controls.top >= picture.bottom,
        )
    }

    @Test
    @Config(qualifiers = "en-rUS-w800dp-h1280dp-port-notnight-xxhdpi")
    fun `800dp tablet puts the control rail beside the picture`() {
        render()
        compose.onNodeWithTag("desktop.picture").assertExists()
        compose.onNodeWithTag("desktop.rail").assertExists()
        compose.onNodeWithTag("desktop.controls").assertExists()

        val picture = boundsDp("desktop.picture")
        val rail = boundsDp("desktop.rail")
        assertTrue(
            "800dp: the picture ends at the rail (picture right ${picture.right} dp, rail left ${rail.left} dp)",
            picture.right <= rail.left + 1f,
        )
        assertTrue("800dp: the rail reaches the right edge, got right ${rail.right} dp", rail.right >= 798f)
        assertEquals("800dp: the rail is one 112 dp column, got ${rail.width} dp wide", 112f, rail.width, 1.5f)
        assertTrue("800dp: the picture keeps at least 320 dp, got ${picture.width} dp wide", picture.width >= 320f)

        val controls = boundsDp("desktop.controls")
        assertTrue(
            "800dp: the controls start inside the rail (controls left ${controls.left} dp, rail left ${rail.left} dp)",
            controls.left >= rail.left,
        )
        assertTrue(
            "800dp: the controls end inside the rail (controls right ${controls.right} dp, rail right ${rail.right} dp)",
            controls.right <= rail.right + 1f,
        )

        val r = boundsDp(compose.onNodeWithText("R"))
        assertTrue("800dp: R is a 48 dp thumb target, got ${r.height} dp tall", r.height >= 48f)
        assertTrue("800dp: R is a 48 dp thumb target, got ${r.width} dp wide", r.width >= 48f)
    }

    @Test
    @Config(qualifiers = "en-rUS-w673dp-h841dp-port-notnight-xxhdpi")
    fun `673dp foldable keeps the hinge empty`() {
        render(foldAt = 336.dp)
        compose.onNodeWithTag("desktop.rail").assertExists()

        val picture = boundsDp("desktop.picture")
        val rail = boundsDp("desktop.rail")
        assertTrue(
            "673dp with a 336 dp hinge: the picture ends at the hinge, got right ${picture.right} dp",
            picture.right <= 337f,
        )
        assertTrue(
            "673dp with a 336 dp hinge: the rail starts at or after the hinge, got left ${rail.left} dp",
            rail.left >= 335f,
        )
    }
}

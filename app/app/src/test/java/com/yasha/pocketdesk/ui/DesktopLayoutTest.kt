package com.yasha.pocketdesk.ui

import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The desktop viewer at the three width classes and across hinges: where the picture, the rail and
 * the divider land, so a window that ignores its width class fails by width.
 */
class DesktopLayoutTest {

    @Test
    fun `width classes split at 600 and 840 dp`() {
        assertEquals(WidthClass.Compact, widthClass(412.dp))
        assertEquals(WidthClass.Compact, widthClass(599.dp))
        assertEquals(WidthClass.Medium, widthClass(600.dp))
        assertEquals(WidthClass.Medium, widthClass(839.dp))
        assertEquals(WidthClass.Expanded, widthClass(840.dp))
        assertEquals(WidthClass.Expanded, widthClass(1024.dp))
    }

    @Test
    fun `412dp compact puts the controls under a full width picture`() {
        val layout = desktopLayout(412.dp)
        assertEquals(DesktopPanes.Single, layout.panes)
        assertEquals(0.dp, layout.railWidth)
        assertFalse("412dp: the controls are not beside the picture", layout.controlsBeside)
        assertEquals(412.dp, layout.pictureWidth)
        assertNull("412dp: no divider to draw", layout.boundary)
    }

    @Test
    fun `600dp medium puts a full rail beside the picture`() {
        val layout = desktopLayout(600.dp)
        assertEquals(DesktopPanes.SideBySide, layout.panes)
        assertTrue("600dp: the rail is beside the picture", layout.controlsBeside)
        assertEquals(112.dp, layout.railWidth)
        assertEquals(488.dp, layout.pictureWidth)
        assertEquals(488.dp, layout.boundary)
    }

    @Test
    fun `800dp medium leaves the picture the rest of the window`() {
        val layout = desktopLayout(800.dp)
        assertEquals(DesktopPanes.SideBySide, layout.panes)
        assertEquals(688.dp, layout.pictureWidth)
        assertEquals(688.dp, layout.boundary)
    }

    @Test
    fun `1024dp expanded still gives the rail one column`() {
        val layout = desktopLayout(1024.dp)
        assertEquals(DesktopPanes.SideBySide, layout.panes)
        assertEquals(912.dp, layout.pictureWidth)
    }

    @Test
    fun `673dp with a 336dp fold splits at the hinge`() {
        val layout = desktopLayout(673.dp, 336.dp)
        assertEquals(DesktopPanes.SideBySide, layout.panes)
        assertEquals(336.dp, layout.boundary)
        assertEquals(0.dp, layout.pictureStart)
        assertEquals(336.dp, layout.pictureWidth)
        assertEquals(336.dp, layout.railStart)
        assertEquals(112.dp, layout.railWidth)
        assertTrue(
            "673dp: the picture stops at the hinge, got ${layout.pictureStart + layout.pictureWidth}",
            layout.pictureStart + layout.pictureWidth <= 336.dp,
        )
    }

    @Test
    fun `700dp with a 120dp fold puts the rail on the narrow side`() {
        val layout = desktopLayout(700.dp, 120.dp)
        assertEquals(DesktopPanes.SideBySide, layout.panes)
        assertEquals(120.dp, layout.boundary)
        assertEquals(112.dp, layout.railWidth)
        assertEquals(8.dp, layout.railStart)
        assertEquals(120.dp, layout.pictureStart)
        assertEquals(580.dp, layout.pictureWidth)
    }

    @Test
    fun `700dp with a 600dp fold leaves the rail no room`() {
        val layout = desktopLayout(700.dp, 600.dp)
        assertEquals(DesktopPanes.Confined, layout.panes)
        assertEquals(0.dp, layout.start)
        assertEquals(600.dp, layout.width)
        assertNull("700dp: no divider to cross the fold", layout.boundary)
        assertFalse("700dp: the 100dp side is too narrow for the rail", layout.controlsBeside)
    }

    @Test
    fun `900dp with a 100dp fold confines the viewer to the wide side`() {
        val layout = desktopLayout(900.dp, 100.dp)
        assertEquals(DesktopPanes.Confined, layout.panes)
        assertEquals(100.dp, layout.start)
        assertEquals(800.dp, layout.width)
        assertNull("900dp: no divider to cross the fold", layout.boundary)
        assertFalse("900dp: the 100dp side is too narrow for the rail", layout.controlsBeside)
        assertEquals(800.dp, layout.pictureWidth)
    }
}

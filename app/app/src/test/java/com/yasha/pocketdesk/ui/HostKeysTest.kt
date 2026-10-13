package com.yasha.pocketdesk.ui

import androidx.compose.ui.geometry.Offset
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

/** Each PC OS spells the same intent with its own keys; a wrong entry fires the wrong shortcut. */
class HostKeysTest {

    private fun shortcut(os: String, label: String) = shortcutsFor(os).first { it.first == label }.second

    @Test
    fun `copy and paste use Cmd on a Mac and Ctrl elsewhere`() {
        assertEquals(Combo(0x43, listOf("win")), shortcut("darwin", "Copy"))
        assertEquals(Combo(0x56, listOf("win")), shortcut("darwin", "Paste"))
        assertEquals(Combo(0x43, listOf("ctrl")), shortcut("win32", "Copy"))
        assertEquals(Combo(0x43, listOf("ctrl")), shortcut("linux", "Copy"))
    }

    @Test
    fun `an unknown OS gets the Windows shortcuts`() {
        assertEquals(shortcutsFor("win32"), shortcutsFor(""))
    }

    @Test
    fun `three fingers swiping left moves to the next desktop`() {
        assertEquals(Combo(0x27, listOf("ctrl")), swipeCombo("darwin", Swipe.Left))
        assertEquals(Combo(0x25, listOf("ctrl")), swipeCombo("darwin", Swipe.Right))
        assertEquals(Combo(0x27, listOf("ctrl", "win")), swipeCombo("win32", Swipe.Left))
        assertEquals(Combo(0x27, listOf("ctrl", "alt")), swipeCombo("linux", Swipe.Left))
    }

    @Test
    fun `three fingers up shows every window`() {
        assertEquals(Combo(0x26, listOf("ctrl")), swipeCombo("darwin", Swipe.Up))
        assertEquals(Combo(0x09, listOf("win")), swipeCombo("win32", Swipe.Up))
    }

    @Test
    fun `a three-finger swipe needs a clear direction and distance`() {
        assertNull(threeFingerSwipe(Offset(30f, 10f), minPx = 60f))
        assertEquals(Swipe.Left, threeFingerSwipe(Offset(-90f, 20f), minPx = 60f))
        assertEquals(Swipe.Down, threeFingerSwipe(Offset(10f, 70f), minPx = 60f))
    }

    @Test
    fun `modifier keys carry the PC's own names`() {
        assertEquals("Cmd", modLabel("darwin", "win"))
        assertEquals("Opt", modLabel("darwin", "alt"))
        assertEquals("Super", modLabel("linux", "win"))
        assertEquals("Win", modLabel("win32", "win"))
        assertEquals("Ctrl", modLabel("win32", "ctrl"))
    }
}

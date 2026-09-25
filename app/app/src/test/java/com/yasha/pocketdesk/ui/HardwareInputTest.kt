package com.yasha.pocketdesk.ui

import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** A wrong entry here presses the wrong key on the PC when a keyboard is plugged into the phone. */
class HardwareInputTest {

    @Test
    fun `ranges map onto the matching virtual keys`() {
        assertEquals(0x41, androidKeyToVk(KeyEvent.KEYCODE_A))
        assertEquals(0x5A, androidKeyToVk(KeyEvent.KEYCODE_Z))
        assertEquals(0x30, androidKeyToVk(KeyEvent.KEYCODE_0))
        assertEquals(0x7B, androidKeyToVk(KeyEvent.KEYCODE_F12))
        assertEquals(0x69, androidKeyToVk(KeyEvent.KEYCODE_NUMPAD_9))
    }

    @Test
    fun `editing and modifier keys`() {
        assertEquals(0x08, androidKeyToVk(KeyEvent.KEYCODE_DEL))
        assertEquals(0x2E, androidKeyToVk(KeyEvent.KEYCODE_FORWARD_DEL))
        assertEquals(0x25, androidKeyToVk(KeyEvent.KEYCODE_DPAD_LEFT))
        assertEquals(0xA2, androidKeyToVk(KeyEvent.KEYCODE_CTRL_LEFT))
        assertEquals(0x5B, androidKeyToVk(KeyEvent.KEYCODE_META_LEFT))
    }

    @Test
    fun `phone-only keys are ignored`() {
        assertNull(androidKeyToVk(KeyEvent.KEYCODE_VOLUME_UP))
        assertNull(androidKeyToVk(KeyEvent.KEYCODE_BACK))
    }
}

package com.yasha.pocketdesk.ui

import android.view.KeyEvent

/** Windows virtual key for a physical key on a keyboard attached to the phone; null for keys the PC has no use for. */
internal fun androidKeyToVk(code: Int): Int? = when (code) {
    in KeyEvent.KEYCODE_A..KeyEvent.KEYCODE_Z -> 0x41 + (code - KeyEvent.KEYCODE_A)
    in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9 -> 0x30 + (code - KeyEvent.KEYCODE_0)
    in KeyEvent.KEYCODE_F1..KeyEvent.KEYCODE_F12 -> 0x70 + (code - KeyEvent.KEYCODE_F1)
    in KeyEvent.KEYCODE_NUMPAD_0..KeyEvent.KEYCODE_NUMPAD_9 -> 0x60 + (code - KeyEvent.KEYCODE_NUMPAD_0)
    else -> FIXED_VK[code]
}

private val FIXED_VK = mapOf(
    KeyEvent.KEYCODE_ESCAPE to 0x1B, KeyEvent.KEYCODE_TAB to 0x09, KeyEvent.KEYCODE_ENTER to 0x0D,
    KeyEvent.KEYCODE_NUMPAD_ENTER to 0x0D, KeyEvent.KEYCODE_DEL to 0x08, KeyEvent.KEYCODE_FORWARD_DEL to 0x2E,
    KeyEvent.KEYCODE_SPACE to 0x20, KeyEvent.KEYCODE_INSERT to 0x2D,
    KeyEvent.KEYCODE_MOVE_HOME to 0x24, KeyEvent.KEYCODE_MOVE_END to 0x23,
    KeyEvent.KEYCODE_PAGE_UP to 0x21, KeyEvent.KEYCODE_PAGE_DOWN to 0x22,
    KeyEvent.KEYCODE_DPAD_LEFT to 0x25, KeyEvent.KEYCODE_DPAD_UP to 0x26,
    KeyEvent.KEYCODE_DPAD_RIGHT to 0x27, KeyEvent.KEYCODE_DPAD_DOWN to 0x28,
    KeyEvent.KEYCODE_SHIFT_LEFT to 0xA0, KeyEvent.KEYCODE_SHIFT_RIGHT to 0xA1,
    KeyEvent.KEYCODE_CTRL_LEFT to 0xA2, KeyEvent.KEYCODE_CTRL_RIGHT to 0xA3,
    KeyEvent.KEYCODE_ALT_LEFT to 0xA4, KeyEvent.KEYCODE_ALT_RIGHT to 0xA5,
    KeyEvent.KEYCODE_META_LEFT to 0x5B, KeyEvent.KEYCODE_META_RIGHT to 0x5C,
    KeyEvent.KEYCODE_CAPS_LOCK to 0x14, KeyEvent.KEYCODE_MENU to 0x5D,
    KeyEvent.KEYCODE_SYSRQ to 0x2C, KeyEvent.KEYCODE_BREAK to 0x13, KeyEvent.KEYCODE_SCROLL_LOCK to 0x91,
    KeyEvent.KEYCODE_NUM_LOCK to 0x90,
    KeyEvent.KEYCODE_MINUS to 0xBD, KeyEvent.KEYCODE_EQUALS to 0xBB,
    KeyEvent.KEYCODE_LEFT_BRACKET to 0xDB, KeyEvent.KEYCODE_RIGHT_BRACKET to 0xDD,
    KeyEvent.KEYCODE_BACKSLASH to 0xDC, KeyEvent.KEYCODE_SEMICOLON to 0xBA,
    KeyEvent.KEYCODE_APOSTROPHE to 0xDE, KeyEvent.KEYCODE_COMMA to 0xBC,
    KeyEvent.KEYCODE_PERIOD to 0xBE, KeyEvent.KEYCODE_SLASH to 0xBF, KeyEvent.KEYCODE_GRAVE to 0xC0,
    KeyEvent.KEYCODE_NUMPAD_ADD to 0x6B, KeyEvent.KEYCODE_NUMPAD_SUBTRACT to 0x6D,
    KeyEvent.KEYCODE_NUMPAD_MULTIPLY to 0x6A, KeyEvent.KEYCODE_NUMPAD_DIVIDE to 0x6F,
    KeyEvent.KEYCODE_NUMPAD_DOT to 0x6E,
)

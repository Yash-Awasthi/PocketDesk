package com.yasha.pocketdesk.ui

import org.junit.Assert.assertEquals
import org.junit.Test

/** US-layout virtual keys the desktop keyboard sends; a wrong entry types the wrong character on the PC. */
class DesktopKeyboardTest {

    @Test
    fun `letters and digits are their own unshifted keys`() {
        assertEquals(0x41 to false, CHAR_VK['a'])
        assertEquals(0x5A to false, CHAR_VK['z'])
        assertEquals(0x30 to false, CHAR_VK['0'])
        assertEquals(0x39 to false, CHAR_VK['9'])
    }

    @Test
    fun `shifted digits give the symbols above them`() {
        assertEquals(0x31 to true, CHAR_VK['!'])
        assertEquals(0x32 to true, CHAR_VK['@'])
        assertEquals(0x38 to true, CHAR_VK['*'])
        assertEquals(0x39 to true, CHAR_VK['('])
        assertEquals(0x30 to true, CHAR_VK[')'])
    }

    @Test
    fun `punctuation pairs share an OEM key`() {
        assertEquals(0xDE to false, CHAR_VK['\''])
        assertEquals(0xDE to true, CHAR_VK['"'])
        assertEquals(0xBF to true, CHAR_VK['?'])
        assertEquals(0xDC to true, CHAR_VK['|'])
        assertEquals(0xC0 to true, CHAR_VK['~'])
    }

    @Test
    fun `every key on the symbol and number layers can be sent`() {
        val shown = """!@#$%^&*()-_=+[]{}\|;:'",.<>/?`~""" + "0123456789/*-+.=,()"
        shown.forEach { c -> assert(CHAR_VK.containsKey(c)) { "no key for '$c'" } }
    }
}

package com.yasha.pocketdesk.ui

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

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
    fun `every printable ASCII character the phone keyboard types has a key`() {
        (' '..'~').forEach { c -> assert(CHAR_VK.containsKey(c)) { "no key for '$c'" } }
        assertEquals(0x41 to true, CHAR_VK['A'])
    }

    @Test
    fun `text typed after the sentinel becomes key presses, Shift where the character needs it`() {
        assertEquals(listOf(Stroke.Vk(0x48, true), Stroke.Vk(0x49), Stroke.Vk(0x31, true)), imeStrokes(IME_SENTINEL + "Hi!"))
    }

    @Test
    fun `characters removed from the sentinel are backspaces`() {
        assertEquals(List(2) { Stroke.Vk(VK_BACK) }, imeStrokes(IME_SENTINEL.dropLast(2)))
    }

    @Test
    fun `characters with no US key are typed as text, and a rewritten sentinel types nothing`() {
        assertEquals(listOf(Stroke.Text("é")), imeStrokes(IME_SENTINEL + "é"))
        assertEquals(emptyList<Stroke>(), imeStrokes("x" + IME_SENTINEL))
    }
}

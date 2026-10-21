package com.yasha.pocketdesk.ui

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

/** An upload must never land on a name already in the PC folder, or it replaces that file. */
class FreeNameTest {

    @Test
    fun `an unused name is kept`() {
        assertEquals("a.txt", freeName("a.txt", listOf("b.txt")))
    }

    @Test
    fun `a taken name gets the first free number before the extension`() {
        assertEquals("a (2).txt", freeName("a.txt", listOf("a.txt", "a (1).txt")))
    }

    @Test
    fun `names compare case-insensitively like Windows and macOS folders`() {
        assertEquals("Photo (1).JPG", freeName("Photo.JPG", listOf("photo.jpg")))
    }

    @Test
    fun `a name without an extension or starting with a dot is numbered at the end`() {
        assertEquals("README (1)", freeName("README", listOf("README")))
        assertEquals(".env (1)", freeName(".env", listOf(".env")))
    }
}

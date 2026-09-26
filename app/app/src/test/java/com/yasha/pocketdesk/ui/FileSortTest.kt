package com.yasha.pocketdesk.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class FileSortTest {
    private data class F(val name: String, val dir: Boolean, val date: Long?, val size: Long?)

    private val rows = listOf(
        F("b.txt", false, 30, 5),
        F("Zeta", true, 10, null),
        F("a.txt", false, 20, 50),
        F("alpha", true, 40, null),
    )

    private fun names(by: String, desc: Boolean) =
        sortFiles(rows, { it.dir }, { it.name }, { it.date }, { it.size }, by, desc).map { it.name }

    @Test
    fun `folders stay first and names sort case-insensitively`() {
        assertEquals(listOf("alpha", "Zeta", "a.txt", "b.txt"), names("name", false))
    }

    @Test
    fun `newest and largest first when descending`() {
        assertEquals(listOf("alpha", "Zeta", "b.txt", "a.txt"), names("date", true))
        assertEquals(listOf("alpha", "Zeta", "a.txt", "b.txt"), names("size", true))
    }
}

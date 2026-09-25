package com.yasha.pocketdesk

import org.junit.Assert.assertEquals
import org.junit.Test

/** Pure pieces of the transports: remote paths. */
class TransportTest {

    @Test
    fun `child paths use the separator of the daemon host`() {
        assertEquals("C:\\Users\\me\\a.txt", childPath("C:\\Users\\me", "a.txt"))
        assertEquals("C:\\a.txt", childPath("C:\\", "a.txt"))
        assertEquals("/home/me/a.txt", childPath("/home/me/", "a.txt"))
        assertEquals("/a.txt", childPath("/", "a.txt"))
    }
}

package com.yasha.pocketdesk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WakeTest {

    @Test
    fun `magic packet is six FF bytes then the MAC sixteen times`() {
        val p = Wake.packet("18:3D:2D:38:96:18")!!
        assertEquals(102, p.size)
        assert(p.take(6).all { it == 0xFF.toByte() })
        val mac = byteArrayOf(0x18, 0x3D, 0x2D, 0x38, 0x96.toByte(), 0x18)
        for (i in 0 until 16) assertEquals(mac.toList(), p.slice(6 + i * 6 until 12 + i * 6))
    }

    @Test
    fun `malformed MACs give no packet`() {
        assertNull(Wake.packet("18:3D:2D"))
        assertNull(Wake.packet("zz:3D:2D:38:96:18"))
    }
}

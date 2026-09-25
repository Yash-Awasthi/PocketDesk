package com.yasha.pocketdesk.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Mirrors seiStamp() in daemon/src/desktop_video.js; a mismatch shows a nonsense delay. */
class FrameStampTest {

    private fun stamped(ms: Long): ByteArray {
        val t = ByteArray(7)
        var v = ms
        for (i in 6 downTo 0) { t[i] = (0x80 or (v % 128).toInt()).toByte(); v /= 128 }
        return byteArrayOf(2, 0, 0, 0, 1, 0x06, 0x05, 23) + "RH-latency-stamp".toByteArray() + t + byteArrayOf(0x80.toByte(), 0, 0, 0, 1, 0x41)
    }

    @Test
    fun `reads the daemon send time`() {
        assertEquals(1790000000123L, frameStamp(stamped(1790000000123L)))
    }

    @Test
    fun `frames without a stamp give null`() {
        assertNull(frameStamp(byteArrayOf(2, 0, 0, 0, 1, 0x41, 1, 2, 3)))
    }
}

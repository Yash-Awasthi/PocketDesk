package com.yasha.pocketdesk.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class TouchGesturesTest {

    @Test
    fun `a pinch zooms and a parallel two-finger drag scrolls`() {
        assertEquals(TwoFinger.Zoom, classifyTwoFinger(1.2f, 5f, panWhenZoomed = false))
        assertEquals(TwoFinger.Scroll, classifyTwoFinger(1.01f, 30f, panWhenZoomed = false))
        assertEquals(TwoFinger.Undecided, classifyTwoFinger(1.02f, 4f, panWhenZoomed = false))
    }

    @Test
    fun `zoomed in with direct taps a two-finger drag pans instead of scrolling`() {
        assertEquals(TwoFinger.Zoom, classifyTwoFinger(1.0f, 30f, panWhenZoomed = true))
    }

    @Test
    fun `finger travel becomes wheel notches and keeps the remainder`() {
        assertEquals(2 to 10f, wheelNotches(90f))
        assertEquals(-1 to -5f, wheelNotches(-45f))
        assertEquals(0 to 39f, wheelNotches(39f))
    }
}

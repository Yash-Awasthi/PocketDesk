package com.yasha.pocketdesk.ui

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.unit.IntSize
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TouchGesturesTest {

    @Test
    fun `a pinch that drifts a little is still a pinch`() {
        assertEquals(TwoFinger.Zoom, classifyTwoFinger(spreadChange = 40f, travel = 25f, panWhenZoomed = false))
    }

    @Test
    fun `fingers moving together scroll`() {
        assertEquals(TwoFinger.Scroll, classifyTwoFinger(spreadChange = 3f, travel = 30f, panWhenZoomed = false))
        assertEquals(TwoFinger.Undecided, classifyTwoFinger(spreadChange = 5f, travel = 8f, panWhenZoomed = false))
    }

    @Test
    fun `zoomed in with direct taps a two-finger drag pans instead of scrolling`() {
        assertEquals(TwoFinger.Zoom, classifyTwoFinger(spreadChange = 3f, travel = 30f, panWhenZoomed = true))
    }

    @Test
    fun `a scroll turns into a zoom only on a clear pinch`() {
        assertTrue(scrollBecomesPinch(spreadChange = 80f, travel = 40f))
        assertTrue(!scrollBecomesPinch(spreadChange = 30f, travel = 10f))
    }

    @Test
    fun `finger travel becomes wheel notches and keeps the remainder`() {
        assertEquals(2 to 10f, wheelNotches(90f))
        assertEquals(-1 to -5f, wheelNotches(-45f))
    }

    @Test
    fun `zooming keeps the point under the fingers under the fingers`() {
        val frame = IntSize(1920, 1080)
        val view = IntSize(1080, 700)
        val zoom = 1.5f
        val pan = Offset(30f, -10f)
        val fingers = Offset(300f, 200f)
        // Picture point under the fingers before and after, from the same fitted-and-centred layout.
        fun pictureAt(z: Float, p: Offset, at: Offset): Offset {
            val scale = minOf(view.width.toFloat() / frame.width, view.height.toFloat() / frame.height) * z
            val left = (view.width - frame.width * scale) / 2f + p.x
            val top = (view.height - frame.height * scale) / 2f + p.y
            return Offset((at.x - left) / scale, (at.y - top) / scale)
        }
        val before = pictureAt(zoom, pan, fingers)
        val newPan = panForZoom(frame, view, zoom, pan, 3f, fingers, fingers)
        val after = pictureAt(3f, newPan, fingers)
        assertEquals(before.x, after.x, 0.01f)
        assertEquals(before.y, after.y, 0.01f)
        // Moving the fingers while pinching carries the picture along.
        val moved = pictureAt(3f, panForZoom(frame, view, zoom, pan, 3f, fingers, fingers + Offset(50f, 0f)), fingers + Offset(50f, 0f))
        assertEquals(before.x, moved.x, 0.01f)
    }
}

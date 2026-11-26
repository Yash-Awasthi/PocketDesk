package com.yasha.pocketdesk.ui

import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FoldTest {

    @Test
    fun `no hinges means no fold`() {
        assertNull(foldAtDp(emptyList(), 2f))
    }

    @Test
    fun `a horizontal separating hinge is not a fold`() {
        assertNull(foldAtDp(listOf(Hinge(672, vertical = false, separating = true)), 2f))
    }

    @Test
    fun `a vertical hinge that does not separate is not a fold`() {
        assertNull(foldAtDp(listOf(Hinge(672, vertical = true, separating = false)), 2f))
    }

    @Test
    fun `a horizontal hinge before a vertical one leaves the vertical one as the fold`() {
        val hinges = listOf(
            Hinge(100, vertical = false, separating = true),
            Hinge(672, vertical = true, separating = true),
        )
        assertEquals(336.dp, foldAtDp(hinges, 2f))
    }

    @Test
    fun `a zero or negative density has no fold`() {
        val hinges = listOf(Hinge(672, vertical = true, separating = true))
        assertNull(foldAtDp(hinges, 0f))
        assertNull(foldAtDp(hinges, -1f))
    }

    @Test
    fun `with two vertical hinges the first one wins`() {
        val hinges = listOf(
            Hinge(400, vertical = true, separating = true),
            Hinge(900, vertical = true, separating = true),
        )
        assertEquals(200.dp, foldAtDp(hinges, 2f))
    }
}

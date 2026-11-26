package com.yasha.pocketdesk.ui

import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.window.layout.DisplayFeature
import androidx.window.layout.FoldingFeature

/**
 * A hinge in the terms the layout helpers take: where it crosses the window, whether it splits
 * left from right, and whether content may cross it.
 */
internal data class Hinge(val centerPx: Int, val vertical: Boolean, val separating: Boolean)

/** A foldable hinge, or null for any other display feature (a camera cutout, for one). */
internal fun DisplayFeature.toHinge(): Hinge? = when (this) {
    is FoldingFeature -> Hinge(bounds.centerX(), orientation == FoldingFeature.Orientation.VERTICAL, isSeparating)
    else -> null
}

/**
 * The x of the first separating vertical hinge in dp, or null when the window has none. A
 * horizontal hinge is a laptop fold: the panes still split left and right, so it is ignored.
 */
internal fun foldAtDp(hinges: List<Hinge>, density: Float): Dp? {
    val hinge = hinges.firstOrNull { it.vertical && it.separating } ?: return null
    if (density <= 0f) return null
    return (hinge.centerPx / density).dp
}

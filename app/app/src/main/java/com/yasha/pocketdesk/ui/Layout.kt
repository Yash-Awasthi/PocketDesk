package com.yasha.pocketdesk.ui

import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** Below this width one column is all that fits; at or above it a list and a detail pane both fit. */
internal val TwoPaneMinWidth = 600.dp

/** The narrowest a list or detail pane may get before the screen gives up on two panes. */
internal val MinPaneWidth = 280.dp

/** Every tappable row action clears this in both directions, at every width. */
internal val MinTouchTarget = 48.dp

/** How the sessions screen divides its window. */
enum class SessionPanes {
    /** One column across the whole window. */
    Single,

    /** A list pane, a divider on the boundary, and a detail pane. */
    SideBySide,

    /** A hinge too close to an edge leaves one usable side: one column, starting after it. */
    Confined,
}

/**
 * The geometry of a sessions screen [width] dp wide.
 *
 * [boundary] is the x of the vertical divider, or null when there is none. When a [foldAt] hinge
 * is present the divider sits on the hinge, so no row is ever drawn across the fold.
 */
data class SessionLayout(
    val panes: SessionPanes,
    val start: Dp,
    val listWidth: Dp,
    val boundary: Dp?,
) {
    val twoPane: Boolean get() = panes == SessionPanes.SideBySide
}

fun sessionsLayout(width: Dp, foldAt: Dp? = null): SessionLayout {
    if (foldAt != null) {
        val right = width - foldAt
        if (foldAt >= MinPaneWidth && right >= MinPaneWidth) {
            return SessionLayout(SessionPanes.SideBySide, 0.dp, foldAt, foldAt)
        }
        // The divider would sit in a sliver narrower than a pane, so use the wider side only.
        return if (right > foldAt) SessionLayout(SessionPanes.Confined, foldAt, right, null)
        else SessionLayout(SessionPanes.Confined, 0.dp, foldAt, null)
    }
    if (width < TwoPaneMinWidth) return SessionLayout(SessionPanes.Single, 0.dp, width, null)
    val list = (width * 0.4f).coerceIn(MinPaneWidth, 420.dp)
    return SessionLayout(SessionPanes.SideBySide, 0.dp, list, list)
}
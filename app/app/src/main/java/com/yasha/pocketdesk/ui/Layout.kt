package com.yasha.pocketdesk.ui

import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** Below this width one column is all that fits; at or above it a list and a detail pane both fit. */
internal val TwoPaneMinWidth = 600.dp

/** The narrowest a list or detail pane may get before the screen gives up on two panes. */
internal val MinPaneWidth = 280.dp

/** Every tappable row action clears this in both directions, at every width. */
internal val MinTouchTarget = 48.dp

/** The three window width classes, in dp, that decide how every wide screen arranges itself. */
enum class WidthClass { Compact, Medium, Expanded }

/** 600 dp is where two panes start to fit; 840 dp is where a window holds three. */
internal val ExpandedMinWidth = 840.dp

fun widthClass(width: Dp): WidthClass = when {
    width < TwoPaneMinWidth -> WidthClass.Compact
    width < ExpandedMinWidth -> WidthClass.Medium
    else -> WidthClass.Expanded
}

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
    return when (widthClass(width)) {
        WidthClass.Compact -> SessionLayout(SessionPanes.Single, 0.dp, width, null)
        else -> {
            val list = (width * 0.4f).coerceIn(MinPaneWidth, 420.dp)
            SessionLayout(SessionPanes.SideBySide, 0.dp, list, list)
        }
    }
}

/** At or above this width a tablet can hold the terminal and a key column side by side. */
internal val TerminalTwoPaneMinWidth = 800.dp

/** The narrowest a terminal pane may get: below it the grid has too few columns to read. */
internal val TerminalMinWidth = 320.dp

/** The key column beside a tablet terminal: two 48 dp keys a line with their padding. */
internal val KeyColumnWidth = 112.dp

/** How the terminal screen divides its window. */
enum class TerminalPanes {
    /** One column, the key row under the text. */
    Single,

    /** The terminal and a key column, a divider on the boundary between them. */
    SideBySide,

    /** A hinge too close to an edge leaves one usable side: one column, starting after it. */
    Confined,
}

/**
 * The geometry of a terminal screen [width] dp wide.
 *
 * [start] and [width] are the region the screen draws in; a hinge that leaves a sliver moves the
 * start and shrinks the region so nothing is drawn across the fold. [keysWidth] is 0 when the keys
 * sit under the terminal. [boundary] is the x of the vertical divider, or null when there is none;
 * with a hinge it sits on the fold.
 */
data class TerminalLayout(
    val panes: TerminalPanes,
    val start: Dp,
    val width: Dp,
    val terminalStart: Dp,
    val terminalWidth: Dp,
    val keysStart: Dp,
    val keysWidth: Dp,
    val boundary: Dp?,
) {
    val keysBeside: Boolean get() = keysWidth > 0.dp
}

/** How many 48 dp keys fit on one line of a [keysWidth] column, never fewer than one. */
fun keysPerRow(keysWidth: Dp): Int = (keysWidth / 56.dp).toInt().coerceAtLeast(1)

/**
 * The terminal at [width] dp, or across a [foldAt] hinge. The compact column keeps the key row
 * under the text; a tablet puts the keys beside it; a hinge is never drawn across.
 */
fun terminalLayout(width: Dp, foldAt: Dp? = null): TerminalLayout {
    if (foldAt == null) {
        if (widthClass(width) == WidthClass.Compact || width < TerminalTwoPaneMinWidth) {
            return TerminalLayout(TerminalPanes.Single, 0.dp, width, 0.dp, width, 0.dp, 0.dp, null)
        }
        return TerminalLayout(
            TerminalPanes.SideBySide,
            0.dp, width,
            KeyColumnWidth, width - KeyColumnWidth,
            0.dp, KeyColumnWidth,
            KeyColumnWidth,
        )
    }
    val left = foldAt
    val right = width - foldAt
    // The keys take the wider side and the terminal the other one, so long as both stay usable.
    if (left >= right && left >= KeyColumnWidth && right >= TerminalMinWidth) {
        return TerminalLayout(TerminalPanes.SideBySide, 0.dp, width, foldAt, right, 0.dp, left, foldAt)
    }
    if (right > left && right >= KeyColumnWidth && left >= TerminalMinWidth) {
        return TerminalLayout(TerminalPanes.SideBySide, 0.dp, width, 0.dp, left, foldAt, right, foldAt)
    }
    // The hinge leaves one side too narrow for its own pane: draw on the wider side only.
    return if (right > left) {
        TerminalLayout(TerminalPanes.Confined, foldAt, right, foldAt, right, foldAt, 0.dp, null)
    } else {
        TerminalLayout(TerminalPanes.Confined, 0.dp, left, 0.dp, left, 0.dp, 0.dp, null)
    }
}

/** The control rail beside a tablet desktop: two 48 dp buttons a line with their padding. */
internal val DesktopRailWidth = 112.dp

/** Below this the desktop picture is too narrow to aim at, so the controls go under it. */
internal val DesktopMinPictureWidth = 320.dp

/** How the desktop viewer divides its window. */
enum class DesktopPanes {
    /** One column: picture on top, controls under it. */
    Single,

    /** The picture and a control rail, a divider on the boundary between them. */
    SideBySide,

    /** A hinge too close to an edge leaves one usable side: one column, starting after it. */
    Confined,
}

/**
 * The geometry of a desktop viewer [width] dp wide.
 *
 * [railWidth] is 0 when the controls sit under the picture. With a hinge the divider sits on the
 * fold, so the rail and the picture never straddle it.
 */
data class DesktopLayout(
    val panes: DesktopPanes,
    val start: Dp,
    val width: Dp,
    val pictureStart: Dp,
    val pictureWidth: Dp,
    val railStart: Dp,
    val railWidth: Dp,
    val boundary: Dp?,
) {
    val controlsBeside: Boolean get() = railWidth > 0.dp
}

fun desktopLayout(width: Dp, foldAt: Dp? = null): DesktopLayout {
    if (foldAt == null) {
        if (widthClass(width) == WidthClass.Compact) {
            return DesktopLayout(DesktopPanes.Single, 0.dp, width, 0.dp, width, 0.dp, 0.dp, null)
        }
        val rail = minOf(DesktopRailWidth, width)
        return DesktopLayout(
            DesktopPanes.SideBySide, 0.dp, width,
            0.dp, width - rail,
            width - rail, rail,
            width - rail,
        )
    }
    val left = foldAt
    val right = width - foldAt
    // The rail takes the right pane when the picture still fits on the left.
    if (left >= DesktopMinPictureWidth && right >= DesktopRailWidth) {
        return DesktopLayout(DesktopPanes.SideBySide, 0.dp, width, 0.dp, left, foldAt, DesktopRailWidth, foldAt)
    }
    // The rail takes the left pane when it is wide enough and the picture fits on the right.
    if (right >= DesktopMinPictureWidth && left >= DesktopRailWidth) {
        val rail = minOf(DesktopRailWidth, left)
        return DesktopLayout(DesktopPanes.SideBySide, 0.dp, width, foldAt, right, left - rail, rail, foldAt)
    }
    return if (right > left) {
        DesktopLayout(DesktopPanes.Confined, foldAt, right, foldAt, right, foldAt, 0.dp, null)
    } else {
        DesktopLayout(DesktopPanes.Confined, 0.dp, left, 0.dp, left, 0.dp, 0.dp, null)
    }
}

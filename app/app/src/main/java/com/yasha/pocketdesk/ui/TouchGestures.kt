package com.yasha.pocketdesk.ui

import kotlin.math.abs

/** What a two-finger touch on the desktop does, decided once the fingers have moved a little. */
enum class TwoFinger { Undecided, Scroll, Zoom }

/**
 * [zoomChange] is the pinch factor so far and [travel] how far the fingers' centre moved, in px.
 * [panWhenZoomed] is true when zoomed in with direct taps, where a two-finger drag must pan the view.
 */
internal fun classifyTwoFinger(zoomChange: Float, travel: Float, panWhenZoomed: Boolean): TwoFinger = when {
    abs(zoomChange - 1f) > 0.08f -> TwoFinger.Zoom
    travel > 12f -> if (panWhenZoomed) TwoFinger.Zoom else TwoFinger.Scroll
    else -> TwoFinger.Undecided
}

/** Whole wheel notches in [travel] px of finger movement, one per [stepPx], and the travel left over. */
internal fun wheelNotches(travel: Float, stepPx: Float = 40f): Pair<Int, Float> {
    val n = (travel / stepPx).toInt()
    return n to (travel - n * stepPx)
}

/** A finger held still this long before it moves drags (left button held) instead of moving the pointer. */
internal const val DRAG_HOLD_MS = 400L

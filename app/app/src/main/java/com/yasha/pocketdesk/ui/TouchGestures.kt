package com.yasha.pocketdesk.ui

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.unit.IntSize

/** What a two-finger touch on the desktop does, decided once the fingers have moved a little. */
enum class TwoFinger { Undecided, Scroll, Zoom }

/**
 * [spreadChange] is how far the fingers moved apart or together and [travel] how far their centre
 * moved, both in px since the touch began. A pinch changes the spread more than it moves the centre.
 * [panWhenZoomed] is true when zoomed in with direct taps, where a two-finger drag must pan the view.
 */
internal fun classifyTwoFinger(spreadChange: Float, travel: Float, panWhenZoomed: Boolean): TwoFinger = when {
    maxOf(spreadChange, travel) < 16f -> TwoFinger.Undecided
    spreadChange >= travel * 0.6f -> TwoFinger.Zoom
    panWhenZoomed -> TwoFinger.Zoom
    else -> TwoFinger.Scroll
}

/** A scroll that turns into a clear pinch midway becomes a zoom. */
internal fun scrollBecomesPinch(spreadChange: Float, travel: Float) = spreadChange > 48f && spreadChange > travel * 1.5f

/** Whole wheel notches in [travel] px of finger movement, one per [stepPx], and the travel left over. */
internal fun wheelNotches(travel: Float, stepPx: Float = 40f): Pair<Int, Float> {
    val n = (travel / stepPx).toInt()
    return n to (travel - n * stepPx)
}

/** A finger held still this long before it moves drags (left button held) instead of moving the pointer. */
internal const val DRAG_HOLD_MS = 400L

/**
 * The pan that keeps the picture point that was under [before] (the fingers' centre) under [after]
 * once the zoom changes from [zoom] to [newZoom]. The picture is [frame] fitted and centred in [view].
 */
internal fun panForZoom(frame: IntSize, view: IntSize, zoom: Float, pan: Offset, newZoom: Float, before: Offset, after: Offset): Offset {
    val fit = minOf(view.width.toFloat() / frame.width, view.height.toFloat() / frame.height)
    val scale = fit * zoom
    val newScale = fit * newZoom
    val left = (view.width - frame.width * scale) / 2f + pan.x
    val top = (view.height - frame.height * scale) / 2f + pan.y
    val fx = (before.x - left) / scale
    val fy = (before.y - top) / scale
    return Offset(
        after.x - fx * newScale - (view.width - frame.width * newScale) / 2f,
        after.y - fy * newScale - (view.height - frame.height * newScale) / 2f,
    )
}

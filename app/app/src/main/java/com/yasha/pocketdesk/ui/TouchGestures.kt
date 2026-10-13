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

enum class Swipe { Left, Right, Up, Down }

/** Direction of three fingers whose centre moved [travel] px, or null until it passes [minPx]. */
internal fun threeFingerSwipe(travel: Offset, minPx: Float): Swipe? = when {
    maxOf(kotlin.math.abs(travel.x), kotlin.math.abs(travel.y)) < minPx -> null
    kotlin.math.abs(travel.x) > kotlin.math.abs(travel.y) -> if (travel.x < 0) Swipe.Left else Swipe.Right
    else -> if (travel.y < 0) Swipe.Up else Swipe.Down
}

/**
 * Where the PC pointer sits in a [frame]-sized picture. [fx]/[fy] are fractions of what the picture
 * shows, exact at any capture size; null when the pointer is on a screen the picture does not show.
 * A daemon too old to send them gives picture pixels [x]/[y].
 */
internal fun pointerInFrame(fx: Double?, fy: Double?, x: Int, y: Int, frame: IntSize): Offset? = when {
    fx == null || fy == null -> Offset(x.toFloat(), y.toFloat())
    fx !in 0.0..1.0 || fy !in 0.0..1.0 -> null
    else -> Offset((fx * frame.width).toFloat(), (fy * frame.height).toFloat())
}

/**
 * Manual pointer calibration: where the PC reported its pointer (as a fraction of what the picture
 * should show) once pushed into the top-left and bottom-right corners. Picture fractions are
 * stretched onto that span on the way out, and pointer reports stretched back.
 */
data class Calibration(val left: Double, val top: Double, val right: Double, val bottom: Double) {
    fun toPc(fx: Double, fy: Double) = left + fx * (right - left) to top + fy * (bottom - top)
    fun toPicture(fx: Double, fy: Double) = (fx - left) / (right - left) to (fy - top) / (bottom - top)
    fun encode() = "$left,$top,$right,$bottom"

    companion object {
        /** Null unless the bottom-right corner lies clearly below and right of the top-left one. */
        fun of(topLeft: Pair<Double, Double>, bottomRight: Pair<Double, Double>): Calibration? =
            Calibration(topLeft.first, topLeft.second, bottomRight.first, bottomRight.second)
                .takeIf { it.right - it.left > 0.1 && it.bottom - it.top > 0.1 }

        fun decode(s: String?): Calibration? {
            val v = s?.split(",")?.mapNotNull { it.toDoubleOrNull() }?.takeIf { it.size == 4 } ?: return null
            return of(v[0] to v[1], v[2] to v[3])
        }
    }
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

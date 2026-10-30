// SPDX-License-Identifier: GPL-3.0-or-later
package com.yasha.pocketdesk.ui

import android.view.HapticFeedbackConstants
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.yasha.pocketdesk.WsClient
import kotlinx.coroutines.delay
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.math.hypot
import kotlin.math.roundToInt

/** XInput's button bits, as the PC's virtual Xbox 360 controller takes them. */
internal object XBtn {
    const val UP = 0x0001; const val DOWN = 0x0002; const val LEFT = 0x0004; const val RIGHT = 0x0008
    const val START = 0x0010; const val BACK = 0x0020; const val L3 = 0x0040; const val R3 = 0x0080
    const val LB = 0x0100; const val RB = 0x0200; const val GUIDE = 0x0400
    const val A = 0x1000; const val B = 0x2000; const val X = 0x4000; const val Y = 0x8000
}

/** A stick position (-1..1 each way) as XInput's signed 16 bits; up is positive. */
internal fun stickAxis(v: Float, invert: Boolean = false) = ((if (invert) -v else v).coerceIn(-1f, 1f) * 32767).roundToInt()

/**
 * The phone as an Xbox controller for the PC: games see a real one (through the ViGEmBus driver on
 * the PC). Hold the phone sideways; every control takes its own finger.
 */
@Composable
fun GamepadScreen(ws: WsClient, onClose: () -> Unit) {
    var buttons by remember { mutableIntStateOf(0) }
    var lt by remember { mutableIntStateOf(0) }
    var rt by remember { mutableIntStateOf(0) }
    var left by remember { mutableStateOf(Offset.Zero) }
    var right by remember { mutableStateOf(Offset.Zero) }
    val status by ws.gamepadStatus.collectAsState()
    val view = LocalView.current

    LaunchedEffect(Unit) { ws.sendRaw(buildJsonObject { put("type", "pc_gamepad_status") }.toString()) }
    // Sent at most 125 times a second, and only when something changed.
    LaunchedEffect(Unit) {
        var last = ""
        while (true) {
            val msg = buildJsonObject {
                put("type", "pc_gamepad"); put("pad", 0); put("buttons", buttons); put("lt", lt); put("rt", rt)
                put("lx", stickAxis(left.x)); put("ly", stickAxis(left.y, invert = true))
                put("rx", stickAxis(right.x)); put("ry", stickAxis(right.y, invert = true))
            }.toString()
            if (msg != last) { ws.sendRaw(msg); last = msg }
            delay(8)
        }
    }
    DisposableEffect(Unit) {
        onDispose { ws.sendRaw(buildJsonObject { put("type", "pc_gamepad"); put("pad", 0); put("off", true) }.toString()) }
    }
    fun hold(bit: Int, down: Boolean) {
        buttons = if (down) buttons or bit else buttons and bit.inv()
        if (down) view.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
    }

    Column(Modifier.fillMaxSize().background(Color(0xFF101318)).padding(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onClose) { Text("Close") }
            Text(
                status ?: "Connecting to the PC's controller…",
                color = Color(0xFFB0B8C4), fontSize = 13.sp, modifier = Modifier.weight(1f),
            )
        }
        Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.SpaceBetween) {
            Column {
                PadButton("LT", Modifier.width(96.dp)) { lt = if (it) 255 else 0 }
                Spacer(Modifier.size(6.dp))
                PadButton("LB", Modifier.width(96.dp)) { hold(XBtn.LB, it) }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                PadButton("Back") { hold(XBtn.BACK, it) }
                PadButton("Xbox", round = true) { hold(XBtn.GUIDE, it) }
                PadButton("Start") { hold(XBtn.START, it) }
            }
            Column(horizontalAlignment = Alignment.End) {
                PadButton("RT", Modifier.width(96.dp)) { rt = if (it) 255 else 0 }
                Spacer(Modifier.size(6.dp))
                PadButton("RB", Modifier.width(96.dp)) { hold(XBtn.RB, it) }
            }
        }
        // Sized from the room left, so every control fits on any phone held either way.
        androidx.compose.foundation.layout.BoxWithConstraints(Modifier.fillMaxWidth().weight(1f)) {
            val wide = maxWidth > maxHeight
            val unit = if (wide) minOf(maxHeight * 0.9f, maxWidth / 4.4f) else minOf(maxHeight / 4.4f, maxWidth * 0.45f)
            val pad = @Composable { Dpad(unit) { bit, down -> hold(bit, down) } }
            val face = @Composable { FaceButtons(unit) { bit, down -> hold(bit, down) } }
            val ls = @Composable { Stick(unit, { left = it }) { hold(XBtn.L3, it) } }
            val rs = @Composable { Stick(unit, { right = it }) { hold(XBtn.R3, it) } }
            if (wide) Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) { ls(); pad() }
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) { face(); rs() }
            } else Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.SpaceEvenly) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { ls(); face() }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { pad(); rs() }
            }
        }
    }
}

/** A button that reports press and release, so held buttons stay held. */
@Composable
private fun PadButton(label: String, modifier: Modifier = Modifier, round: Boolean = false, color: Color = Color(0xFF2A313C), side: androidx.compose.ui.unit.Dp? = null, onPress: (Boolean) -> Unit) {
    var down by remember { mutableStateOf(false) }
    Box(
        modifier
            .size(side ?: if (round) 52.dp else 64.dp, side ?: if (round) 52.dp else 44.dp)
            .clip(if (round) CircleShape else RoundedCornerShape(10.dp))
            .background(if (down) MaterialTheme.colorScheme.primary else color)
            .pointerInput(Unit) {
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    down = true; onPress(true)
                    do { val e = awaitPointerEvent() } while (e.changes.any { it.pressed })
                    down = false; onPress(false)
                }
            },
        contentAlignment = Alignment.Center,
    ) { Text(label, color = Color.White, fontSize = 14.sp) }
}

@Composable
private fun FaceButtons(size: androidx.compose.ui.unit.Dp, onPress: (Int, Boolean) -> Unit) {
    Box(Modifier.size(size)) {
        PadButton("Y", side = size * 0.34f, modifier = Modifier.align(Alignment.TopCenter), round = true, color = Color(0xFF8A6D00)) { onPress(XBtn.Y, it) }
        PadButton("X", side = size * 0.34f, modifier = Modifier.align(Alignment.CenterStart), round = true, color = Color(0xFF1F4E8C)) { onPress(XBtn.X, it) }
        PadButton("B", side = size * 0.34f, modifier = Modifier.align(Alignment.CenterEnd), round = true, color = Color(0xFF8C1F1F)) { onPress(XBtn.B, it) }
        PadButton("A", side = size * 0.34f, modifier = Modifier.align(Alignment.BottomCenter), round = true, color = Color(0xFF1F7A35)) { onPress(XBtn.A, it) }
    }
}

@Composable
private fun Dpad(size: androidx.compose.ui.unit.Dp, onPress: (Int, Boolean) -> Unit) {
    Box(Modifier.size(size)) {
        PadButton("▲", side = size * 0.34f, modifier = Modifier.align(Alignment.TopCenter)) { onPress(XBtn.UP, it) }
        PadButton("◀", side = size * 0.34f, modifier = Modifier.align(Alignment.CenterStart)) { onPress(XBtn.LEFT, it) }
        PadButton("▶", side = size * 0.34f, modifier = Modifier.align(Alignment.CenterEnd)) { onPress(XBtn.RIGHT, it) }
        PadButton("▼", side = size * 0.34f, modifier = Modifier.align(Alignment.BottomCenter)) { onPress(XBtn.DOWN, it) }
    }
}

/** A thumbstick: drag from anywhere on it, it springs back on release; a tap without moving clicks it (L3/R3). */
@Composable
private fun Stick(side: androidx.compose.ui.unit.Dp, onMove: (Offset) -> Unit, onClick: (Boolean) -> Unit) {
    var knob by remember { mutableStateOf(Offset.Zero) }
    Box(
        Modifier.size(side).clip(CircleShape).background(Color(0xFF1C222B)).border(2.dp, Color(0xFF39424F), CircleShape)
            .pointerInput(Unit) {
                val radius = size.width / 2f
                awaitEachGesture {
                    val start = awaitFirstDown(requireUnconsumed = false)
                    val center = Offset(radius, radius)
                    var moved = false
                    fun at(p: Offset) {
                        val d = p - center
                        val len = hypot(d.x, d.y)
                        val v = if (len > radius) d / len * radius else d
                        knob = v
                        onMove(Offset(v.x / radius, v.y / radius))
                    }
                    at(start.position)
                    while (true) {
                        val e = awaitPointerEvent()
                        val c = e.changes.firstOrNull { it.id == start.id } ?: break
                        if (!c.pressed) break
                        if (c.positionChange() != Offset.Zero) moved = true
                        at(c.position)
                    }
                    if (!moved) { onClick(true); onClick(false) }
                    knob = Offset.Zero
                    onMove(Offset.Zero)
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.offset { IntOffset(knob.x.roundToInt(), knob.y.roundToInt()) }.size(side * 0.38f).clip(CircleShape).background(Color(0xFF4A5566)))
    }
}

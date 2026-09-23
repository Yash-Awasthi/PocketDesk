package com.yasha.pocketdesk.ui

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Build
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.dp
import com.yasha.pocketdesk.WsClient
import kotlinx.coroutines.delay

/**
 * AnyDesk-style desktop control from the phone: the daemon streams JPEG frames
 * of the full virtual screen (~3 fps, quality 55), the phone draws them and
 * maps gestures to input injection — tap = move+left click, long-press =
 * right click, two-finger tap = middle scroll ticks via the scroll buttons,
 * the text bar types into the desktop, and the key row covers Enter/Esc/Tab/
 * arrows. Coordinates are converted from view space to full virtual-screen
 * pixels with the same letterbox math the browser uses.
 */
@Composable
fun DesktopScreen(ws: WsClient, onClose: () -> Unit) {
    var text by remember { mutableStateOf("") }
    var keyboardVisible by remember { mutableStateOf(false) }
    val desktopError by ws._desktopError.collectAsState()

    // Leaving by any route (bottom bar, system Back) must stop the daemon's capture loop.
    androidx.compose.runtime.DisposableEffect(Unit) {
        ws.desktopSnapshot()
        ws.desktopStart(55)
        onDispose { ws.desktopStop() }
    }

    Column(Modifier.fillMaxSize()) {
        // Header: back, status, keyboard toggle.
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
            verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
            IconButton(onClick = onClose) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
            }
            Text(
                "Desktop" + (if (ws.desktopStreaming) " · live" else ""),
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.weight(1f),
            )
            IconButton(onClick = { keyboardVisible = !keyboardVisible }) {
                Icon(Icons.Filled.Build, contentDescription = "Keyboard")
            }
        }
        if (desktopError.isNotEmpty()) {
            Text(
                desktopError,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(horizontal = 12.dp),
            )
        }

        val frame = ws.desktopFrame
        androidx.compose.foundation.layout.BoxWithConstraints(
            Modifier.fillMaxWidth().weight(1f)
        ) {
            val viewW = maxWidth
            val viewH = maxHeight
            // Density-independent px for gesture math (dp -> px handled via
            // BoxWithConstraints constraints in px below).
            Canvas(
                Modifier
                    .fillMaxSize()
                    .pointerInput(frame?.width, frame?.height) {
                        detectTapGestures(
                            onTap = { off -> toScreen(frame, size.width, size.height, off)?.let { ws.desktopTap(it.first, it.second) } },
                            onLongPress = { off -> toScreen(frame, size.width, size.height, off)?.let { ws.desktopLongTap(it.first, it.second) } },
                            onDoubleTap = { _ -> ws.desktopScroll(false) },
                        )
                    }
                    .pointerInput(frame?.width, frame?.height) {
                        // Drag moves the pointer only; a click per move event fired dozens of clicks.
                        var lastSent = 0L
                        detectDragGestures(
                            onDragStart = { off ->
                                toScreen(frame, size.width, size.height, off)?.let { ws.desktopMove(it.first, it.second) }
                            },
                            onDrag = { change, _ ->
                                val now = System.currentTimeMillis()
                                if (now - lastSent >= 50) {
                                    lastSent = now
                                    toScreen(frame, size.width, size.height, change.position)?.let { ws.desktopMove(it.first, it.second) }
                                }
                            },
                        )
                    },
            ) {
                drawRect(Color(0xFF0D1117))
                val f = frame ?: return@Canvas
                val bytes = Base64.decode(f.base64, Base64.NO_WRAP)
                val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return@Canvas
                val scale = minOf(size.width / f.width.toFloat(), size.height / f.height.toFloat())
                val w = f.width * scale
                val h = f.height * scale
                val ox = (size.width - w) / 2f
                val oy = (size.height - h) / 2f
                drawIntoCanvas { c ->
                    c.nativeCanvas.drawBitmap(bmp, null, android.graphics.RectF(ox, oy, ox + w, oy + h), null)
                }
            }
        }

        // Scroll + common keys row.
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Button(onClick = { ws.desktopScroll(false) }) { Text("▲") }
            Button(onClick = { ws.desktopScroll(true) }) { Text("▼") }
            Button(onClick = { ws.desktopKey(13) }) { Text("⏎") }
            Button(onClick = { ws.desktopKey(27) }) { Text("esc") }
            Button(onClick = { ws.desktopKey(9) }) { Text("⇥") }
            // ctrl+alt+del surrogate: ctrl+s + alt+s + del is not sendable as a
            // chord from here; expose plain Del instead.
            Button(onClick = { ws.desktopKey(46) }) { Text("del") }
        }

        // Text bar: whatever you type is injected as keystrokes on the PC.
        Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                modifier = Modifier.weight(1f),
                placeholder = { Text("Type to PC…") },
                singleLine = true,
            )
            IconButton(onClick = { text = text.dropLast(1); ws.desktopKey(8) }) {
                Icon(Icons.Filled.Delete, contentDescription = "Backspace")
            }
            Button(onClick = {
                if (text.isNotEmpty()) { ws.desktopType(text); text = "" }
            }) { Text("Send") }
        }
    }
}

/** View-space offset -> full virtual-screen pixel coords (letterbox-aware). */
private fun toScreen(
    frame: com.yasha.pocketdesk.DesktopFrame?,
    viewW: Int,
    viewH: Int,
    off: Offset,
): Pair<Int, Int>? {
    val f = frame ?: return null
    val scale = minOf(viewW / f.width.toFloat(), viewH / f.height.toFloat())
    val w = f.width * scale
    val h = f.height * scale
    val ox = (viewW - w) / 2f
    val oy = (viewH - h) / 2f
    val fx = (off.x - ox) / scale
    val fy = (off.y - oy) / scale
    if (fx < 0 || fy < 0 || fx > f.width || fy > f.height) return null
    // Frame pixels -> real desktop pixels: the capture downscales the full
    // virtual screen by the quality factor, and the input helper normalizes
    // against the real virtual screen, so send coords already divided by the
    // frame's own scale — i.e. frame coords as-is when the daemon stamped the
    // post-scale geometry (it does). The server maps desktop_mouse coords
    // through the current frame ratio on the PC side, so forward frame px.
    return Pair(fx.toInt(), fy.toInt())
}

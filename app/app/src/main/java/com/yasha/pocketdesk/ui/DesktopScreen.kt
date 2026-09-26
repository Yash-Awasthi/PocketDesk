package com.yasha.pocketdesk.ui

import android.app.Activity
import android.content.pm.ActivityInfo
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.graphics.SurfaceTexture
import android.view.Surface
import android.view.TextureView
import android.widget.Toast
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import android.util.Base64
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.calculateCentroidSize
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.foundation.focusable
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.PointerType
import androidx.compose.ui.input.pointer.isPrimaryPressed
import androidx.compose.ui.input.pointer.isSecondaryPressed
import androidx.compose.ui.input.pointer.isTertiaryPressed
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.yasha.pocketdesk.DesktopFrame
import com.yasha.pocketdesk.WsClient

/**
 * Remote desktop from the phone. Touchpad mode (default): one finger moves the
 * PC cursor relatively and a tap left-clicks at it; direct mode clicks where you
 * tap. Hold then move drags, a long press right-clicks. Two fingers: pinch zooms,
 * a drag scrolls (pans when zoomed in with direct taps), a quick tap right-clicks.
 * The L/R buttons click at the cursor, Drag holds the left button, Apps launches
 * anything installed on the PC.
 */
@Composable
fun DesktopScreen(
    ws: WsClient,
    onClose: () -> Unit,
    fullscreen: Boolean,
    onFullscreen: (Boolean) -> Unit,
    showKeys: Boolean,
    onShowKeys: (Boolean) -> Unit,
) {
    val desktopError by ws._desktopError.collectAsState()
    // Input mode, quality and the shortcut bar are remembered between sessions.
    val prefs = LocalContext.current.getSharedPreferences("pocketdesk", android.content.Context.MODE_PRIVATE)
    remember { prefs.getString("desktop_preset", null)?.takeIf { it in PRESETS }?.let { ws.desktopPreset = it }; true }
    var touchpad by remember { mutableStateOf(prefs.getBoolean("desktop_touchpad", true)) }
    var shortcuts by remember { mutableStateOf(prefs.getBoolean("desktop_shortcuts", true)) }
    var dragLock by remember { mutableStateOf(false) }
    val haptic = LocalHapticFeedback.current
    var showApps by remember { mutableStateOf(false) }
    var cursor by remember { mutableStateOf<Offset?>(null) }
    var zoom by remember { mutableFloatStateOf(1f) }
    var pan by remember { mutableStateOf(Offset.Zero) }

    var videoSize by remember { mutableStateOf<IntSize?>(null) }
    var boxSize by remember { mutableStateOf(IntSize.Zero) }
    // The stream only runs while the app is visible; ON_START also fires on first attach.
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val obs = LifecycleEventObserver { _, e ->
            if (e == Lifecycle.Event.ON_START) ws.desktopStartVideo()
            if (e == Lifecycle.Event.ON_STOP) ws.desktopStop()
        }
        lifecycle.addObserver(obs)
        onDispose { lifecycle.removeObserver(obs); ws.desktopStop() }
    }
    BackHandler(enabled = fullscreen) { onFullscreen(false) }

    val video = ws.desktopMode == "h264"
    val frame = ws.desktopFrame
    val bitmap = remember(frame, video) {
        if (video) null
        else frame?.let { f -> Base64.decode(f.base64, Base64.NO_WRAP).let { BitmapFactory.decodeByteArray(it, 0, it.size) } }
    }
    val dims = if (video) videoSize else frame?.let { IntSize(it.width, it.height) }
    var rate by remember { mutableStateOf("") }
    LaunchedEffect(video) {
        var b = ws.videoBytes
        var f = ws.videoFrames
        var tick = 0
        while (video) {
            if (tick++ % 2 == 0) ws.desktopPing()
            kotlinx.coroutines.delay(1000)
            rate = "%d fps · %.1f Mb/s".format(ws.videoFrames - f, (ws.videoBytes - b) * 8 / 1e6) +
                (if (ws.videoDelay >= 0) " · ${ws.videoDelay} ms" else "") +
                (if (ws.desktopRtt >= 0) " (ping ${ws.desktopRtt})" else "")
            b = ws.videoBytes
            f = ws.videoFrames
        }
    }
    LaunchedEffect(dims) {
        if (cursor == null && dims != null) cursor = Offset(dims.width / 2f, dims.height / 2f)
    }
    val here = { cursor?.let { Pair(it.x.toInt(), it.y.toInt()) } }
    // The PC pointer wins unless this phone moved it a moment ago, so local drags do not jitter back.
    var lastLocal by remember { mutableStateOf(0L) }
    LaunchedEffect(ws.desktopCursor) {
        val c = ws.desktopCursor ?: return@LaunchedEffect
        if (android.os.SystemClock.uptimeMillis() - lastLocal > 300) cursor = Offset(c.x.toFloat(), c.y.toFloat())
    }

    val transfer = remember { DesktopTransfer() }
    DesktopClipboardSync(ws, transfer)
    val sendFiles = rememberSendFiles(ws, transfer)

    // A keyboard attached to the phone types straight into the PC, with keys held as long as they are held here.
    val keyFocus = remember { FocusRequester() }
    LaunchedEffect(Unit) { keyFocus.requestFocus() }
    Column(Modifier.fillMaxSize().background(Color(0xFF0D1117)).focusRequester(keyFocus).focusable().onKeyEvent { e ->
        val native = e.nativeKeyEvent
        if (native.device?.isVirtual != false) return@onKeyEvent false
        val vk = androidKeyToVk(native.keyCode) ?: return@onKeyEvent false
        when (e.type) {
            KeyEventType.KeyDown -> ws.desktopKeyPress(vk, true)
            KeyEventType.KeyUp -> ws.desktopKeyPress(vk, false)
            else -> return@onKeyEvent false
        }
        true
    }) {
        if (!fullscreen) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onClose) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
                // Only the title and two controls share the row; everything else lives in the menu,
                // so the title never gets squeezed on a narrow phone.
                Column(Modifier.weight(1f)) {
                    Text("Desktop", style = MaterialTheme.typography.titleMedium, maxLines = 1, softWrap = false)
                    Text(
                        listOfNotNull(
                            "● REC".takeIf { ws.desktopRecording && ws.desktopStreaming },
                            "privacy on".takeIf { ws.desktopPrivacy },
                            if (!ws.desktopStreaming) "paused" else rate.takeIf { video && it.isNotEmpty() } ?: "live",
                            ws.route.takeIf { it.isNotEmpty() },
                        ).joinToString(" · "),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                    )
                }
                TextButton(onClick = { ws.desktopViewOnly = !ws.desktopViewOnly; ws.desktopStartVideo() }) {
                    Text(if (ws.desktopViewOnly) "View only" else "Control", maxLines = 1, softWrap = false)
                }
                var more by remember { mutableStateOf(false) }
                var power by remember { mutableStateOf<String?>(null) }
                Box {
                    IconButton(onClick = { more = true }) { Icon(Icons.Filled.MoreVert, contentDescription = "More") }
                    androidx.compose.material3.DropdownMenu(expanded = more, onDismissRequest = { more = false }) {
                        @Composable
                        fun Item(label: String, onClick: () -> Unit) =
                            androidx.compose.material3.DropdownMenuItem(text = { Text(label) }, onClick = { more = false; onClick() })
                        if (video && ws.desktopMonitors.size > 1) Item("Screen: " + ws.desktopMonitors.getOrElse(ws.desktopMonitor) { "1" } + " (switch)") {
                            ws.desktopMonitor = (ws.desktopMonitor + 1) % ws.desktopMonitors.size
                            ws.desktopStartVideo()
                        }
                        if (video) Item("Quality: " + ws.desktopPreset.replaceFirstChar { it.uppercase() } + " (switch)") {
                            ws.desktopPreset = PRESETS[(PRESETS.indexOf(ws.desktopPreset) + 1) % PRESETS.size]
                            prefs.edit().putString("desktop_preset", ws.desktopPreset).apply()
                            ws.desktopStartVideo()
                        }
                        Item(if (touchpad) "Input: Touchpad (switch to direct tap)" else "Input: Direct tap (switch to touchpad)") {
                            touchpad = !touchpad
                            prefs.edit().putBoolean("desktop_touchpad", touchpad).apply()
                        }
                        Item(if (shortcuts) "Hide the shortcut bar" else "Show the shortcut bar") {
                            shortcuts = !shortcuts
                            prefs.edit().putBoolean("desktop_shortcuts", shortcuts).apply()
                        }
                        if (!ws.desktopViewOnly) {
                            Item("Send files to the PC", sendFiles)
                            Item(if (ws.desktopPrivacy) "Turn privacy mode off" else "Privacy mode (blank the PC screen)") {
                                ws.setDesktopPrivacy(!ws.desktopPrivacy)
                            }
                        }
                        androidx.compose.material3.HorizontalDivider()
                        POWER_ACTIONS.forEach { (a, l) -> Item(l) { power = a } }
                    }
                }
                power?.let { PowerConfirmDialog(ws, it) { power = null } }
            }
        }
        DesktopTransferBar(ws, transfer)
        if (ws.desktopNotice.isNotEmpty()) {
            Text(ws.desktopNotice, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 12.dp))
        }
        if (desktopError.isNotEmpty()) {
            Text(desktopError, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(horizontal = 12.dp))
        }

        Box(Modifier.fillMaxWidth().weight(1f).onSizeChanged { boxSize = it }) {
            if (video) {
                AndroidView(
                    factory = { ctx -> videoView(ctx, ws) { videoSize = it } },
                    update = { tv ->
                        val d = videoSize
                        if (d != null && boxSize.width > 0) {
                            val v = Viewport(d, boxSize.width.toFloat(), boxSize.height.toFloat(), zoom, pan)
                            tv.setTransform(Matrix().apply {
                                setScale(d.width * v.scale / boxSize.width, d.height * v.scale / boxSize.height)
                                postTranslate(v.left, v.top)
                            })
                        }
                    },
                    modifier = Modifier.fillMaxSize(),
                )
            }
            Canvas(
                Modifier
                    .fillMaxSize()
                    .pointerInput(dims) {
                        // A mouse on the phone drives the PC pointer directly: hover moves, buttons, wheel.
                        val f = dims ?: return@pointerInput
                        val held = BooleanArray(3)
                        var lastMove = 0L
                        awaitPointerEventScope {
                            while (true) {
                                val ev = awaitPointerEvent(PointerEventPass.Initial)
                                val ch = ev.changes.firstOrNull() ?: continue
                                if (ch.type != PointerType.Mouse) continue
                                if (ev.type == PointerEventType.Scroll) {
                                    ws.desktopWheel((-ch.scrollDelta.y * 120).toInt())
                                } else {
                                    val p = Viewport(f, size.width.toFloat(), size.height.toFloat(), zoom, pan).toFrame(ch.position)
                                    if (p != null) {
                                        cursor = p
                                        val now = booleanArrayOf(ev.buttons.isPrimaryPressed, ev.buttons.isSecondaryPressed, ev.buttons.isTertiaryPressed)
                                        val changed = now.indices.filter { now[it] != held[it] }
                                        lastLocal = ch.uptimeMillis
                                        if (changed.isEmpty() && ch.uptimeMillis - lastMove >= 16) {
                                            lastMove = ch.uptimeMillis
                                            ws.desktopMove(p.x.toInt(), p.y.toInt())
                                        }
                                        for (i in changed) {
                                            held[i] = now[i]
                                            ws.desktopButton(p.x.toInt(), p.y.toInt(), MOUSE_BUTTONS[i], now[i])
                                        }
                                    }
                                }
                                ev.changes.forEach { it.consume() }
                            }
                        }
                    }
                    .pointerInput(dims, touchpad) {
                        val f = dims ?: return@pointerInput
                        awaitEachGesture {
                            val down = awaitFirstDown(requireUnconsumed = false)
                            if (down.type == PointerType.Mouse) return@awaitEachGesture
                            val v = Viewport(f, size.width.toFloat(), size.height.toFloat(), zoom, pan)
                            if (!touchpad) v.toFrame(down.position)?.let { cursor = it }
                            var moved = 0f
                            var multi = false
                            var lastSent = 0L
                            val start = down.uptimeMillis
                            var end = start
                            var two = TwoFinger.Undecided
                            var startSpread = -1f
                            var startCentre = Offset.Zero
                            var scrollLeft = 0f
                            var dragging = false
                            while (true) {
                                val ev = awaitPointerEvent()
                                val pressed = ev.changes.filter { it.pressed }
                                if (pressed.isEmpty()) { end = ev.changes.first().uptimeMillis; break }
                                if (pressed.size >= 2) {
                                    multi = true
                                    val z = ev.calculateZoom()
                                    val p = ev.calculatePan()
                                    val centre = ev.calculateCentroid()
                                    val spread = ev.calculateCentroidSize()
                                    if (startSpread < 0f) { startSpread = spread; startCentre = centre }
                                    val spreadChange = kotlin.math.abs(spread - startSpread)
                                    val travel = (centre - startCentre).getDistance()
                                    if (two == TwoFinger.Undecided) two = classifyTwoFinger(spreadChange, travel, panWhenZoomed = zoom > 1f && !touchpad)
                                    else if (two == TwoFinger.Scroll && scrollBecomesPinch(spreadChange, travel)) two = TwoFinger.Zoom
                                    when (two) {
                                        TwoFinger.Zoom -> {
                                            // Zoom around the fingers, and let the picture follow them as they move.
                                            val newZoom = (zoom * z).coerceIn(1f, 6f)
                                            val view = IntSize(size.width, size.height)
                                            val anchored = panForZoom(f, view, zoom, pan, newZoom, centre - p, centre)
                                            pan = Viewport(f, size.width.toFloat(), size.height.toFloat(), newZoom, anchored).clampedPan()
                                            zoom = newZoom
                                        }
                                        TwoFinger.Scroll -> {
                                            val (notches, rest) = wheelNotches(scrollLeft + p.y)
                                            scrollLeft = rest
                                            if (notches != 0) ws.desktopWheel(notches * 120)
                                        }
                                        TwoFinger.Undecided -> {}
                                    }
                                } else if (!multi) {
                                    val ch = pressed.first()
                                    val delta = ch.positionChange()
                                    val wasStill = moved <= 8f
                                    moved += delta.getDistance()
                                    val vp = Viewport(f, size.width.toFloat(), size.height.toFloat(), zoom, pan)
                                    // Held still first, then moved: press the left button here and drag.
                                    if (wasStill && moved > 8f && ch.uptimeMillis - start >= DRAG_HOLD_MS) {
                                        cursor?.let { c ->
                                            dragging = true
                                            haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                                            ws.desktopPress(c.x.toInt(), c.y.toInt(), true)
                                        }
                                    }
                                    val next = if (touchpad) vp.clampFrame((cursor ?: Offset.Zero) + delta / vp.scale)
                                    else vp.toFrame(ch.position)
                                    if (next != null && moved > 8f) {
                                        cursor = next
                                        lastLocal = ch.uptimeMillis
                                        if (touchpad) pan = vp.follow(next)
                                        if (ch.uptimeMillis - lastSent >= 40) {
                                            lastSent = ch.uptimeMillis
                                            ws.desktopMove(next.x.toInt(), next.y.toInt())
                                        }
                                    }
                                }
                                ev.changes.forEach { it.consume() }
                            }
                            val c = cursor ?: return@awaitEachGesture
                            // A quick two-finger tap that neither scrolled nor zoomed is a right click.
                            if (multi) {
                                if (two == TwoFinger.Undecided && end - start < 300) ws.desktopClick(c.x.toInt(), c.y.toInt(), "right")
                                return@awaitEachGesture
                            }
                            when {
                                dragging -> ws.desktopPress(c.x.toInt(), c.y.toInt(), false)
                                moved > 8f -> ws.desktopMove(c.x.toInt(), c.y.toInt())
                                end - start >= 500 -> ws.desktopClick(c.x.toInt(), c.y.toInt(), "right")
                                else -> ws.desktopClick(c.x.toInt(), c.y.toInt(), "left")
                            }
                        }
                    },
            ) {
                val f = dims ?: return@Canvas
                val v = Viewport(f, size.width, size.height, zoom, pan)
                bitmap?.let { bmp ->
                    drawIntoCanvas { c ->
                        c.nativeCanvas.drawBitmap(bmp, null,
                            android.graphics.RectF(v.left, v.top, v.left + f.width * v.scale, v.top + f.height * v.scale), null)
                    }
                }
                cursor?.let { cur ->
                    val p = Offset(v.left + cur.x * v.scale, v.top + cur.y * v.scale)
                    // A small dot centred on the exact click point: precise, and it hides almost nothing.
                    // The white and dark rings keep it visible on any background.
                    val u = 1.dp.toPx()
                    drawCircle(Color.Black.copy(alpha = 0.6f), radius = 4.5f * u, center = p)
                    drawCircle(Color.White, radius = 3.5f * u, center = p)
                    drawCircle(if (ws.desktopCursor?.shape == "text") Color(0xFF2F81F7) else Color(0xFFE5362E), radius = 2.5f * u, center = p)
                }
            }
            if (fullscreen) {
                TextButton(onClick = { onFullscreen(false) }, modifier = Modifier.align(Alignment.TopEnd)) { Text("Exit ⛶") }
            }
        }

        if (shortcuts && !ws.desktopViewOnly) ShortcutBar(ws)
        // Mouse bar: always visible, in fullscreen too.
        Row(Modifier.fillMaxWidth().height(52.dp).padding(horizontal = 4.dp, vertical = 2.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            val pad = PaddingValues(horizontal = 4.dp)
            FilledTonalButton(onClick = { here()?.let { ws.desktopClick(it.first, it.second, "left") } },
                modifier = Modifier.weight(2f).fillMaxHeight(), contentPadding = pad) { Text("L") }
            FilledTonalButton(onClick = { here()?.let { ws.desktopClick(it.first, it.second, "right") } },
                modifier = Modifier.weight(2f).fillMaxHeight(), contentPadding = pad) { Text("R") }
            val dragButton: @Composable (Modifier) -> Unit = { m ->
                val toggle = {
                    here()?.let { ws.desktopPress(it.first, it.second, !dragLock) }
                    dragLock = !dragLock
                }
                if (dragLock) FilledTonalButton(onClick = toggle, modifier = m, contentPadding = pad) { Text("Drop") }
                else OutlinedButton(onClick = toggle, modifier = m, contentPadding = pad) { Text("Drag") }
            }
            dragButton(Modifier.weight(2f).fillMaxHeight())
            OutlinedButton(onClick = { ws.desktopScroll(false) }, modifier = Modifier.weight(1f).fillMaxHeight(), contentPadding = pad) { Text("▲") }
            OutlinedButton(onClick = { ws.desktopScroll(true) }, modifier = Modifier.weight(1f).fillMaxHeight(), contentPadding = pad) { Text("▼") }
            val keysButton: @Composable (Modifier) -> Unit = { m ->
                if (showKeys) FilledTonalButton(onClick = { onShowKeys(false) }, modifier = m, contentPadding = pad) { Text("⌨") }
                else OutlinedButton(onClick = { onShowKeys(true) }, modifier = m, contentPadding = pad) { Text("⌨") }
            }
            keysButton(Modifier.weight(1f).fillMaxHeight())
            OutlinedButton(onClick = { showApps = true }, modifier = Modifier.weight(1f).fillMaxHeight(), contentPadding = pad) { Text("▦") }
            OutlinedButton(onClick = { onFullscreen(!fullscreen) }, modifier = Modifier.weight(1f).fillMaxHeight(), contentPadding = pad) { Text("⛶") }
        }
        if (showKeys) DesktopKeyboard(ws)
    }

    if (showApps) AppLauncher(ws, onDismiss = { showApps = false })
}

/** TextureView fed by a hardware decoder; each new surface asks the daemon for a fresh keyframe. */
private fun videoView(ctx: android.content.Context, ws: WsClient, onSize: (IntSize) -> Unit) = TextureView(ctx).apply {
    surfaceTextureListener = object : TextureView.SurfaceTextureListener {
        var player: H264Player? = null
        var surface: Surface? = null
        override fun onSurfaceTextureAvailable(st: SurfaceTexture, w: Int, h: Int) {
            val s = Surface(st).also { surface = it }
            val p = H264Player(s, onSize = { vw, vh -> onSize(IntSize(vw, vh)) }, onLost = { ws.desktopStartVideo() }, onShown = ws::frameShown)
            player = p
            ws.videoSink = p::feed
            ws.desktopStartVideo()
        }
        override fun onSurfaceTextureDestroyed(st: SurfaceTexture): Boolean {
            ws.videoSink = null
            player?.release()
            surface?.release()
            return true
        }
        override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, w: Int, h: Int) {}
        override fun onSurfaceTextureUpdated(st: SurfaceTexture) {}
    }
}

private val MOUSE_BUTTONS = arrayOf("left", "right", "middle")

/** Letterboxed, zoomable placement of the frame inside the view. */
private class Viewport(val f: IntSize, val viewW: Float, val viewH: Float, val zoom: Float, val pan: Offset) {
    val scale = minOf(viewW / f.width, viewH / f.height) * zoom
    val left = (viewW - f.width * scale) / 2f + pan.x
    val top = (viewH - f.height * scale) / 2f + pan.y

    fun toFrame(p: Offset): Offset? {
        val fx = (p.x - left) / scale
        val fy = (p.y - top) / scale
        return if (fx < 0 || fy < 0 || fx > f.width || fy > f.height) null else Offset(fx, fy)
    }

    fun clampFrame(p: Offset) = Offset(p.x.coerceIn(0f, f.width - 1f), p.y.coerceIn(0f, f.height - 1f))

    /** Keeps the image covering the view once zoomed past it. */
    fun clampedPan(): Offset {
        val maxX = maxOf(0f, (f.width * scale - viewW) / 2f)
        val maxY = maxOf(0f, (f.height * scale - viewH) / 2f)
        return Offset(pan.x.coerceIn(-maxX, maxX), pan.y.coerceIn(-maxY, maxY))
    }

    /** Pans just enough to keep the cursor on screen while zoomed. */
    fun follow(cur: Offset): Offset {
        val margin = 48f
        val px = left + cur.x * scale
        val py = top + cur.y * scale
        var dx = 0f
        var dy = 0f
        if (px < margin) dx = margin - px else if (px > viewW - margin) dx = viewW - margin - px
        if (py < margin) dy = margin - py else if (py > viewH - margin) dy = viewH - margin - py
        return Viewport(f, viewW, viewH, zoom, pan + Offset(dx, dy)).clampedPan()
    }
}

/**
 * Landscape without system bars while the desktop is fullscreen. Deliberately no
 * undo on dispose: rotating recreates the activity, and an undo there flips it back.
 */
@Composable
fun DesktopFullscreenEffect(fullscreen: Boolean) {
    val view = LocalView.current
    val activity = LocalContext.current as? Activity ?: return
    LaunchedEffect(fullscreen) {
        val controller = WindowCompat.getInsetsController(activity.window, view)
        if (fullscreen) {
            controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            controller.hide(WindowInsetsCompat.Type.systemBars())
            activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        } else {
            controller.show(WindowInsetsCompat.Type.systemBars())
            activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        }
    }
}

private val PRESETS = listOf("saver", "balanced", "quality")
/** Launches any installed PC app (Start Menu, /Applications, .desktop) in the desktop view. */
@Composable
private fun AppLauncher(ws: WsClient, onDismiss: () -> Unit) {
    var q by remember { mutableStateOf("") }
    LaunchedEffect(q) { ws.discoverApps(q, guiOnly = true) }
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } },
        title = { Text("Open on PC") },
        text = {
            Column {
                OutlinedTextField(value = q, onValueChange = { q = it }, singleLine = true,
                    placeholder = { Text("Search apps…") }, modifier = Modifier.fillMaxWidth())
                LazyColumn(Modifier.heightIn(max = 360.dp)) {
                    items(ws.apps.filter { it.isGui }) { app ->
                        Text(app.name, modifier = Modifier.fillMaxWidth()
                            .clickable { ws.guiOpenPath(app.path); onDismiss() }
                            .padding(vertical = 12.dp))
                    }
                }
            }
        },
    )
}

/** Key combinations used all the time, one tap each: (label, virtual key, modifiers). */
private val SHORTCUTS = listOf(
    Triple("Copy", 0x43, listOf("ctrl")),
    Triple("Paste", 0x56, listOf("ctrl")),
    Triple("Undo", 0x5A, listOf("ctrl")),
    Triple("Save", 0x53, listOf("ctrl")),
    Triple("Find", 0x46, listOf("ctrl")),
    Triple("Alt+Tab", 0x09, listOf("alt")),
    Triple("Esc", 0x1B, emptyList()),
    Triple("Enter", 0x0D, emptyList()),
    Triple("Win", 0x5B, emptyList()),
    Triple("Desktop", 0x44, listOf("win")),
    Triple("Task Manager", 0x1B, listOf("ctrl", "shift")),
)

@Composable
private fun ShortcutBar(ws: WsClient) {
    androidx.compose.foundation.lazy.LazyRow(
        Modifier.fillMaxWidth().height(40.dp).padding(horizontal = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        items(SHORTCUTS.size) { i ->
            val (label, vk, mods) = SHORTCUTS[i]
            OutlinedButton(onClick = { ws.desktopKey(vk, mods) }, contentPadding = PaddingValues(horizontal = 10.dp), modifier = Modifier.height(34.dp)) {
                Text(label, style = MaterialTheme.typography.labelMedium, maxLines = 1)
            }
        }
    }
}
